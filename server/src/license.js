import { createHash, timingSafeEqual, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decryptSecret, encryptSecret } from './dataProtection.js';
import { appendAudit } from './securityStore.js';
import { decodeMachineFingerprint, encodeMachineFingerprint, legacyMachineId, machineFingerprint, matchingFingerprintSources } from './machineIdentity.js';

const baseDir = resolve(process.env.PACS_SERVER_ROOT || process.cwd());
const dataDir = resolve(process.env.PACS_CONFIG_DIR || (process.env.APPDATA ? resolve(process.env.APPDATA, 'PACS CHX') : baseDir));
const publicKeyPath = resolve(baseDir, 'license-public.pem');
mkdirSync(dataDir, { recursive: true });

function migrateLegacyStateFile(name) {
  const legacyPath = resolve(baseDir, name);
  const persistentPath = resolve(dataDir, name);
  if (legacyPath !== persistentPath && !existsSync(persistentPath) && existsSync(legacyPath)) {
    copyFileSync(legacyPath, persistentPath);
  }
  return persistentPath;
}

// Before persistent storage was introduced, activation state lived beside the
// installed server files. Copy it once so upgrades retain existing licenses.
const statePath = migrateLegacyStateFile('license.json');
const clockPath = migrateLegacyStateFile('license-clock.enc');
const FINGERPRINT_CACHE_MS = 10 * 60 * 1000;
let fingerprintCache;
let revocationTimer;

function currentFingerprint() {
  if (fingerprintCache && Date.now() - fingerprintCache.readAt <= FINGERPRINT_CACHE_MS) return fingerprintCache;
  try {
    const fingerprint = machineFingerprint();
    fingerprintCache = { fingerprint, machineId: encodeMachineFingerprint(fingerprint), readAt: Date.now() };
    return fingerprintCache;
  } catch (error) {
    if (fingerprintCache) return fingerprintCache;
    throw error;
  }
}

function verifySignature(key) {
  if (!existsSync(publicKeyPath)) throw new Error('Chave publica nao instalada. Abra o License Manager nesta maquina.');
  const [prefix, payload, signature] = String(key ?? '').trim().split('.');
  if (prefix !== 'CHX1' || !payload || !signature) throw new Error('Formato de licenca invalido.');
  const valid = verify(null, Buffer.from(payload), readFileSync(publicKeyPath), Buffer.from(signature, 'base64url'));
  if (!valid) throw new Error('Assinatura digital invalida.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

export function verifyLicense(key, identity) {
  const license = verifySignature(key);
  if (license.version === 3 && license.machineFingerprint) {
    const licensed = decodeMachineFingerprint(license.machineId);
    if (JSON.stringify(licensed.sources) !== JSON.stringify(license.machineFingerprint)) throw new Error('Fingerprint assinado inconsistente.');
    const current = identity?.fingerprint ?? currentFingerprint().fingerprint;
    if (matchingFingerprintSources(licensed, current) < 2) throw new Error('Licenca emitida para outro computador.');
  } else if (license.version === 2 && license.machineId) {
    const expectedMachine = Buffer.from(legacyMachineId());
    const licensedMachine = Buffer.from(String(license.machineId).toUpperCase());
    if (expectedMachine.length !== licensedMachine.length || !timingSafeEqual(expectedMachine, licensedMachine)) throw new Error('Licenca emitida para outro computador.');
  } else {
    throw new Error('Licenca antiga ou sem vinculo com o servidor. Emita uma nova licenca para esta instalacao.');
  }
  if (license.expiresAt && expirationTime(license.expiresAt) < Date.now()) throw new Error('Licenca expirada.');
  return license;
}

function expirationTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return Infinity;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const expires = new Date(dateOnly ? `${text}T23:59:59` : text);
  if (Number.isNaN(expires.getTime())) throw new Error('Validade da licenca invalida.');
  return expires.getTime();
}

function checkAndRecordClock(now = Date.now()) {
  if (existsSync(clockPath)) {
    try {
      const lastSeen = Number(decryptSecret(readFileSync(clockPath, 'utf8')));
      if (!Number.isFinite(lastSeen)) throw new Error('Registro protegido de relogio invalido.');
      if (now < lastSeen) throw new Error('Relogio do sistema parece estar incorreto. Corrija a data e a hora para continuar.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Relogio do sistema')) throw error;
      const backupDir = resolve(dataDir, 'portable-backups', `invalid-license-clock-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(backupDir, { recursive: true });
      renameSync(clockPath, resolve(backupDir, 'license-clock.enc'));
    }
  }
  const temporary = `${clockPath}.tmp`;
  writeFileSync(temporary, encryptSecret(String(now)), { mode: 0o600 });
  renameSync(temporary, clockPath);
}

export function activateLicense(key) {
  const license = verifyLicense(key);
  checkAndRecordClock();
  const state = { active: true, key, license, activatedAt: new Date().toISOString() };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

export function licenseStatus() {
  let identity;
  let currentMachineId = null;
  try { identity = currentFingerprint(); currentMachineId = identity.machineId; }
  catch (error) {
    if (!existsSync(statePath)) return { active: false, machineId: null, error: error.message };
  }
  if (!existsSync(statePath)) return { active: false, machineId: currentMachineId, error: 'Nenhuma licenca ativada.' };
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!state.active || !state.key) throw new Error('Licenca desativada.');
    const license = verifyLicense(state.key, identity);
    checkAndRecordClock();
    return { ...state, active: true, machineId: currentMachineId, license };
  } catch (error) { return { active: false, machineId: currentMachineId, error: error.message }; }
}

export function deactivateLicense(reason) {
  const state = { active: false, deactivatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

// Le a lista de hashes revogados de um arquivo Git. Prefira um repositorio
// publico contendo apenas hashes; se for privado, injete PACS_REVOCATION_TOKEN
// em tempo de execucao e nunca grave o token no config ou no pacote.
async function checkRevocation({ repo, db, logger }) {
  const status = licenseStatus();
  if (!status.active) return;
  const { owner, repo: name, path, branch } = repo;
  const token = process.env.PACS_REVOCATION_TOKEN?.trim();
  if (!owner || !name) return;
  const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(branch || 'main')}/${path}`;
  const response = await fetch(url, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), accept: 'application/vnd.github.raw' },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) throw new Error('Arquivo de revogacao nao encontrado ou repositorio privado sem PACS_REVOCATION_TOKEN.');
  if (!response.ok) throw new Error(`Repositorio de revogacao respondeu HTTP ${response.status}.`);
  const data = await response.json().catch(() => null);
  const revokedHashes = Array.isArray(data?.revoked) ? data.revoked : [];
  const hash = createHash('sha256').update(status.key).digest('hex');
  if (!revokedHashes.includes(hash)) return;
  deactivateLicense('revoked');
  appendAudit(db, { actor: 'system', role: 'system', action: 'LICENSE_REVOKED', resource: status.license.licenseId, details: { source: `${owner}/${name}` } });
  logger.warning(`Licenca ${status.license.licenseId} revogada remotamente.`, 'SECURITY');
}

export function startRevocationChecks({ config, db, logger }) {
  const repo = config.license?.revocationRepo;
  if (!repo?.owner || !repo?.repo) return null;
  const intervalHours = Number(config.license?.revocationCheckIntervalHours) || 6;
  const run = () => checkRevocation({ repo, db, logger }).catch((error) => logger.warning(`Consulta opcional de revogacao indisponivel: ${error.message}. Operacao offline mantida.`, 'SECURITY'));
  run();
  revocationTimer = setInterval(run, intervalHours * 60 * 60 * 1000);
  revocationTimer.unref();
  return revocationTimer;
}

export function stopRevocationChecks() {
  if (revocationTimer) clearInterval(revocationTimer);
  revocationTimer = undefined;
}

export function enforceLicense({ feature, db, additionalBytes = 0, devices } = {}) {
  const state = licenseStatus();
  if (!state.active) throw new Error(state.error || 'Licenca inativa.');
  const { license } = state;
  const featureAllowed = !feature || license.features?.includes(feature) || (feature === 'worklist' && license.plan === 'FULL');
  if (!featureAllowed) throw new Error(`Recurso nao licenciado: ${feature}.`);
  if (devices != null && devices > license.limits.maxDevices) throw new Error(`Limite de ${license.limits.maxDevices} dispositivos excedido.`);
  if (db) {
    const studies = Number(db.prepare('SELECT COUNT(*) AS c FROM studies').get().c);
    if (Number.isFinite(license.limits.maxStudies) && studies >= license.limits.maxStudies && feature === 'dicom-store') throw new Error(`Limite de ${license.limits.maxStudies} estudos atingido.`);
    if (additionalBytes > 0) {
      let used = 0;
      for (const row of db.prepare('SELECT file_path FROM instances').all()) try { used += statSync(row.file_path).size; } catch { /* missing */ }
      if (used + additionalBytes > license.limits.maxStorageGb * 1024 ** 3) throw new Error(`Limite de ${license.limits.maxStorageGb} GB excedido.`);
    }
  }
  return license;
}
