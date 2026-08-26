const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dataDir = join(__dirname, 'data');
const historyPath = join(dataDir, 'license-history.json');
const authPath = join(dataDir, 'admin-auth.json');
const supabaseKeyPath = join(dataDir, 'supabase-service-key.json');
const SUPABASE_URL = 'https://azdkehfopynxgpjrudya.supabase.co';
let failedAttempts = 0;
let lockedUntil = 0;
let protectKey = (value) => value;
let unprotectKey = (value) => value;

function configureKeyProtection(protect, unprotect) {
  protectKey = protect;
  unprotectKey = unprotect;
}

function ensureDataDir() { mkdirSync(dataDir, { recursive: true }); }
function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function atomicWrite(path, value) {
  ensureDataDir();
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}
function emptyHistory() { return { version: 1, licenses: [], deletions: [] }; }

function importExistingFiles(history) {
  const known = new Set(history.licenses.map((item) => item.license?.licenseId));
  let changed = false;
  for (const name of readdirSync(__dirname)) {
    if (!name.toLowerCase().endsWith('.chxlic')) continue;
    try {
      const result = JSON.parse(readFileSync(join(__dirname, name), 'utf8'));
      if (!result?.license?.licenseId || !result?.key || known.has(result.license.licenseId)) continue;
      history.licenses.push({ ...result, generatedAt: result.license.issuedAt || new Date().toISOString(), importedFrom: name });
      known.add(result.license.licenseId);
      changed = true;
    } catch { /* ignore invalid legacy files */ }
  }
  if (changed) atomicWrite(historyPath, history);
  return history;
}

function listLicenses() {
  ensureDataDir();
  const history = importExistingFiles(readJson(historyPath, emptyHistory()));
  let changed = false;
  for (const item of history.licenses) {
    if (item.key && !item.keyProtected) {
      try {
        item.keyProtected = protectKey(item.key);
        delete item.key;
        changed = true;
      } catch {
        item.keyUnavailable = true;
      }
    }
  }
  if (changed) atomicWrite(historyPath, history);
  return {
    licenses: history.licenses.map((item) => {
      try { return { ...item, key: unprotectKey(item.keyProtected), keyAvailable: true }; }
      catch { return { ...item, key: '', keyAvailable: false }; }
    }).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt))),
    deletions: history.deletions,
  };
}

function recordLicense(result) {
  const history = readJson(historyPath, emptyHistory());
  if (!history.licenses.some((item) => item.license?.licenseId === result.license.licenseId)) {
    history.licenses.push({ license: result.license, keyProtected: protectKey(result.key), generatedAt: new Date().toISOString() });
    atomicWrite(historyPath, history);
  }
  return result;
}

function passwordHash(password, salt) { return scryptSync(password, salt, 32).toString('hex'); }
function adminStatus() { return { configured: existsSync(authPath) }; }
function setupAdminPassword(password) {
  if (existsSync(authPath)) throw new Error('A senha administrativa ja foi configurada.');
  if (String(password || '').length < 8) throw new Error('A senha deve ter pelo menos 8 caracteres.');
  const salt = randomBytes(16).toString('hex');
  atomicWrite(authPath, { version: 1, salt, hash: passwordHash(password, salt), createdAt: new Date().toISOString() });
  return { configured: true };
}
function verifyPassword(password) {
  if (lockedUntil > Date.now()) throw new Error(`Exclusão bloqueada temporariamente. Aguarde ${Math.ceil((lockedUntil - Date.now()) / 60000)} minuto(s).`);
  const auth = readJson(authPath, null);
  if (!auth) throw new Error('Configure primeiro a senha administrativa.');
  const expected = Buffer.from(auth.hash, 'hex');
  const actual = Buffer.from(passwordHash(String(password || ''), auth.salt), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    failedAttempts += 1;
    if (failedAttempts >= 5) { lockedUntil = Date.now() + 15 * 60 * 1000; failedAttempts = 0; }
    throw new Error('Senha administrativa incorreta.');
  }
  failedAttempts = 0;
  lockedUntil = 0;
}
function deleteLicense(licenseId, password) {
  verifyPassword(password);
  const history = readJson(historyPath, emptyHistory());
  const index = history.licenses.findIndex((item) => item.license?.licenseId === licenseId);
  if (index < 0) throw new Error('Licenca nao encontrada.');
  const [removed] = history.licenses.splice(index, 1);
  history.deletions.push({
    licenseId,
    customer: removed.license.customer,
    machineId: removed.license.machineId,
    deletedAt: new Date().toISOString(),
  });
  atomicWrite(historyPath, history);
  return listLicenses();
}

function supabaseStatus() { return { configured: existsSync(supabaseKeyPath), url: SUPABASE_URL }; }
function setupSupabaseKey(serviceKey) {
  const trimmed = String(serviceKey || '').trim();
  if (trimmed.length < 20) throw new Error('Cole a service_role key completa (Supabase > Project Settings > API).');
  atomicWrite(supabaseKeyPath, { keyProtected: protectKey(trimmed), savedAt: new Date().toISOString() });
  return { configured: true };
}
function readSupabaseKey() {
  const stored = readJson(supabaseKeyPath, null);
  if (!stored) throw new Error('Configure a service_role key do Supabase antes de revogar remotamente.');
  try { return unprotectKey(stored.keyProtected); }
  catch { throw new Error('Nao foi possivel ler a service_role key protegida. Configure novamente.'); }
}

// Revoga ou reativa uma licenca no Supabase (server/supabase/002_create_license_revocations.sql),
// usando a service_role key (que ignora RLS) — nunca a anon key, que so tem leitura.
// O servidor do cliente ja consulta essa tabela periodicamente via checkRevocation() (license.js).
async function setRemoteRevocation({ licenseKey, revoked, clinicName, reason, password }) {
  verifyPassword(password);
  const serviceKey = readSupabaseKey();
  const licenseHash = createHash('sha256').update(String(licenseKey || '')).digest('hex');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/license_revocations?on_conflict=license_hash`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      license_hash: licenseHash,
      revoked: Boolean(revoked),
      clinic_name: clinicName || null,
      reason: reason || null,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Supabase respondeu HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  return { revoked: Boolean(revoked), licenseHash };
}

module.exports = {
  adminStatus, configureKeyProtection, deleteLicense, listLicenses, recordLicense, setupAdminPassword,
  supabaseStatus, setupSupabaseKey, setRemoteRevocation,
};
