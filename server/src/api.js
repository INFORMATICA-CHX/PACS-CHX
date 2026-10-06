// REST API — serves the frontend worklist, study/series/instance lists,
// config read/write, server control, and DICOM file serving.

import { Router, raw } from 'express';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { activateLicense, deactivateLicense, enforceLicense, licenseStatus } from './license.js';
import { configureServicePassword, confirmServiceTotp, loginService, logoutService, requireServiceSession, serviceAuthStatus, setupServiceTotp, verifyServiceTotp } from './serviceAuth.js';
import { invalidateClinicalSessions, loginClinical, logoutClinical, requireClinicalSession, requireLoopback, verifyClinicalTotp } from './auth.js';
import { appendAudit, beginTotpSetup, changePassword, confirmTotpSetup, contentHash, createUser, deleteUser, listUsers, unlockUser, updateUser, verifyAudit } from './securityStore.js';
import { createEncryptedBackup } from './backup.js';
import { readDicomFileAsync } from './dataProtection.js';
import { buildPixelPayload, pixelCachePathForDicom, readPixelCache, writePixelCache } from './dicomPixelCache.js';
import dcmjs from 'dcmjs';

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;
const pixelResponseCache = new Map();
const thumbnailResponseCache = new Map();
const PIXEL_RESPONSE_CACHE_LIMIT = 200;
const THUMBNAIL_RESPONSE_CACHE_LIMIT = 300;
const MAX_VIEWER_IMAGES = Math.max(1, Math.min(15, Number(process.env.PACS_MAX_VIEWER_IMAGES) || 15));
const INITIAL_VIEWER_PIXELS = Math.max(1, Math.min(MAX_VIEWER_IMAGES, Number(process.env.PACS_INITIAL_VIEWER_PIXELS) || 1));
const WARM_VIEWER_PIXELS = Math.max(INITIAL_VIEWER_PIXELS, Math.min(MAX_VIEWER_IMAGES, Number(process.env.PACS_WARM_VIEWER_PIXELS) || 4));
const PIXEL_WORKER_LIMIT = Math.max(3, Math.min(8, Number(process.env.PACS_PIXEL_WORKERS) || 4));
const pixelJobQueue = [];
const queuedPixelJobs = new Set();
const pixelJobPromises = new Map();
let activePixelJobs = 0;

function listWindowsPrinters() {
  return new Promise((resolvePromise) => {
    if (process.platform !== 'win32') return resolvePromise([]);
    const script = "Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,Default | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) return resolvePromise([]);
      try {
        const parsed = JSON.parse(stdout.trim() || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolvePromise(rows.map((row) => ({
          name: String(row.Name ?? ''),
          driverName: String(row.DriverName ?? ''),
          portName: String(row.PortName ?? ''),
          status: String(row.PrinterStatus ?? ''),
          isDefault: Boolean(row.Default),
        })).filter((row) => row.name));
      } catch {
        resolvePromise([]);
      }
    });
  });
}

function writeWorklistCache(config, db) {
  const cachePath = resolve(dirname(config.dbPath), 'worklist-cache.json');
  const rows = db.prepare(`
    SELECT * FROM modality_worklist
    WHERE status IN ('draft', 'sent', 'failed')
    ORDER BY scheduled_date ASC, scheduled_time ASC, id ASC
    LIMIT 1000
  `).all();
  const devicesById = new Map((config.remoteDevices ?? []).map((device) => [String(device.id), device]));
  const items = rows.map((row) => {
    const targetIds = JSON.parse(row.target_devices || '[]');
    const targetAeTitles = targetIds
      .map((id) => devicesById.get(String(id))?.aeTitle)
      .filter(Boolean)
      .map((aeTitle) => String(aeTitle).trim().toUpperCase());
    return { ...row, target_devices: targetIds, target_ae_titles: targetAeTitles };
  });
  writeFileSync(cachePath, JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2));
  return cachePath;
}

function getCachedPixelResponse(key) {
  const cached = pixelResponseCache.get(key);
  if (!cached) return null;
  pixelResponseCache.delete(key);
  pixelResponseCache.set(key, cached);
  return cached;
}

function setCachedPixelResponse(key, payload) {
  pixelResponseCache.set(key, payload);
  while (pixelResponseCache.size > PIXEL_RESPONSE_CACHE_LIMIT) {
    const oldest = pixelResponseCache.keys().next().value;
    pixelResponseCache.delete(oldest);
  }
}

function getCachedThumbnailResponse(key) {
  const cached = thumbnailResponseCache.get(key);
  if (!cached) return null;
  thumbnailResponseCache.delete(key);
  thumbnailResponseCache.set(key, cached);
  return cached;
}

function setCachedThumbnailResponse(key, payload) {
  thumbnailResponseCache.set(key, payload);
  while (thumbnailResponseCache.size > THUMBNAIL_RESPONSE_CACHE_LIMIT) {
    const oldest = thumbnailResponseCache.keys().next().value;
    thumbnailResponseCache.delete(oldest);
  }
}

function buildThumbnailPayload(payload, maxSide = 180) {
  const width = Number(payload.width) || 0;
  const height = Number(payload.height) || 0;
  const scale = width && height ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const source = Buffer.from(String(payload.pixelDataBase64 ?? ''), 'base64');
  const bitsAllocated = Number(payload.bitsAllocated) || 16;
  const bytesPerSample = bitsAllocated <= 8 ? 1 : 2;
  const samplesPerPixel = Math.max(1, Number(payload.samplesPerPixel) || 1);
  const bytesPerPixel = bytesPerSample * samplesPerPixel;
  const target = Buffer.alloc(nextWidth * nextHeight * bytesPerPixel);
  for (let y = 0; y < nextHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(y * height / nextHeight));
    for (let x = 0; x < nextWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x * width / nextWidth));
      const sourceOffset = (sourceY * width + sourceX) * bytesPerPixel;
      const targetOffset = (y * nextWidth + x) * bytesPerPixel;
      source.copy(target, targetOffset, sourceOffset, sourceOffset + bytesPerPixel);
    }
  }
  return { ...payload, width: nextWidth, height: nextHeight, pixelDataBase64: target.toString('base64'), thumbnail: true };
}

async function loadPixelPayloadForInstance(db, row) {
  const instanceId = String(row.id);
  const cached = getCachedPixelResponse(instanceId);
  if (cached) return cached;

  const diskCached = readPixelCache(row.pixel_cache_path);
  if (diskCached) {
    setCachedPixelResponse(instanceId, diskCached);
    return diskCached;
  }

  const file = await readDicomFileAsync(row.file_path);
  const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const dicomFile = DicomMessage.readFile(arrayBuffer);
  const meta = DicomMetaDictionary.naturalizeDataset(dicomFile.dict);
  const payload = buildPixelPayload(meta);
  const cachePath = row.pixel_cache_path || pixelCachePathForDicom(row.file_path);
  try {
    writePixelCache(cachePath, payload);
    db.prepare('UPDATE instances SET pixel_cache_path = ? WHERE id = ?').run(cachePath, instanceId);
  } catch { /* cache write failure should not block viewing */ }
  setCachedPixelResponse(instanceId, payload);
  return payload;
}

function runPixelQueue() {
  while (activePixelJobs < PIXEL_WORKER_LIMIT && pixelJobQueue.length) {
    const job = pixelJobQueue.shift();
    queuedPixelJobs.delete(job.key);
    activePixelJobs += 1;
    job.run()
      .catch(() => undefined)
      .finally(() => {
        activePixelJobs -= 1;
        runPixelQueue();
      });
  }
}

function enqueuePixelJob(key, run, priority = 'normal') {
  const cached = getCachedPixelResponse(key);
  if (cached) return Promise.resolve(cached);
  if (pixelJobPromises.has(key)) return pixelJobPromises.get(key);
  queuedPixelJobs.add(key);
  const promise = new Promise((resolvePromise, rejectPromise) => {
    const job = {
      key,
      run: async () => {
        try { resolvePromise(await run()); }
        catch (error) { rejectPromise(error); }
      },
    };
    if (priority === 'high') pixelJobQueue.unshift(job);
    else pixelJobQueue.push(job);
  }).finally(() => pixelJobPromises.delete(key));
  pixelJobPromises.set(key, promise);
  runPixelQueue();
  return promise;
}

function enqueuePixelRequest(key, run, priority = 'high') {
  const cached = getCachedPixelResponse(key);
  if (cached) return Promise.resolve(cached);
  return enqueuePixelJob(key, run, priority);
}

function warmStudyPixels(db, studyId, instances) {
  instances.slice(INITIAL_VIEWER_PIXELS, WARM_VIEWER_PIXELS).forEach((instance, index) => {
    enqueuePixelJob(String(instance.id), () => loadPixelPayloadForInstance(db, instance), index < 2 ? 'high' : 'normal')?.catch(() => undefined);
  });
}

function firstNumber(value, fallback) {
  const candidate = Array.isArray(value) ? value[0] : String(value ?? '').split('\\')[0];
  const number = Number(candidate);
  return Number.isFinite(number) ? number : fallback;
}

function firstPixelSpacing(value) {
  if (Array.isArray(value) && value.length) return Number(value[0]) || 1;
  const number = Number(String(value ?? '').split('\\')[0]);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function normalizeWorklistBody(body) {
  const patientId = String(body?.patientId ?? '').trim();
  const patientName = String(body?.patientName ?? '').trim();
  if (!patientId || !patientName) {
    throw new Error('Informe ID e nome do paciente.');
  }
  const accessionNumber = String(body?.accessionNumber ?? '').trim() || `MWL-${Date.now()}`;
  const modality = String(body?.modality ?? '').trim().toUpperCase() || 'CR';
  const scheduledDate = String(body?.scheduledDate ?? '').trim() || new Date().toISOString().slice(0, 10);
  return {
    patientId,
    patientName,
    birthDate: String(body?.birthDate ?? '').trim(),
    sex: String(body?.sex ?? '').trim().toUpperCase(),
    accessionNumber,
    modality,
    requestedProcedure: String(body?.requestedProcedure ?? '').trim(),
    scheduledDate,
    scheduledTime: String(body?.scheduledTime ?? '').trim(),
    referringPhysician: String(body?.referringPhysician ?? '').trim(),
    targetDevices: Array.isArray(body?.targetDevices) ? body.targetDevices.map(String) : [],
  };
}

function downsamplePixelBuffer(source, width, height, nextWidth, nextHeight, bitsAllocated) {
  const bytesPerPixel = bitsAllocated <= 8 ? 1 : 2;
  const target = Buffer.alloc(nextWidth * nextHeight * bytesPerPixel);
  for (let y = 0; y < nextHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor(y * height / nextHeight));
    for (let x = 0; x < nextWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor(x * width / nextWidth));
      const sourceOffset = (sourceY * width + sourceX) * bytesPerPixel;
      const targetOffset = (y * nextWidth + x) * bytesPerPixel;
      if (bytesPerPixel === 1) target[targetOffset] = source[sourceOffset] ?? 0;
      else {
        target[targetOffset] = source[sourceOffset] ?? 0;
        target[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
      }
    }
  }
  return target;
}

export function createApiRouter(scp, db, config, logger, getConfig, setConfig) {
  const router = Router();
  try { writeWorklistCache(config, db); }
  catch (error) { logger.warning(`Worklist DICOM cache nao atualizado: ${error.message}`, 'WORKLIST'); }
  const requireFeature = (feature) => (_req, res, next) => {
    try { enforceLicense({ feature, db, config }); next(); }
    catch (error) { res.status(403).json({ error: error.message, code: 'LICENSE_REQUIRED' }); }
  };
  const clinical = requireClinicalSession(logger, db);
  const roles = (...allowed) => (req, res, next) => req.clinicalUser?.role === 'master' || allowed.includes(req.clinicalUser?.role) ? next() : res.status(403).json({ error: 'Perfil sem permissão para esta operação.' });

  router.post('/api/auth/login', async (req, res) => {
    try { res.json(await loginClinical(req, db, logger)); }
    catch (error) { if (error.message.startsWith('Muitas')) res.setHeader('Retry-After', '900'); res.status(error.message.startsWith('Muitas') ? 429 : 401).json({ error: error.message }); }
  });
  router.post('/api/auth/totp/verify', (req, res) => {
    try { res.json(verifyClinicalTotp(req.body?.preAuthToken, req.body?.code, db, logger)); }
    catch (error) { res.status(401).json({ error: error.message }); }
  });
  router.post('/api/auth/logout', clinical, (req, res) => { logoutClinical(req); res.json({ ok: true }); });
  router.post('/api/auth/totp/setup', clinical, (req, res) => { try { res.json(beginTotpSetup(db, req.clinicalUser.userId)); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.post('/api/auth/totp/confirm', clinical, (req, res) => { try { confirmTotpSetup(db, req.clinicalUser.userId, req.body?.code); appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'TOTP_ENABLED', resource: 'USER' }); res.json({ ok: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.get('/api/auth/session', clinical, (req, res) => res.json({ ok: true, user: req.clinicalUser.user, displayName: req.clinicalUser.displayName, role: req.clinicalUser.role }));
  router.post('/api/auth/change-password', clinical, (req, res) => {
    try { changePassword(db, req.clinicalUser.userId, String(req.body?.password ?? '')); invalidateClinicalSessions(req.clinicalUser.userId, (req.get('Authorization') ?? '').replace(/^Bearer /, '')); appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'PASSWORD_CHANGED', resource: 'USER' }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get('/api/users', clinical, roles('admin', 'maintenance'), (req, res) => res.json(listUsers(db)));
  router.post('/api/users', clinical, roles('admin'), (req, res) => { try { const id = createUser(db, req.body ?? {}); res.status(201).json({ id }); } catch (error) { res.status(400).json({ error: error.message }); } });

  router.get('/api/license', requireLoopback, (_req, res) => {
    const { key: _key, ...safeStatus } = licenseStatus();
    res.json(safeStatus);
  });
  router.post('/api/license/activate', requireLoopback, (req, res) => {
    try {
      const state = activateLicense(req.body?.key);
      logger.success(`Licenca ativada para ${state.license.customer}`, 'LICENSE');
      const { key: _key, ...safeState } = state;
      res.json(safeState);
    }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/api/license', requireLoopback, (_req, res) => { logger.warning('Licenca desativada', 'LICENSE'); res.json(deactivateLicense()); });
  router.get('/api/service/status', requireLoopback, (_req, res) => res.json(serviceAuthStatus()));
  router.post('/api/service/setup', requireLoopback, (req, res) => {
    try { const session = configureServicePassword(req.body?.password); logger.success('Senha de servico configurada', 'SECURITY'); res.json(session); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/api/service/login', requireLoopback, (req, res) => {
    try { const session = loginService(req.body?.password); logger.success('Login de manutencao autorizado', 'SECURITY'); res.json(session); }
    catch (error) { logger.warning('Tentativa de login de manutencao recusada', 'SECURITY'); res.status(401).json({ error: error.message }); }
  });
  router.post('/api/service/totp/verify', requireLoopback, (req, res) => { try { res.json(verifyServiceTotp(req.body?.preAuthToken, req.body?.code)); } catch (error) { res.status(401).json({ error: error.message }); } });
  router.post('/api/service/logout', requireLoopback, requireServiceSession, (req, res) => { logoutService(req); res.json({ ok: true }); });
  const serviceAdmin = [requireLoopback, requireServiceSession];
  router.post('/api/service/totp/setup', ...serviceAdmin, (_req, res) => { try { res.json(setupServiceTotp()); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.post('/api/service/totp/confirm', ...serviceAdmin, (req, res) => { try { confirmServiceTotp(req.body?.code); appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'TOTP_ENABLED', resource: 'SERVICE_AUTH' }); res.json({ ok: true }); } catch (error) { res.status(400).json({ error: error.message }); } });
  router.get('/api/service/users', ...serviceAdmin, (_req, res) => res.json(listUsers(db)));
  router.post('/api/service/users', ...serviceAdmin, (req, res) => {
    try { const id = createUser(db, req.body ?? {}); appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'USER_CREATED', resource: `USER:${id}`, details: { username: req.body?.username, role: req.body?.role } }); res.status(201).json({ id }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put('/api/service/users/:id', ...serviceAdmin, (req, res) => {
    try { updateUser(db, Number(req.params.id), req.body ?? {}); invalidateClinicalSessions(Number(req.params.id)); appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'USER_UPDATED', resource: `USER:${req.params.id}`, details: { role: req.body?.role, active: Boolean(req.body?.active) } }); res.json({ ok: true, user: db.prepare('SELECT id, username, display_name, role, active, must_change_password, totp_enabled, locked_until, created_at, updated_at FROM users WHERE id=?').get(Number(req.params.id)) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/api/service/users/:id/password', ...serviceAdmin, (req, res) => {
    try { changePassword(db, Number(req.params.id), String(req.body?.password ?? ''), false); invalidateClinicalSessions(Number(req.params.id)); appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'PASSWORD_RESET', resource: `USER:${req.params.id}` }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/api/service/users/:id/unlock', ...serviceAdmin, (req, res) => {
    try { unlockUser(db, Number(req.params.id)); appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'USER_UNLOCKED', resource: `USER:${req.params.id}` }); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete('/api/service/users/:id', ...serviceAdmin, (req, res) => {
    try { const deleted = deleteUser(db, Number(req.params.id)); invalidateClinicalSessions(Number(req.params.id)); appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'USER_DELETED', resource: `USER:${req.params.id}`, details: deleted }); res.json({ ok: true, deleted }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get('/api/service/audit', ...serviceAdmin, (_req, res) => res.json(db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 500').all()));
  router.get('/api/service/audit/verify', ...serviceAdmin, (_req, res) => res.json(verifyAudit(db)));

  // ---- Patients ----
  const DEFAULT_PATIENTS_LIMIT = 1000;
  router.get('/api/patients', clinical, requireFeature('web-viewer'), (req, res) => {
    let sql = `
      SELECT p.*, COUNT(s.id) as study_count
      FROM patients p
      LEFT JOIN studies s ON s.patient_id = p.id
      GROUP BY p.id
      ORDER BY p.patient_name
    `;
    const params = [];
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_PATIENTS_LIMIT;
    if (Number.isFinite(limit) && limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    res.json(db.prepare(sql).all(...params));
  });

  // ---- Studies (worklist) ----
  // limit/offset are optional so older frontend builds that don't pass them
  // keep working unchanged; DEFAULT_STUDIES_LIMIT just protects the server
  // from ever having to serialize/send the full history table on a single
  // request as the archive grows. Pass ?limit=0 to explicitly request
  // everything (e.g. for the maintenance/export screens).
  const DEFAULT_STUDIES_LIMIT = 500;
  router.get('/api/studies', clinical, requireFeature('web-viewer'), (req, res) => {
    const { search, modality, date, aeTitle } = req.query;
    let sql = `
      SELECT s.*, p.patient_id, p.patient_name, p.birth_date, p.sex,
        COALESCE((SELECT body_part_examined FROM series sr WHERE sr.study_id = s.id ORDER BY sr.series_number LIMIT 1), '') AS body_part_examined
      FROM studies s
      JOIN patients p ON p.id = s.patient_id
      WHERE 1=1
    `;
    const params = [];
    if (modality && modality !== 'ALL') {
      sql += ' AND s.modality = ?';
      params.push(modality);
    }
    if (aeTitle && aeTitle !== 'ALL') {
      sql += ' AND s.source_ae_title = ?';
      params.push(aeTitle);
    }
    if (date) {
      sql += ' AND s.study_date = ?';
      params.push(date);
    }
    if (search) {
      sql += ' AND (p.patient_name LIKE ? OR p.patient_id LIKE ? OR s.study_description LIKE ? OR s.accession_number LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    sql += ' ORDER BY s.study_date DESC, s.study_time DESC';

    const limit = req.query.limit !== undefined ? Number(req.query.limit) : DEFAULT_STUDIES_LIMIT;
    if (Number.isFinite(limit) && limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
      const offset = Number(req.query.offset);
      if (Number.isFinite(offset) && offset > 0) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/api/studies/revision', clinical, requireFeature('web-viewer'), (_req, res) => {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS study_count,
        COALESCE(MAX(id), 0) AS last_study_id,
        COALESCE(MAX(received_at), '') AS last_received_at
      FROM studies
    `).get();
    res.json({
      studyCount: Number(row?.study_count ?? 0),
      lastStudyId: Number(row?.last_study_id ?? 0),
      lastReceivedAt: String(row?.last_received_at ?? ''),
    });
  });

  router.get('/api/studies/:studyId', clinical, requireFeature('web-viewer'), (req, res) => {
    const row = db.prepare(`
      SELECT s.*, p.patient_id, p.patient_name, p.birth_date, p.sex,
        COALESCE((SELECT body_part_examined FROM series sr WHERE sr.study_id = s.id ORDER BY sr.series_number LIMIT 1), '') AS body_part_examined
      FROM studies s
      JOIN patients p ON p.id = s.patient_id
      WHERE s.id = ?
    `).get(req.params.studyId);
    if (!row) return res.status(404).json({ error: 'Estudo nao encontrado.' });
    res.json(row);
  });

  // ---- Series by study ----
  router.get('/api/studies/:studyId/series', clinical, requireFeature('web-viewer'), (req, res) => {
    const rows = db.prepare('SELECT * FROM series WHERE study_id = ? ORDER BY series_number').all(req.params.studyId);
    res.json(rows);
  });

  router.get('/api/studies/:studyId/viewer-data', clinical, requireFeature('web-viewer'), async (req, res) => {
    const series = db.prepare('SELECT * FROM series WHERE study_id = ? ORDER BY series_number').all(req.params.studyId);
    const allInstances = series.length
      ? db.prepare(`
          SELECT i.id, i.series_id, i.instance_number, i.file_path, i.pixel_cache_path, sr.series_number
          FROM instances i
          JOIN series sr ON sr.id = i.series_id
          WHERE sr.study_id = ?
          ORDER BY sr.series_number, i.instance_number
        `).all(req.params.studyId)
      : [];
    const instances = allInstances.slice(0, MAX_VIEWER_IMAGES);
    const visibleCountBySeries = instances.reduce((counts, instance) => {
      counts[String(instance.series_id)] = (counts[String(instance.series_id)] ?? 0) + 1;
      return counts;
    }, {});
    const visibleSeries = series
      .filter((item) => visibleCountBySeries[String(item.id)])
      .map((item) => ({ ...item, image_count: visibleCountBySeries[String(item.id)] ?? item.image_count }));
    const initialPixels = {};
    await Promise.all(instances.slice(0, INITIAL_VIEWER_PIXELS).map(async (instance) => {
      try { initialPixels[String(instance.id)] = await enqueuePixelRequest(String(instance.id), () => loadPixelPayloadForInstance(db, instance), 'high'); }
      catch { /* unsupported instance should not block the viewer data */ }
    }));
    warmStudyPixels(db, req.params.studyId, instances);
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.json({ series: visibleSeries, instances: instances.map(({ file_path, pixel_cache_path, ...instance }) => instance), initialPixels, maxImages: MAX_VIEWER_IMAGES, totalImages: allInstances.length });
  });

  router.get('/api/series', clinical, requireFeature('web-viewer'), (_req, res) => {
    res.json(db.prepare('SELECT * FROM series ORDER BY study_id, series_number').all());
  });

  // ---- Instances by series ----
  router.get('/api/series/:seriesId/instances', clinical, requireFeature('web-viewer'), (req, res) => {
    const rows = db.prepare('SELECT * FROM instances WHERE series_id = ? ORDER BY instance_number').all(req.params.seriesId);
    res.json(rows);
  });

  router.get('/api/worklist', clinical, requireFeature('worklist'), (_req, res) => {
    const rows = db.prepare('SELECT * FROM modality_worklist ORDER BY scheduled_date DESC, scheduled_time DESC, id DESC LIMIT 500').all();
    res.json(rows.map((row) => ({
      ...row,
      target_devices: JSON.parse(row.target_devices || '[]'),
      sent_devices: JSON.parse(row.sent_devices || '[]'),
    })));
  });

  router.post('/api/worklist', clinical, requireFeature('worklist'), async (req, res) => {
    try {
      const item = normalizeWorklistBody(req.body);
      const requestedTargets = item.targetDevices.length
        ? item.targetDevices
        : (config.remoteDevices ?? []).filter((device) => device.enabled && device.kind !== 'printer' && device.forWorklist !== false).map((device) => String(device.id));
      const sent = [];
      const result = db.prepare(`
        INSERT INTO modality_worklist (
          patient_id, patient_name, birth_date, sex, accession_number, modality,
          requested_procedure, scheduled_date, scheduled_time, referring_physician,
          target_devices, sent_devices, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.patientId,
        item.patientName,
        item.birthDate,
        item.sex,
        item.accessionNumber,
        item.modality,
        item.requestedProcedure,
        item.scheduledDate,
        item.scheduledTime,
        item.referringPhysician,
        JSON.stringify(requestedTargets),
        JSON.stringify(sent),
        'sent',
      );
      appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'WORKLIST_CREATED', resource: `MWL:${result.lastInsertRowid}`, details: { ...item, targetDevices: requestedTargets, mode: 'dicom-cfind' }, ip: req.ip });
      writeWorklistCache(config, db);
      res.status(201).json({ id: Number(result.lastInsertRowid), ...item, targetDevices: requestedTargets, status: 'sent', sentDevices: sent });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/api/worklist/:id/send', clinical, requireFeature('worklist'), async (req, res) => {
    const row = db.prepare('SELECT * FROM modality_worklist WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Item de Worklist nao encontrado.' });
    const requestedTargets = Array.isArray(req.body?.targetDevices) ? req.body.targetDevices.map(String) : JSON.parse(row.target_devices || '[]');
    const devices = (config.remoteDevices ?? []).filter((device) => device.enabled && device.kind !== 'printer' && device.forWorklist !== false && requestedTargets.includes(String(device.id)));
    if (!devices.length) return res.status(400).json({ error: 'Selecione ao menos um equipamento ativo.' });
    const sent = [];
    for (const device of devices) {
      const result = await scp.testEcho(device);
      sent.push({ id: device.id, aeTitle: device.aeTitle, ip: device.ip, port: device.port, success: Boolean(result.success), message: result.message, at: new Date().toISOString() });
    }
    const ok = sent.some((item) => item.success);
    db.prepare("UPDATE modality_worklist SET target_devices=?, sent_devices=?, status=?, updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(requestedTargets), JSON.stringify(sent), ok ? 'sent' : 'failed', req.params.id);
    appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'WORKLIST_SENT', resource: `MWL:${req.params.id}`, details: { sent }, ip: req.ip });
    writeWorklistCache(config, db);
    res.json({ ok, sent });
  });

  router.delete('/api/worklist/:id', clinical, requireFeature('worklist'), (req, res) => {
    const row = db.prepare('SELECT * FROM modality_worklist WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Item de Worklist nao encontrado.' });
    db.prepare('DELETE FROM modality_worklist WHERE id = ?').run(req.params.id);
    appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'WORKLIST_DELETED', resource: `MWL:${req.params.id}`, details: { patientId: row.patient_id, patientName: row.patient_name, accessionNumber: row.accession_number }, ip: req.ip });
    writeWorklistCache(config, db);
    res.json({ ok: true });
  });

  // ---- Serve a DICOM file (for the viewer) ----
  // Returns the raw .dcm bytes. The frontend viewer (Cornerstone.js) parses it.
  router.get('/api/instances/:instanceId/file', clinical, requireFeature('web-viewer'), async (req, res) => {
    const row = db.prepare('SELECT file_path FROM instances WHERE id = ?').get(req.params.instanceId);
    if (!row) return res.status(404).json({ error: 'Instance not found' });
    try {
      const buffer = await readDicomFileAsync(row.file_path);
      // A given instance's bytes never change once received, so once a
      // workstation has opened a study it can be reopened straight from the
      // browser cache — no round trip to the server at all — instead of
      // re-decrypting and re-sending the file every time.
      res.setHeader('Content-Type', 'application/dicom');
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      res.send(buffer);
    } catch {
      res.status(404).json({ error: 'File not found on disk' });
    }
  });

  router.get('/api/instances/:instanceId/pixels', clinical, requireFeature('web-viewer'), async (req, res) => {
    const cached = getCachedPixelResponse(req.params.instanceId);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      return res.json(cached);
    }
    const row = db.prepare('SELECT id, file_path, pixel_cache_path FROM instances WHERE id = ?').get(req.params.instanceId);
    if (!row) return res.status(404).json({ error: 'Instance not found' });
    try {
      const payload = await enqueuePixelRequest(String(row.id), () => loadPixelPayloadForInstance(db, row), 'high');
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/instances/:instanceId/thumbnail', clinical, requireFeature('web-viewer'), async (req, res) => {
    const cached = getCachedThumbnailResponse(req.params.instanceId);
    if (cached) {
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      return res.json(cached);
    }
    const row = db.prepare('SELECT id, file_path, pixel_cache_path FROM instances WHERE id = ?').get(req.params.instanceId);
    if (!row) return res.status(404).json({ error: 'Instance not found' });
    try {
      const payload = await enqueuePixelRequest(String(row.id), () => loadPixelPayloadForInstance(db, row), 'normal');
      const thumbnail = buildThumbnailPayload(payload);
      setCachedThumbnailResponse(req.params.instanceId, thumbnail);
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      res.json(thumbnail);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ---- Reports: versioned and signed server-side ----
  router.get('/api/reports', clinical, (req, res) => {
    res.json(db.prepare(`SELECT r.*, rv.content, rv.content_hash, u.display_name AS author_name, su.display_name AS signer_name
      FROM reports r LEFT JOIN report_versions rv ON rv.report_id=r.id AND rv.version=r.current_version
      LEFT JOIN users u ON u.id=rv.author_id LEFT JOIN users su ON su.id=r.signed_by ORDER BY r.updated_at DESC`).all());
  });
  router.get('/api/reports/statuses', clinical, (req, res) => {
    res.json(db.prepare('SELECT study_id, status, updated_at FROM reports ORDER BY updated_at DESC').all());
  });
  router.get('/api/reports/study/:studyId', clinical, (req, res) => {
    const row = db.prepare(`SELECT r.*, rv.content, rv.content_hash, u.display_name AS author_name, su.display_name AS signer_name
      FROM reports r LEFT JOIN report_versions rv ON rv.report_id=r.id AND rv.version=r.current_version
      LEFT JOIN users u ON u.id=rv.author_id LEFT JOIN users su ON su.id=r.signed_by WHERE r.study_id=?`).get(req.params.studyId);
    res.json(row ?? null);
  });
  router.get('/api/report-templates', clinical, roles('radiologist'), (_req, res) => {
    res.json(db.prepare('SELECT id, modality, name, content, created_at, updated_at FROM report_templates ORDER BY modality').all());
  });
  router.put('/api/report-templates/:modality', clinical, roles('radiologist'), (req, res) => {
    const modality = String(req.params.modality ?? '').trim().toUpperCase();
    const name = String(req.body?.name ?? '').trim();
    const content = String(req.body?.content ?? '').trim();
    if (!/^[A-Z0-9]{2,8}$/.test(modality)) return res.status(400).json({ error: 'Modalidade inválida.' });
    if (!name || !content) return res.status(400).json({ error: 'Informe nome e conteúdo do modelo.' });
    db.prepare(`INSERT INTO report_templates (modality, name, content, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(modality) DO UPDATE SET name=excluded.name, content=excluded.content, updated_by=excluded.updated_by, updated_at=datetime('now')`)
      .run(modality, name, content, req.clinicalUser.userId);
    appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'REPORT_TEMPLATE_SAVED', resource: `REPORT_TEMPLATE:${modality}`, details: { name }, ip: req.ip });
    res.json(db.prepare('SELECT id, modality, name, content, created_at, updated_at FROM report_templates WHERE modality=?').get(modality));
  });

  router.post('/api/reports/study/:studyId', clinical, roles('radiologist'), (req, res) => {
    const content = String(req.body?.content ?? '').trim();
    const status = req.body?.status === 'signed' ? 'signed' : 'draft';
    if (!content) return res.status(400).json({ error: 'O laudo não pode ficar vazio.' });
    const study = db.prepare('SELECT id FROM studies WHERE id=?').get(req.params.studyId);
    if (!study) return res.status(404).json({ error: 'Estudo não encontrado.' });
    db.exec('BEGIN');
    try {
      let report = db.prepare('SELECT * FROM reports WHERE study_id=?').get(study.id);
      if (report?.status === 'signed') throw new Error('Laudo assinado não pode ser sobrescrito. Crie uma retificação.');
      if (!report) { const result = db.prepare('INSERT INTO reports (study_id, status, created_by) VALUES (?, ?, ?)').run(study.id, status, req.clinicalUser.userId); report = { id: result.lastInsertRowid, current_version: 0 }; }
      const version = Number(report.current_version) + 1;
      db.prepare('INSERT INTO report_versions (report_id, version, content, status, author_id, content_hash) VALUES (?, ?, ?, ?, ?, ?)').run(report.id, version, content, status, req.clinicalUser.userId, contentHash(content));
      db.prepare("UPDATE reports SET status=?, current_version=?, signed_by=?, signed_at=?, updated_at=datetime('now') WHERE id=?")
        .run(status, version, status === 'signed' ? req.clinicalUser.userId : null, status === 'signed' ? new Date().toISOString() : null, report.id);
      appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: status === 'signed' ? 'REPORT_SIGNED' : 'REPORT_SAVED', resource: `STUDY:${study.id}`, details: { version, hash: contentHash(content) }, ip: req.ip });
      db.exec('COMMIT'); res.json({ ok: true, reportId: Number(report.id), version, status });
    } catch (error) { db.exec('ROLLBACK'); res.status(400).json({ error: error.message }); }
  });

  // ---- Printing queue ----
  router.get('/api/print-jobs', clinical, (req, res) => {
    res.json(db.prepare(`SELECT pj.*, s.accession_number, s.study_description, s.modality, p.patient_id, p.patient_name
      FROM print_jobs pj JOIN studies s ON s.id=pj.study_id JOIN patients p ON p.id=s.patient_id ORDER BY pj.requested_at DESC`).all());
  });
  router.get('/api/local-printers', clinical, async (_req, res) => {
    res.json(await listWindowsPrinters());
  });
  router.post('/api/print-jobs', clinical, (req, res) => {
    const result = db.prepare('INSERT INTO print_jobs (study_id, requested_by, copies, printer_name) VALUES (?, ?, ?, ?)').run(req.body?.studyId, req.clinicalUser.userId, Math.max(1, Number(req.body?.copies) || 1), String(req.body?.printerName ?? 'Padrão do Windows'));
    res.status(201).json({ id: Number(result.lastInsertRowid), status: 'queued' });
  });
  router.post('/api/print-jobs/:id/send', clinical, async (req, res) => {
    const job = db.prepare('SELECT * FROM print_jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job de impressao nao encontrado.' });
    const devices = getConfig().remoteDevices ?? [];
    const requestedId = req.body?.deviceId != null ? String(req.body.deviceId) : '';
    const device = devices.find((item) => item.enabled && item.kind === 'printer' && (String(item.id) === requestedId || (!requestedId && String(item.aeTitle) === String(job.printer_name))));
    if (!device) return res.status(400).json({ error: 'Selecione uma impressora DICOM ativa na tela de impressao.' });

    // O preview de impressao deixa o usuario ajustar brilho/contraste, girar e
    // marcar D/E/texto por imagem; sem isso, o filme sai identico ao DICOM
    // original em vez do que foi visualizado/ajustado na tela de impressao.
    const printStateCells = Array.isArray(req.body?.printState?.cells) ? req.body.printState.cells : [];
    const footerLines = Array.isArray(req.body?.printState?.footerLines)
      ? req.body.printState.footerLines.map((line) => String(line ?? '').slice(0, 160)).filter(Boolean)
      : [];
    let files = [];
    let overrides = [];
    if (printStateCells.length) {
      const instanceRows = db.prepare(`
        SELECT i.id, i.file_path
        FROM instances i
        JOIN series sr ON sr.id=i.series_id
        WHERE sr.study_id=?
      `).all(job.study_id);
      const fileByInstanceId = new Map(instanceRows.map((row) => [String(row.id), row.file_path]));
      const orderedCells = [...printStateCells].sort((a, b) => Number(a?.cell) - Number(b?.cell));
      for (const cell of orderedCells) {
        const filePath = fileByInstanceId.get(String(cell?.instanceId));
        if (!filePath || !existsSync(filePath)) continue;
        const viewport = cell?.viewport ?? {};
        const windowCenter = Number(viewport.windowCenter);
        const windowWidth = Number(viewport.windowWidth);
        const zoom = Number(viewport.zoom);
        const panX = Number(viewport.panX);
        const panY = Number(viewport.panY);
        files.push(filePath);
        overrides.push({
          windowCenter: Number.isFinite(windowCenter) ? windowCenter : null,
          windowWidth: Number.isFinite(windowWidth) ? windowWidth : null,
          zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
          panX: Number.isFinite(panX) ? panX : 0,
          panY: Number.isFinite(panY) ? panY : 0,
          rotation: [0, 90, 180, 270].includes(Number(viewport.rotation)) ? Number(viewport.rotation) : 0,
          flipH: Boolean(viewport.flipH),
          flipV: Boolean(viewport.flipV),
          annotations: Array.isArray(cell?.annotations)
            ? cell.annotations.map((a) => ({ x: Number(a?.x) || 0, y: Number(a?.y) || 0, label: String(a?.label ?? '').slice(0, 40) }))
            : [],
          footerLines,
        });
      }
    }

    if (!files.length) {
      const rows = db.prepare(`
        SELECT i.file_path
        FROM instances i
        JOIN series sr ON sr.id=i.series_id
        WHERE sr.study_id=?
        ORDER BY sr.series_number, i.instance_number
      `).all(job.study_id);
      files = rows.map((row) => row.file_path).filter((filePath) => filePath && existsSync(filePath));
      overrides = [];
    }
    if (!files.length) return res.status(404).json({ error: 'Nenhum arquivo DICOM encontrado para este estudo.' });
    db.prepare("UPDATE print_jobs SET status='printing', printer_name=?, updated_at=datetime('now') WHERE id=?").run(String(device.aeTitle), job.id);
    const result = typeof scp.sendPrint === 'function'
      ? await scp.sendPrint(device, files, { copies: job.copies, layout: req.body?.layout, orientation: req.body?.orientation, filmSize: req.body?.filmSize, overrides })
      : await scp.sendStore(device, files);
    const status = result.success ? 'printed' : 'failed';
    db.prepare("UPDATE print_jobs SET status=?, error_message=?, printed_at=CASE WHEN ?='printed' THEN datetime('now') ELSE printed_at END, updated_at=datetime('now') WHERE id=?")
      .run(status, result.success ? '' : result.message, status, job.id);
    if (result.success) logger.success(`Impressao DICOM enviada ao filme em ${device.aeTitle} (${device.ip}:${device.port})`, 'PRINT');
    else logger.error(`Impressao DICOM falhou em ${device.aeTitle} (${device.ip}:${device.port}): ${result.message}`, 'PRINT');
    appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'DICOM_PRINT_SENT', resource: `PRINT_JOB:${job.id}`, details: { deviceId: device.id, aeTitle: device.aeTitle, ip: device.ip, port: device.port, ...result }, ip: req.ip });
    res.status(result.success ? 200 : 502).json({ ok: result.success, status, ...result });
  });
  router.put('/api/print-jobs/:id', clinical, (req, res) => {
    const status = ['queued', 'printing', 'printed', 'failed'].includes(req.body?.status) ? req.body.status : 'failed';
    db.prepare("UPDATE print_jobs SET status=?, error_message=?, printed_at=CASE WHEN ?='printed' THEN datetime('now') ELSE printed_at END, updated_at=datetime('now') WHERE id=?")
      .run(status, String(req.body?.error ?? ''), status, req.params.id);
    res.json({ ok: true });
  });

  router.get('/api/dicom-printers', clinical, (_req, res) => {
    const printers = (getConfig().remoteDevices ?? []).filter((device) => device.kind === 'printer');
    res.json(printers);
  });

  router.put('/api/dicom-printers', clinical, (req, res) => {
    try {
      const bodyPrinters = Array.isArray(req.body?.printers) ? req.body.printers : [];
      const printers = bodyPrinters.map((device) => ({
        id: String(device.id || `printer_${Date.now()}_${Math.random().toString(16).slice(2)}`),
        kind: 'printer',
        aeTitle: String(device.aeTitle ?? '').trim().toUpperCase().slice(0, 16),
        callingAeTitle: String(device.callingAeTitle ?? getConfig().aeTitle ?? 'PACSCHX').trim().toUpperCase().slice(0, 16),
        ip: String(device.ip ?? '').trim(),
        port: Number(device.port),
        description: String(device.description ?? '').trim(),
        enabled: Boolean(device.enabled),
      }));
      const invalid = printers.find((device) => !device.aeTitle || !device.ip || !Number.isInteger(device.port) || device.port < 1 || device.port > 65535);
      if (invalid) return res.status(400).json({ error: 'Confira AE Title, IP e porta da impressora DICOM.' });

      const current = getConfig();
      const nextRemoteDevices = [
        ...(current.remoteDevices ?? []).filter((device) => device.kind !== 'printer'),
        ...printers,
      ];
      const license = licenseStatus();
      if (license.active) {
        try { enforceLicense({ devices: nextRemoteDevices.filter((device) => device.enabled).length }); }
        catch (error) { return res.status(403).json({ error: error.message }); }
      }
      const next = setConfig({ ...current, remoteDevices: nextRemoteDevices });
      Object.assign(config, next);
      Object.assign(scp.config, next);
      appendAudit(db, { actor: req.clinicalUser.user, role: req.clinicalUser.role, action: 'DICOM_PRINTERS_SAVED', resource: 'CONFIG', details: { count: printers.length }, ip: req.ip });
      res.json(printers);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // ---- Tamper-evident audit ----
  router.get('/api/audit', clinical, roles('admin', 'auditor', 'maintenance'), (req, res) => res.json(db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 1000').all()));
  router.get('/api/audit/verify', clinical, roles('admin', 'auditor', 'maintenance'), (req, res) => res.json(verifyAudit(db)));

  // ---- Config ----
  router.get('/api/config', (req, res) => {
    const { viewerPassword: _secret, ...safeConfig } = getConfig();
    const address = req.socket?.remoteAddress ?? '';
    const loopback = address === '127.0.0.1' || address === '::1' || address.endsWith('127.0.0.1');
    if (loopback) return res.json(safeConfig);
    res.json({ aeTitle: safeConfig.aeTitle, session: { idleTimeoutMinutes: Number(safeConfig.session?.idleTimeoutMinutes) || 15 }, https: { enabled: Boolean(safeConfig.https?.enabled), port: Number(safeConfig.https?.port) || 4443 } });
  });

  router.put('/api/config', requireLoopback, async (req, res) => {
    const license = licenseStatus();
    const { viewerPassword: _secret, ...safeBody } = req.body ?? {};
    const mergedConfig = {
      ...config,
      ...safeBody,
      backup: { ...(config.backup ?? {}), ...(safeBody.backup ?? {}) },
      dicom: { ...(config.dicom ?? {}), ...(safeBody.dicom ?? {}) },
      license: { ...(config.license ?? {}), ...(safeBody.license ?? {}) },
      session: { ...(config.session ?? {}), ...(safeBody.session ?? {}) },
      https: { ...(config.https ?? {}), ...(safeBody.https ?? {}) },
    };
    if (license.active) {
      try { enforceLicense({ devices: mergedConfig.remoteDevices?.filter((device) => device.enabled).length ?? 0 }); }
      catch (error) { return res.status(403).json({ error: error.message }); }
    }
    const requestedPassword = req.body?.viewerPassword;
    if (requestedPassword) {
      try {
        const account = db.prepare('SELECT id FROM users WHERE username=?').get(req.body?.viewerUser ?? config.viewerUser ?? 'admin');
        if (!account) return res.status(404).json({ error: 'Usuário administrativo não encontrado.' });
        changePassword(db, Number(account.id), String(requestedPassword));
      } catch (error) { return res.status(400).json({ error: error.message }); }
    }
    const next = setConfig(mergedConfig);
    Object.assign(config, next);
    Object.assign(scp.config, next);
    try { writeWorklistCache(config, db); }
    catch (error) { logger.warning(`Worklist DICOM cache nao atualizado: ${error.message}`, 'WORKLIST'); }
    logger.success(`Config updated — AE: ${next.aeTitle}, port: ${next.listenPort}`, 'CONFIG');
    // Restart SCP with new config if running
    const wasRunning = scp.running;
    if (wasRunning) {
      try {
        await scp.stop();
        await scp.start();
      } catch (error) {
        return res.status(400).json({ error: `Configuracao salva, mas o DICOM nao iniciou em ${next.listenIp}:${next.listenPort}: ${error.message}` });
      }
    }
    res.json(next);
  });

  // ---- Server control ----
  router.post('/api/server/start', requireLoopback, async (req, res) => {
    try {
      await scp.start();
      res.json({ running: scp.running });
    } catch (error) {
      res.status(400).json({ error: `DICOM nao iniciou em ${scp.config.listenIp}:${scp.config.listenPort}: ${error.message}`, running: false });
    }
  });

  router.post('/api/server/stop', requireLoopback, async (req, res) => {
    await scp.stop();
    res.json({ running: false });
  });

  router.get('/api/server/status', (req, res) => {
    res.json({
      running: scp.running,
      startedAt: scp.startedAt ?? null,
    });
  });

  router.post('/api/import', requireLoopback, (req, res) => {
    const { path: sourcePath, includeSubfolders = true } = req.body ?? {};
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath) || !existsSync(sourcePath)) {
      return res.status(400).json({ error: 'Caminho local invalido ou inexistente.' });
    }
    const files = [];
    const collect = (currentPath) => {
      const stat = statSync(currentPath);
      if (stat.isFile()) {
        if (extname(currentPath).toLowerCase() === '.dcm') files.push(currentPath);
        return;
      }
      for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
        const entryPath = join(currentPath, entry.name);
        if (entry.isFile() && extname(entry.name).toLowerCase() === '.dcm') files.push(entryPath);
        if (entry.isDirectory() && includeSubfolders) collect(entryPath);
      }
    };
    try {
      collect(sourcePath);
      let imported = 0;
      const errors = [];
      for (const file of files) {
        try {
          scp.importFile(file);
          imported += 1;
        } catch (error) {
          errors.push({ file, message: error.message });
          logger.error(`Falha ao importar ${file}: ${error.message}`, 'IMPORT');
        }
      }
      logger.info(`Importacao concluida: ${imported}/${files.length} arquivo(s)`, 'IMPORT');
      return res.json({ found: files.length, imported, failed: errors.length, errors });
    } catch (error) {
      logger.error(`Falha ao percorrer caminho de importacao: ${error.message}`, 'IMPORT');
      return res.status(500).json({ error: error.message });
    }
  });

  // Browser upload: receives one raw Part-10 DICOM file per request.
  router.post('/api/import-file', clinical, roles('admin', 'technician'), raw({ type: 'application/dicom', limit: '128mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Arquivo DICOM vazio.' });
    const safeName = String(req.headers['x-file-name'] ?? 'upload.dcm').replace(/[^a-zA-Z0-9._-]/g, '_');
    const temporaryPath = join(tmpdir(), `chx-${Date.now()}-${safeName}`);
    try {
      writeFileSync(temporaryPath, req.body);
      const result = scp.importFile(temporaryPath);
      res.json({ ok: true, ...result });
    } catch (error) {
      logger.error(`Falha no upload DICOM ${safeName}: ${error.message}`, 'IMPORT');
      res.status(400).json({ error: error.message });
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    }
  });

  // ---- Test remote IP reachability ----
  router.post('/api/test-echo', requireLoopback, async (req, res) => {
    const { ip, port, aeTitle } = req.body;
    const result = await scp.testEcho({ ip, port, aeTitle });
    logger[result.success ? 'success' : 'error'](
      `Ping IP ${aeTitle} (${ip}) — ${result.message}`,
      'SCP',
    );
    res.json(result);
  });

  // ---- Logs ----
  router.get('/api/logs', requireLoopback, (req, res) => {
    res.json(logger.getLogs());
  });

  router.delete('/api/logs', requireLoopback, (req, res) => {
    logger.clear();
    res.json({ ok: true });
  });

  // ---- Stats ----
  router.get('/api/stats', requireLoopback, (req, res) => {
    const patientCount = db.prepare('SELECT COUNT(*) as c FROM patients').get().c;
    const studyCount = db.prepare('SELECT COUNT(*) as c FROM studies').get().c;
    const instanceCount = db.prepare('SELECT COUNT(*) as c FROM instances').get().c;
    const seriesCount = db.prepare('SELECT COUNT(*) as c FROM series').get().c;
    let storageBytes = 0;
    for (const row of db.prepare('SELECT file_path FROM instances').all()) {
      try { storageBytes += statSync(row.file_path).size; } catch { /* missing file */ }
    }
    let databaseBytes = 0;
    try { databaseBytes = statSync(config.dbPath).size; } catch { /* unavailable */ }
    res.json({ patientCount, studyCount, seriesCount, instanceCount, storageBytes, databaseBytes });
  });

  router.post('/api/database/backup', requireLoopback, (req, res) => {
    try { enforceLicense({ feature: 'backup', db, config }); }
    catch (error) { return res.status(403).json({ error: error.message }); }
    const destination = req.body?.destination;
    if (typeof destination !== 'string' || !isAbsolute(destination)) return res.status(400).json({ error: 'Destino invalido.' });
    try {
      mkdirSync(destination, { recursive: true });
      const run = db.prepare("INSERT INTO backup_runs (started_at, status, destination) VALUES (?, 'running', ?)").run(new Date().toISOString(), destination);
      const result = createEncryptedBackup({ db, config, destination, keyPath: resolve(config.dbPath, '../server/backup.key') });
      db.prepare("UPDATE backup_runs SET finished_at=?, status='success', bytes_written=?, checksum=? WHERE id=?").run(new Date().toISOString(), result.bytes, result.verified ? 'VERIFIED' : 'FAILED', run.lastInsertRowid);
      logger.success(`Backup criptografado e verificado: ${result.root}`, 'DATABASE');
      res.json({ ok: true, path: result.root, files: result.files, bytes: result.bytes, verified: result.verified });
    } catch (error) { logger.error(`Falha no backup: ${error.message}`, 'DATABASE'); res.status(500).json({ error: error.message }); }
  });

  let maintenanceRunning = false;
  router.post('/api/database/maintenance', requireLoopback, requireServiceSession, (req, res) => {
    const action = req.body?.action;
    if (maintenanceRunning) return res.status(409).json({ error: 'Outra manutenção está em andamento.' });
    const startedAt = Date.now();
    try {
      maintenanceRunning = true;
      if (action === 'integrity') {
        const result = db.prepare('PRAGMA integrity_check').all();
        const healthy = result.length === 1 && String(Object.values(result[0] ?? {})[0]).toLowerCase() === 'ok';
        appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: 'DATABASE_INTEGRITY', resource: 'DATABASE', details: { healthy } });
        return res.json({ ok: healthy, action, healthy, result, durationMs: Date.now() - startedAt, message: healthy ? 'Banco íntegro. Nenhum erro encontrado.' : 'A verificação encontrou inconsistências.' });
      }
      if (action === 'vacuum') db.exec('VACUUM');
      else if (action === 'reindex') db.exec('REINDEX');
      else if (action === 'analyze') { db.exec('ANALYZE'); db.exec('PRAGMA optimize'); }
      else return res.status(400).json({ error: 'Acao desconhecida.' });
      logger.success(`Manutencao executada: ${action}`, 'DATABASE');
      const durationMs = Date.now() - startedAt;
      appendAudit(db, { actor: 'SERVICE', role: 'maintenance', action: `DATABASE_${String(action).toUpperCase()}`, resource: 'DATABASE', details: { durationMs } });
      return res.json({ ok: true, action, durationMs, message: action === 'vacuum' ? 'Banco compactado com sucesso.' : action === 'reindex' ? 'Índices reconstruídos com sucesso.' : 'Estatísticas e plano de consultas atualizados.' });
    } catch (error) { logger.error(`Falha na manutencao ${action}: ${error.message}`, 'DATABASE'); return res.status(500).json({ error: error.message }); }
    finally { maintenanceRunning = false; }
  });

  const deleteStudies = (studies) => {
    db.exec('BEGIN');
    try {
      for (const study of studies) {
        for (const report of db.prepare('SELECT id FROM reports WHERE study_id = ?').all(study.id)) {
          db.prepare('DELETE FROM report_versions WHERE report_id = ?').run(report.id);
        }
        db.prepare('DELETE FROM reports WHERE study_id = ?').run(study.id);
        db.prepare('DELETE FROM print_jobs WHERE study_id = ?').run(study.id);
        for (const series of db.prepare('SELECT id FROM series WHERE study_id = ?').all(study.id)) {
          db.prepare('DELETE FROM instances WHERE series_id = ?').run(series.id);
        }
        db.prepare('DELETE FROM series WHERE study_id = ?').run(study.id);
        db.prepare('DELETE FROM studies WHERE id = ?').run(study.id);
      }
      db.exec('DELETE FROM patients WHERE id NOT IN (SELECT DISTINCT patient_id FROM studies)');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    for (const study of studies) {
      if (study.storage_path && existsSync(study.storage_path)) rmSync(study.storage_path, { recursive: true, force: true });
    }
  };

  router.delete('/api/database/patient/:patientId', requireLoopback, requireServiceSession, (req, res) => {
    try {
      const studies = db.prepare('SELECT s.id, s.storage_path FROM studies s JOIN patients p ON p.id=s.patient_id WHERE p.patient_id=?').all(req.params.patientId);
      deleteStudies(studies);
      logger.warning(`Paciente excluido: ${req.params.patientId} (${studies.length} estudos)`, 'DATABASE');
      res.json({ ok: true, deletedStudies: studies.length });
    } catch (error) {
      logger.error(`Falha ao excluir paciente ${req.params.patientId}: ${error.message}`, 'DATABASE');
      res.status(500).json({ error: `Falha ao excluir paciente: ${error.message}` });
    }
  });

  router.delete('/api/studies/:studyId', clinical, roles('admin', 'maintenance', 'technician'), (req, res) => {
    try {
      const study = db.prepare('SELECT id, storage_path FROM studies WHERE id = ?').get(req.params.studyId);
      if (!study) return res.status(404).json({ error: 'Estudo nao encontrado.' });
      deleteStudies([study]);
      logger.warning(`Estudo excluido pela Worklist: ${req.params.studyId}`, 'DATABASE');
      res.json({ ok: true, deletedStudies: 1 });
    } catch (error) {
      logger.error(`Falha ao excluir estudo ${req.params.studyId}: ${error.message}`, 'DATABASE');
      res.status(500).json({ error: `Falha ao excluir estudo: ${error.message}` });
    }
  });

  router.delete('/api/database/studies', requireLoopback, requireServiceSession, (req, res) => {
    try {
      const days = Number(req.query.olderThanDays);
      if (!Number.isFinite(days) || days < 1) return res.status(400).json({ error: 'Periodo invalido.' });
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
      const studies = db.prepare('SELECT id, storage_path FROM studies WHERE study_date < ?').all(cutoff);
      deleteStudies(studies);
      logger.warning(`${studies.length} estudo(s) antigo(s) excluido(s)`, 'DATABASE');
      res.json({ ok: true, deletedStudies: studies.length });
    } catch (error) {
      logger.error(`Falha ao excluir estudos antigos: ${error.message}`, 'DATABASE');
      res.status(500).json({ error: `Falha ao excluir estudos antigos: ${error.message}` });
    }
  });

  return router;
}
