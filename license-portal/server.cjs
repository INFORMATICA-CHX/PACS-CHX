'use strict';

const { createDecipheriv, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, sign, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = String(process.env.PORTAL_ADMIN_PASSWORD || '');
const KEY_BUNDLE = String(process.env.LICENSE_KEY_BUNDLE || '');
const KEY_PASSPHRASE = String(process.env.LICENSE_KEY_PASSPHRASE || '');
const MAX_BODY = 16 * 1024;
const SESSION_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const planDefaults = {
  TRIAL: { expiresAt: () => new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10), limits: { maxStorageGb: 100, maxDevices: 5, maxUsers: 3, maxStudies: 1000 }, features: ['dicom-store', 'web-viewer', 'local-import', 'backup'] },
  PRO: { expiresAt: null, limits: { maxStorageGb: 500, maxDevices: 10, maxUsers: null, maxStudies: null }, features: ['dicom-store', 'web-viewer', 'local-import', 'backup'] },
  FULL: { expiresAt: null, limits: { maxStorageGb: 10000, maxDevices: 1000, maxUsers: null, maxStudies: null }, features: ['dicom-store', 'web-viewer', 'local-import', 'backup', 'worklist'] },
};

function loadIssuerKey() {
  if (!KEY_BUNDLE || !KEY_PASSPHRASE) throw new Error('Configure LICENSE_KEY_BUNDLE e LICENSE_KEY_PASSPHRASE nas variaveis secretas da hospedagem.');
  const bundle = JSON.parse(Buffer.from(KEY_BUNDLE, 'base64').toString('utf8'));
  if (bundle.version !== 1 || bundle.iterations !== 600000) throw new Error('Formato do pacote da chave emissora invalido.');
  const salt = Buffer.from(bundle.salt, 'base64');
  const iv = Buffer.from(bundle.iv, 'base64');
  const ciphertext = Buffer.from(bundle.ciphertext, 'base64');
  const suppliedMac = Buffer.from(bundle.mac, 'base64');
  const keys = pbkdf2Sync(KEY_PASSPHRASE, salt, bundle.iterations, 64, 'sha1');
  const expectedMac = createHmac('sha256', keys.subarray(32)).update(Buffer.concat([salt, iv, ciphertext])).digest();
  if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) throw new Error('Nao foi possivel abrir o pacote da chave emissora. Confira os segredos configurados.');
  const decipher = createDecipheriv('aes-256-cbc', keys.subarray(0, 32), iv);
  const pem = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const privateKey = createPrivateKey(pem);
  const derivedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (derivedPublicKey !== bundle.publicKey) throw new Error('A chave privada importada nao corresponde a chave publica incluida no pacote.');
  return privateKey;
}

let issuerKey;
try {
  if (ADMIN_PASSWORD.length < 16) throw new Error('PORTAL_ADMIN_PASSWORD deve ter pelo menos 16 caracteres aleatorios.');
  issuerKey = loadIssuerKey();
} catch (error) {
  process.stderr.write(`[License Portal] Configuracao invalida: ${error.message}\n`);
  process.exit(1);
}

function send(res, status, value, headers = {}) {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  res.writeHead(status, { 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error('Requisicao muito grande.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function secureRequest(req) { return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? ['', ''] : [entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}
function requireSession(req, res) {
  const token = cookies(req).chx_session;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    send(res, 401, { error: 'Sessao encerrada. Entre novamente.' });
    return null;
  }
  const origin = req.headers.origin;
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = String(forwardedHost || req.headers.host || '').split(',')[0].trim();
  if (origin && new URL(origin).host !== host) { send(res, 403, { error: 'Origem nao autorizada.' }); return null; }
  if (req.headers['x-csrf-token'] !== session.csrf) { send(res, 403, { error: 'Token de seguranca invalido.' }); return null; }
  return session;
}

function issue(claims) {
  const customer = String(claims.customer || '').trim();
  const machineCode = String(claims.machineId || '').trim();
  const plan = String(claims.plan || 'PRO').trim().toUpperCase();
  const preset = planDefaults[plan];
  if (!customer) throw new Error('Informe o titular da licenca.');
  if (!preset) throw new Error('Selecione um plano valido.');
  let machineFingerprint;
  if (machineCode.startsWith('CHX3.')) {
    try {
      const sources = JSON.parse(Buffer.from(machineCode.slice(5), 'base64url').toString('utf8'));
      const valid = Object.entries(sources).filter(([name, value]) => ['machine', 'disk', 'bios'].includes(name) && /^[A-F0-9]{64}$/.test(String(value)));
      if (valid.length < 2) throw new Error();
      machineFingerprint = Object.fromEntries(valid);
    } catch { throw new Error('Informe um codigo multifonte CHX3 valido do servidor.'); }
  }
  const normalizedId = machineFingerprint ? machineCode : machineCode.toUpperCase();
  if (!machineFingerprint && !/^(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/.test(normalizedId)) throw new Error('Informe o codigo completo do servidor do cliente.');
  let expiresAt = typeof preset.expiresAt === 'function' ? preset.expiresAt() : preset.expiresAt;
  const rawDate = String(claims.expiresAt || '').trim();
  if (rawDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || new Date(`${rawDate}T00:00:00Z`).toISOString().slice(0, 10) !== rawDate) throw new Error('Informe uma data de validade valida.');
    expiresAt = rawDate;
  } else if (plan !== 'TRIAL') expiresAt = null;
  const numericLimit = (value, fallback, label) => {
    if (value === '' || value == null) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > 10000000) throw new Error(`Limite invalido: ${label}.`);
    return number;
  };
  const license = {
    version: machineFingerprint ? 3 : 2,
    licenseId: randomBytes(12).toString('hex'),
    customer,
    machineId: normalizedId,
    ...(machineFingerprint ? { machineFingerprint } : {}),
    plan,
    issuedAt: new Date().toISOString(),
    expiresAt,
    limits: {
      maxStorageGb: numericLimit(claims.maxStorageGb, preset.limits.maxStorageGb, 'armazenamento'),
      maxDevices: numericLimit(claims.maxDevices, preset.limits.maxDevices, 'dispositivos'),
      maxUsers: preset.limits.maxUsers,
      maxStudies: preset.limits.maxStudies,
    },
    features: preset.features,
  };
  const payload = Buffer.from(JSON.stringify(license)).toString('base64url');
  const signature = sign(null, Buffer.from(payload), issuerKey).toString('base64url');
  return { license, key: `CHX1.${payload}.${signature}` };
}

async function handler(req, res) {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/') && !secureRequest(req)) return send(res, 400, { error: 'Acesse o portal usando HTTPS.' });
    if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'GET' && path === '/api/session') {
      const token = cookies(req).chx_session;
      const session = sessions.get(token);
      if (!session || session.expiresAt < Date.now()) return send(res, 401, { authenticated: false });
      return send(res, 200, { authenticated: true, csrf: session.csrf });
    }
    if (req.method === 'POST' && path === '/api/login') {
      const address = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const attempts = loginAttempts.get(address) || { count: 0, until: 0 };
      if (attempts.until > Date.now()) return send(res, 429, { error: 'Muitas tentativas. Aguarde alguns minutos.' });
      const input = await readJson(req);
      const supplied = Buffer.from(String(input.password || ''));
      const expected = Buffer.from(ADMIN_PASSWORD);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        attempts.count += 1;
        if (attempts.count >= 5) { attempts.count = 0; attempts.until = Date.now() + 15 * 60 * 1000; }
        loginAttempts.set(address, attempts);
        return send(res, 401, { error: 'Senha incorreta.' });
      }
      loginAttempts.delete(address);
      const token = randomBytes(32).toString('base64url');
      const session = { csrf: randomBytes(32).toString('base64url'), expiresAt: Date.now() + SESSION_MS };
      sessions.set(token, session);
      return send(res, 200, { authenticated: true, csrf: session.csrf }, { 'Set-Cookie': `chx_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secureRequest(req) ? '; Secure' : ''}` });
    }
    if (req.method === 'POST' && path === '/api/logout') {
      const token = cookies(req).chx_session;
      const session = requireSession(req, res);
      if (!session) return;
      sessions.delete(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'chx_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (req.method === 'POST' && path === '/api/issue') {
      if (!requireSession(req, res)) return;
      const claims = await readJson(req);
      return send(res, 200, issue(claims));
    }
    if (req.method === 'GET' && path === '/') {
      const page = await readFile(join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
      return res.end(page);
    }
    if (req.method === 'GET' && ['/styles.css', '/portal.js'].includes(path)) {
      const asset = await readFile(join(__dirname, path.slice(1)));
      const type = path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': asset.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(asset);
    }
    return send(res, 404, { error: 'Rota nao encontrada.' });
  } catch (error) {
    const status = /Requisicao muito grande|Unexpected end|JSON/.test(error.message) ? 400 : 422;
    return send(res, status, { error: error.message || 'Nao foi possivel processar a solicitacao.' });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
  for (const [address, attempts] of loginAttempts) if (attempts.until && attempts.until < now) loginAttempts.delete(address);
}, 10 * 60 * 1000).unref();

createServer((req, res) => { handler(req, res).catch(() => send(res, 500, { error: 'Erro interno do portal.' })); })
  .listen(PORT, '0.0.0.0', () => process.stdout.write(`[License Portal] Rodando na porta ${PORT}.\n`));
