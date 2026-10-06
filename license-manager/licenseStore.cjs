const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dataDir = join(__dirname, 'data');
const historyPath = join(dataDir, 'license-history.json');
const authPath = join(dataDir, 'admin-auth.json');
const gitConfigPath = join(dataDir, 'git-revocation-config.json');
const gitTokenPath = join(dataDir, 'git-revocation-token.json');
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

function gitRevocationStatus() {
  const config = readJson(gitConfigPath, null);
  return {
    configured: Boolean(config && existsSync(gitTokenPath)),
    owner: config?.owner || '',
    repo: config?.repo || '',
    path: config?.path || 'revocations.json',
    branch: config?.branch || 'main',
  };
}
function setupGitRevocation({ owner, repo, path, branch, token }) {
  const trimmedOwner = String(owner || '').trim();
  const trimmedRepo = String(repo || '').trim();
  const trimmedToken = String(token || '').trim();
  if (!trimmedOwner || !trimmedRepo) throw new Error('Informe o dono e o nome do repositorio (ex: sua-org/pacs-licencas).');
  if (trimmedToken.length < 20) throw new Error('Cole o token de acesso pessoal completo (com permissao de escrita em Contents neste repositorio).');
  atomicWrite(gitConfigPath, {
    owner: trimmedOwner,
    repo: trimmedRepo,
    path: String(path || 'revocations.json').trim() || 'revocations.json',
    branch: String(branch || 'main').trim() || 'main',
  });
  atomicWrite(gitTokenPath, { tokenProtected: protectKey(trimmedToken), savedAt: new Date().toISOString() });
  return { configured: true };
}
function readGitRevocationConfig() {
  const config = readJson(gitConfigPath, null);
  const stored = readJson(gitTokenPath, null);
  if (!config || !stored) throw new Error('Configure o repositorio de revogacao (dono, repo e token) antes de revogar remotamente.');
  let token;
  try { token = unprotectKey(stored.tokenProtected); }
  catch { throw new Error('Nao foi possivel ler o token protegido do repositorio. Configure novamente.'); }
  return { ...config, token };
}

// Revoga ou reativa uma licenca gravando o hash dela num arquivo JSON num
// repositorio Git privado (ex: GitHub), usando um token com permissao de
// escrita em Contents. O servidor do cliente ja consulta esse arquivo
// periodicamente com um token somente-leitura via checkRevocation() (license.js).
async function setRemoteRevocation({ licenseKey, revoked, password }) {
  verifyPassword(password);
  const { owner, repo, path, branch, token } = readGitRevocationConfig();
  const licenseHash = createHash('sha256').update(String(licenseKey || '')).digest('hex');
  const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const getResponse = await fetch(`${contentsUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  let sha;
  let data = { revoked: [] };
  if (getResponse.status === 200) {
    const body = await getResponse.json();
    sha = body.sha;
    try { data = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')); }
    catch { data = { revoked: [] }; }
    if (!Array.isArray(data.revoked)) data.revoked = [];
  } else if (getResponse.status !== 404) {
    const detail = await getResponse.text().catch(() => '');
    throw new Error(`GitHub respondeu HTTP ${getResponse.status}${detail ? `: ${detail}` : ''} ao ler o arquivo.`);
  }
  const set = new Set(data.revoked);
  if (revoked) set.add(licenseHash); else set.delete(licenseHash);
  data.revoked = Array.from(set);
  const putResponse = await fetch(contentsUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `${revoked ? 'Revoga' : 'Reativa'} licenca ${licenseHash.slice(0, 12)}`,
      content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putResponse.ok) {
    const detail = await putResponse.text().catch(() => '');
    throw new Error(`GitHub respondeu HTTP ${putResponse.status}${detail ? `: ${detail}` : ''} ao gravar o arquivo.`);
  }
  return { revoked: Boolean(revoked), licenseHash };
}

module.exports = {
  adminStatus, configureKeyProtection, deleteLicense, listLicenses, recordLicense, setupAdminPassword,
  gitRevocationStatus, setupGitRevocation, setRemoteRevocation,
};
