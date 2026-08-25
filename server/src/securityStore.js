import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { appendFile, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as OTPAuth from 'otpauth';
import { decryptSecret, encryptSecret } from './dataProtection.js';

const auditDirectory = resolve(process.env.PACS_SERVER_ROOT || process.cwd(), '../logs/audit');
const pendingTotp = new Map();

const ROLES = ['master', 'admin', 'radiologist', 'technician', 'reception', 'printing', 'maintenance', 'auditor', 'viewer'];

export function passwordRecord(password, allowLegacyWeak = false) {
  if (typeof password !== 'string' || (!allowLegacyWeak && password.length < 10)) throw new Error('A senha deve possuir pelo menos 10 caracteres.');
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function verifyPassword(password, salt, expected) {
  const actual = Buffer.from(scryptSync(String(password), salt, 64).toString('hex'));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function initializeSecurity(db, config) {
  const count = Number(db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
  if (count === 0) {
    const initialPassword = String(config.viewerPassword || 'ChangeMe-CHX-2026!');
    const record = passwordRecord(initialPassword, true);
    db.prepare('INSERT INTO users (username, display_name, password_hash, password_salt, role, must_change_password) VALUES (?, ?, ?, ?, ?, 0)')
      .run(String(config.viewerUser || 'admin'), 'Administrador PACS CHX', record.hash, record.salt, 'admin');
  }
}

export function authenticateUser(db, username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.active) return null;
  if (user.locked_until && new Date(`${user.locked_until}Z`).getTime() > Date.now()) throw new Error('Usuário temporariamente bloqueado.');
  if (!verifyPassword(password, user.password_salt, user.password_hash)) {
    const failures = Number(user.failed_attempts) + 1;
    const lock = failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '') : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(failures >= 5 ? 0 : failures, lock, user.id);
    return null;
  }
  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  return { id: Number(user.id), username: user.username, displayName: user.display_name, role: user.role, mustChangePassword: Boolean(user.must_change_password), totpEnabled: Boolean(user.totp_enabled), totpSecret: user.totp_secret };
}

export function listUsers(db) { return db.prepare('SELECT id, username, display_name, role, active, must_change_password, totp_enabled, locked_until, created_at, updated_at FROM users ORDER BY username').all(); }

function totpFor(secret, username) {
  return new OTPAuth.TOTP({ issuer: 'PACS CHX', label: username, algorithm: 'SHA1', digits: 6, period: 30, secret });
}

export function beginTotpSetup(db, userId) {
  const user = db.prepare('SELECT id, username FROM users WHERE id=? AND active=1').get(userId);
  if (!user) throw new Error('Usuario nao encontrado.');
  const secret = new OTPAuth.Secret({ size: 20 });
  pendingTotp.set(Number(user.id), { secret: secret.base32, expiresAt: Date.now() + 10 * 60 * 1000 });
  return { uri: totpFor(secret, user.username).toString(), secret: secret.base32 };
}

export function confirmTotpSetup(db, userId, code) {
  const pending = pendingTotp.get(Number(userId));
  const user = db.prepare('SELECT username FROM users WHERE id=?').get(userId);
  if (!pending || pending.expiresAt < Date.now() || !user) throw new Error('Configuracao TOTP ausente ou expirada.');
  if (totpFor(OTPAuth.Secret.fromBase32(pending.secret), user.username).validate({ token: String(code ?? ''), window: 1 }) === null) throw new Error('Codigo TOTP invalido.');
  db.prepare("UPDATE users SET totp_secret=?, totp_enabled=1, updated_at=datetime('now') WHERE id=?").run(encryptSecret(pending.secret), userId);
  pendingTotp.delete(Number(userId));
}

export function verifyUserTotp(account, code) {
  if (!account?.totpEnabled || !account.totpSecret) return false;
  const secret = OTPAuth.Secret.fromBase32(decryptSecret(account.totpSecret));
  return totpFor(secret, account.username).validate({ token: String(code ?? ''), window: 1 }) !== null;
}

export function updateUser(db, userId, input) {
  const current = db.prepare('SELECT id, username, role, active FROM users WHERE id=?').get(userId);
  if (!current) throw new Error('Usuário não encontrado.');
  const displayName = String(input.displayName ?? '').trim();
  if (!displayName) throw new Error('Informe o nome do usuário.');
  if (!ROLES.includes(input.role)) throw new Error('Perfil inválido.');
  if (['admin', 'master'].includes(current.role) && current.active && (!['admin', 'master'].includes(input.role) || !input.active)) {
    const otherAdmins = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role IN ('admin','master') AND active=1 AND id<>?").get(userId).count);
    if (otherAdmins === 0) throw new Error('Crie outro administrador ativo antes de alterar esta conta.');
  }
  db.prepare("UPDATE users SET display_name=?, role=?, active=?, must_change_password=?, updated_at=datetime('now') WHERE id=?")
    .run(displayName, input.role, input.active ? 1 : 0, input.mustChangePassword ? 1 : 0, userId);
}

export function unlockUser(db, userId) {
  const result = db.prepare("UPDATE users SET failed_attempts=0, locked_until=NULL, updated_at=datetime('now') WHERE id=?").run(userId);
  if (!result.changes) throw new Error('Usuário não encontrado.');
}

export function deleteUser(db, userId) {
  const current = db.prepare('SELECT id, username, role, active FROM users WHERE id=?').get(userId);
  if (!current) throw new Error('Usuario nao encontrado.');
  if (['admin', 'master'].includes(current.role) && current.active) {
    const others = Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role IN ('admin','master') AND active=1 AND id<>?").get(userId).count);
    if (others === 0) throw new Error('Crie outro administrador ou master ativo antes de excluir esta conta.');
  }
  db.prepare('DELETE FROM users WHERE id=?').run(userId);
  return { id: Number(current.id), username: current.username, role: current.role };
}

export function createUser(db, input) {
  if (!ROLES.includes(input.role)) throw new Error('Perfil inválido.');
  const username = String(input.username ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw new Error('Usuário inválido.');
  const record = passwordRecord(String(input.password ?? ''));
  const result = db.prepare('INSERT INTO users (username, display_name, password_hash, password_salt, role, must_change_password) VALUES (?, ?, ?, ?, ?, 0)')
    .run(username, String(input.displayName ?? username), record.hash, record.salt, input.role);
  return Number(result.lastInsertRowid);
}

export function upsertExternalUser(db, input) {
  const username = String(input.username ?? '').trim();
  if (!username || !ROLES.includes(input.role)) throw new Error('Usuario externo invalido.');
  const displayName = String(input.displayName ?? username).trim() || username;
  const current = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (current) {
    db.prepare("UPDATE users SET display_name=?, active=1, updated_at=datetime('now') WHERE id=?")
      .run(displayName, current.id);
    return { id: Number(current.id), username, displayName, role: current.role, mustChangePassword: false, totpEnabled: Boolean(current.totp_enabled), totpSecret: current.totp_secret };
  }
  const record = passwordRecord(randomBytes(32).toString('base64url'));
  const result = db.prepare('INSERT INTO users (username, display_name, password_hash, password_salt, role, must_change_password) VALUES (?, ?, ?, ?, ?, 0)')
    .run(username, displayName, record.hash, record.salt, input.role);
  return { id: Number(result.lastInsertRowid), username, displayName, role: input.role, mustChangePassword: false, totpEnabled: false, totpSecret: null };
}

export function changePassword(db, userId, password, mustChange = false) {
  const record = passwordRecord(password);
  db.prepare("UPDATE users SET password_hash=?, password_salt=?, must_change_password=?, updated_at=datetime('now') WHERE id=?")
    .run(record.hash, record.salt, mustChange ? 1 : 0, userId);
}

export function appendAudit(db, event) {
  const previous = db.prepare('SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1').get()?.event_hash ?? 'GENESIS';
  const timestamp = new Date().toISOString();
  const details = event.details ? JSON.stringify(event.details) : '';
  const canonical = [timestamp, event.actor, event.role ?? '', event.action, event.resource, details, event.ip ?? '', previous].join('|');
  const hash = createHash('sha256').update(canonical).digest('hex');
  db.prepare('INSERT INTO audit_events (timestamp, actor, role, action, resource, details, ip_address, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(timestamp, event.actor, event.role ?? '', event.action, event.resource, details, event.ip ?? '', previous, hash);
  // File mirror of the audit trail is written asynchronously so a slow disk
  // never blocks the Node.js event loop (and therefore other API requests,
  // e.g. the worklist) while this write completes. The DB row above is what
  // matters for the hash chain / integrity checks; this file is a convenience
  // export and can safely finish a few milliseconds after the response.
  const external = { timestamp, actor: event.actor, role: event.role ?? '', action: event.action, resource: event.resource, details, ip_address: event.ip ?? '', previous_hash: previous, event_hash: hash };
  mkdirSync(auditDirectory, { recursive: true });
  appendFile(resolve(auditDirectory, `audit-${timestamp.slice(0, 7)}.jsonl`), `${JSON.stringify(external)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' }, () => {});
  return hash;
}

export function verifyAudit(db) {
  let previous = 'GENESIS';
  for (const row of db.prepare('SELECT * FROM audit_events ORDER BY id').all()) {
    const canonical = [row.timestamp, row.actor, row.role ?? '', row.action, row.resource, row.details ?? '', row.ip_address ?? '', previous].join('|');
    const expected = createHash('sha256').update(canonical).digest('hex');
    if (row.previous_hash !== previous || row.event_hash !== expected) return { valid: false, brokenAt: Number(row.id) };
    previous = row.event_hash;
  }
  const count = Number(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
  const month = new Date().toISOString().slice(0, 7);
  const path = resolve(auditDirectory, `audit-${month}.jsonl`);
  if (existsSync(path)) {
    try {
      const external = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const dbMonth = db.prepare("SELECT event_hash FROM audit_events WHERE substr(timestamp,1,7)=? ORDER BY id").all(month);
      if (external.length !== dbMonth.length || external.at(-1)?.event_hash !== dbMonth.at(-1)?.event_hash) return { valid: false, source: 'external_mismatch', count, externalCount: external.length };
    } catch { return { valid: false, source: 'external_mismatch', count }; }
  }
  return { valid: true, count, head: previous };
}

export function contentHash(content) { return createHash('sha256').update(content).digest('hex'); }
