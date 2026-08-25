import { randomBytes } from 'node:crypto';
import { appendAudit, authenticateUser, upsertExternalUser, verifyUserTotp } from './securityStore.js';
import { authenticateSupabaseUser, supabaseAuthEnabled } from './supabaseAuth.js';

const sessions = new Map();
const attempts = new Map();
const preAuthenticated = new Map();
const totpAttempts = new Map();
const SESSION_MS = 8 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_ATTEMPTS = 5;
const MAX_IP_ATTEMPTS = 20;
const PRE_AUTH_MS = 2 * 60 * 1000;

function clean() {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [token, session] of preAuthenticated) if (session.expiresAt <= now) preAuthenticated.delete(token);
  for (const token of totpAttempts.keys()) if (!preAuthenticated.has(token)) totpAttempts.delete(token);
  for (const [key, state] of attempts) if (state.since + WINDOW_MS <= now) attempts.delete(key);
}

export async function loginClinical(req, db, logger, config = {}) {
  clean();
  const address = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const user = String(req.body?.user ?? '').trim();
  const password = String(req.body?.password ?? '');
  const accountKey = `${address}|${user.toLowerCase()}`;
  const accountState = attempts.get(accountKey) ?? { count: 0, since: Date.now() };
  const ipState = attempts.get(address) ?? { count: 0, since: Date.now() };
  if (accountState.count >= MAX_ACCOUNT_ATTEMPTS || ipState.count >= MAX_IP_ATTEMPTS) throw new Error('Muitas tentativas. Aguarde 15 minutos.');

  let account = null;
  if (supabaseAuthEnabled(config)) {
    try {
      const external = await authenticateSupabaseUser(config, user, password);
      if (external) account = upsertExternalUser(db, external);
    } catch (error) {
      logger.warning(`Login Supabase recusado para ${user || '(vazio)'} de ${address}: ${error.message}`, 'SECURITY');
    }
    if (!account && config.supabase?.allowLocalFallback) {
      logger.info(`Tentando login local para ${user || '(vazio)'}`, 'SECURITY');
      account = authenticateUser(db, user, password);
    } else if (!account) {
      logger.warning('Fallback local desativado; login local nao sera testado.', 'SECURITY');
    }
  } else {
    account = authenticateUser(db, user, password);
  }
  if (!account) {
    attempts.set(accountKey, { ...accountState, count: accountState.count + 1 });
    attempts.set(address, { ...ipState, count: ipState.count + 1 });
    logger.warning(`Login clinico recusado para ${user || '(vazio)'} de ${address}`, 'SECURITY');
    throw new Error('Usuário ou senha inválidos.');
  }

  attempts.delete(accountKey);
  if (['admin', 'master'].includes(account.role) && account.totpEnabled) {
    const preAuthToken = randomBytes(32).toString('base64url');
    preAuthenticated.set(preAuthToken, { account, address, expiresAt: Date.now() + PRE_AUTH_MS });
    return { mfaRequired: true, preAuthToken, expiresAt: new Date(Date.now() + PRE_AUTH_MS).toISOString() };
  }
  if (['admin', 'master'].includes(account.role)) appendAudit(db, { actor: account.username, role: account.role, action: 'ADMIN_LOGIN_WITHOUT_MFA', resource: 'AUTH', ip: address });
  return issueSession(account, address, db, logger);
}

function issueSession(account, address, db, logger) {
  const token = randomBytes(32).toString('base64url');
  const session = { user: account.username, userId: account.id, displayName: account.displayName, role: account.role, issuedAt: Date.now(), expiresAt: Date.now() + SESSION_MS };
  sessions.set(token, session);
  logger.success(`Login clinico autorizado: ${account.username} de ${address}`, 'SECURITY');
  appendAudit(db, { actor: account.username, role: account.role, action: 'LOGIN', resource: 'AUTH', ip: address });
  return { token, user: account.username, displayName: account.displayName, role: session.role, expiresAt: new Date(session.expiresAt).toISOString() };
}

export function verifyClinicalTotp(preAuthToken, code, db, logger) {
  clean();
  const token = String(preAuthToken ?? '');
  const pending = preAuthenticated.get(token);
  if (!pending) throw new Error('Codigo TOTP invalido ou autenticacao expirada.');
  if (!verifyUserTotp(pending.account, code)) {
    const failures = (totpAttempts.get(token) ?? 0) + 1;
    if (failures >= 5) {
      preAuthenticated.delete(token);
      totpAttempts.delete(token);
      logger.warning(`Pre-autenticacao TOTP bloqueada para ${pending.account.username} de ${pending.address}`, 'SECURITY');
    } else totpAttempts.set(token, failures);
    throw new Error(failures >= 5 ? 'Muitas tentativas TOTP. Inicie o login novamente.' : 'Codigo TOTP invalido ou autenticacao expirada.');
  }
  preAuthenticated.delete(token);
  totpAttempts.delete(token);
  return issueSession(pending.account, pending.address, db, logger);
}

export function requireClinicalSession(logger, db) {
  return (req, res, next) => {
    clean();
    const header = req.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = token ? sessions.get(token) : undefined;
    if (!session) return res.status(401).json({ error: 'Sessão ausente ou expirada.', code: 'AUTH_REQUIRED' });
    const current = db.prepare('SELECT username, display_name, role, active FROM users WHERE id=?').get(session.userId);
    if (!current?.active) {
      sessions.delete(token);
      return res.status(401).json({ error: 'Conta desativada ou removida.', code: 'AUTH_REVOKED' });
    }
    session.user = current.username;
    session.displayName = current.display_name;
    session.role = current.role;
    req.clinicalUser = session;
    logger.info(`${session.user}: ${req.method} ${req.path}`, 'AUDIT');
    // Only write to the tamper-evident audit trail for requests that change
    // data (POST/PUT/DELETE/PATCH). Read-only GETs (worklist listing, which
    // the frontend polls every 15s across 3 endpoints at once) previously
    // wrote a chained-hash audit row + log file on every single poll, which
    // serialized against the SQLite writer lock and slowed down the very
    // requests the worklist was waiting on. Plain access is still visible in
    // the regular application log line above.
    if (req.method !== 'GET') {
      appendAudit(db, { actor: session.user, role: session.role, action: req.method, resource: req.path, ip: req.ip });
    }
    next();
  };
}

export function logoutClinical(req) {
  const header = req.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) sessions.delete(header.slice(7));
}

export function invalidateClinicalSessions(userId, exceptToken = '') {
  for (const [token, session] of sessions) if (session.userId === Number(userId) && token !== exceptToken) sessions.delete(token);
}

export function requireLoopback(req, res, next) {
  const address = req.socket?.remoteAddress ?? '';
  if (address === '127.0.0.1' || address === '::1' || address.endsWith('127.0.0.1')) return next();
  return res.status(403).json({ error: 'Operação administrativa permitida somente no computador do servidor.' });
}
