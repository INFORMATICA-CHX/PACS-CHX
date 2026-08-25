import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as OTPAuth from 'otpauth';
import { decryptSecret, encryptSecret } from './dataProtection.js';

const statePath = resolve(process.env.PACS_SERVER_ROOT || process.cwd(), 'service-auth.json');
const sessions = new Map();
const preAuthenticated = new Map();
const totpAttempts = new Map();
const SESSION_MS = 30 * 60 * 1000;
let failedAttempts = 0;
let lockedUntil = 0;

function loadState() { return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null; }
function hash(password, salt) { return scryptSync(password, salt, 64).toString('hex'); }
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('A senha deve ter pelo menos 10 caracteres.');
}
export function serviceAuthStatus() { const state = loadState(); return { configured: Boolean(state), totpEnabled: Boolean(state?.totpEnabled) }; }
export function configureServicePassword(password) {
  if (loadState()) throw new Error('A senha de servico ja foi configurada.');
  validatePassword(password);
  const salt = randomBytes(24).toString('hex');
  writeFileSync(statePath, JSON.stringify({ salt, hash: hash(password, salt), createdAt: new Date().toISOString() }, null, 2));
  return createSession();
}
export function loginService(password) {
  if (lockedUntil > Date.now()) throw new Error(`Acesso temporariamente bloqueado. Aguarde ${Math.ceil((lockedUntil - Date.now()) / 60000)} minuto(s).`);
  const state = loadState();
  if (!state) throw new Error('Senha de servico ainda nao configurada.');
  const actual = Buffer.from(hash(String(password ?? ''), state.salt), 'hex');
  const expected = Buffer.from(state.hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    failedAttempts += 1;
    if (failedAttempts >= 5) { lockedUntil = Date.now() + 15 * 60 * 1000; failedAttempts = 0; }
    throw new Error('Senha de servico incorreta.');
  }
  failedAttempts = 0;
  lockedUntil = 0;
  if (state.totpEnabled && state.totpSecret) {
    const preAuthToken = randomBytes(32).toString('base64url');
    preAuthenticated.set(preAuthToken, Date.now() + 2 * 60 * 1000);
    return { mfaRequired: true, preAuthToken, expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() };
  }
  return createSession();
}
export function verifyServiceTotp(preAuthToken, code) {
  const token = String(preAuthToken ?? '');
  const expiresAt = preAuthenticated.get(token);
  const state = loadState();
  if (!expiresAt || expiresAt < Date.now() || !state?.totpEnabled || !state.totpSecret) throw new Error('Autenticacao TOTP expirada.');
  const totp = new OTPAuth.TOTP({ issuer: 'PACS CHX', label: 'Manutencao', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(decryptSecret(state.totpSecret)) });
  if (totp.validate({ token: String(code ?? ''), window: 1 }) === null) {
    const failures = (totpAttempts.get(token) ?? 0) + 1;
    if (failures >= 5) { preAuthenticated.delete(token); totpAttempts.delete(token); }
    else totpAttempts.set(token, failures);
    throw new Error(failures >= 5 ? 'Muitas tentativas TOTP. Inicie o login novamente.' : 'Codigo TOTP invalido.');
  }
  preAuthenticated.delete(token);
  totpAttempts.delete(token);
  return createSession();
}

export function setupServiceTotp() {
  const state = loadState();
  if (!state) throw new Error('Senha de servico ainda nao configurada.');
  const secret = new OTPAuth.Secret({ size: 20 });
  state.pendingTotpSecret = encryptSecret(secret.base32);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  const totp = new OTPAuth.TOTP({ issuer: 'PACS CHX', label: 'Manutencao', digits: 6, period: 30, secret });
  return { uri: totp.toString(), secret: secret.base32 };
}

export function confirmServiceTotp(code) {
  const state = loadState();
  if (!state?.pendingTotpSecret) throw new Error('Configuracao TOTP ausente.');
  const secret = decryptSecret(state.pendingTotpSecret);
  const totp = new OTPAuth.TOTP({ issuer: 'PACS CHX', label: 'Manutencao', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  if (totp.validate({ token: String(code ?? ''), window: 1 }) === null) throw new Error('Codigo TOTP invalido.');
  state.totpSecret = encryptSecret(secret); state.totpEnabled = true; delete state.pendingTotpSecret;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function createSession() {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_MS;
  sessions.set(token, expiresAt);
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}
export function requireServiceSession(req, res, next) {
  const token = req.get('X-Service-Token');
  const expiresAt = token ? sessions.get(token) : undefined;
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Autenticacao de servico necessaria.', code: 'SERVICE_AUTH_REQUIRED' });
  }
  next();
}

export function logoutService(req) {
  const token = req.get('X-Service-Token');
  if (token) sessions.delete(token);
}
