import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const DICOM_MAGIC = Buffer.from('CHXDIC01');
const SECRET_PREFIX = 'CHXSEC01';

export function loadDataKey() {
  const value = process.env.PACS_DB_KEY?.trim() || loadOrCreateLocalKey();
  if (!value) throw new Error('PACS_DB_KEY nao definida. Configure uma chave de 32 bytes em hexadecimal ou base64.');

  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else {
    try { key = Buffer.from(value, 'base64'); } catch { key = null; }
  }
  if (!key || key.length !== 32) throw new Error('PACS_DB_KEY invalida: use exatamente 32 bytes (64 hex ou base64).');
  return key;
}

function loadOrCreateLocalKey() {
  const configDir = process.env.PACS_CONFIG_DIR || (process.env.APPDATA ? resolve(process.env.APPDATA, 'PACS CHX') : '');
  if (!configDir) return '';
  const keyPath = resolve(configDir, 'data.key');
  if (existsSync(keyPath)) return readFileSync(keyPath, 'utf-8').trim().replace(/^\uFEFF/, '');
  mkdirSync(dirname(keyPath), { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export function keyAsHex(key = loadDataKey()) {
  return Buffer.from(key).toString('hex');
}

export function encryptSecret(value, key = loadDataKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [SECRET_PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload, key = loadDataKey()) {
  const [prefix, iv, tag, encrypted] = String(payload ?? '').split('.');
  if (prefix !== SECRET_PREFIX || !iv || !tag || !encrypted) throw new Error('Segredo cifrado invalido.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptDicomBuffer(plain, key = loadDataKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([DICOM_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptDicomBuffer(payload, key = loadDataKey(), { allowPlaintext = false } = {}) {
  if (!payload.subarray(0, DICOM_MAGIC.length).equals(DICOM_MAGIC)) {
    if (allowPlaintext) return payload;
    throw new Error('Arquivo DICOM nao esta criptografado ou possui formato invalido.');
  }
  if (payload.length < 36) throw new Error('Arquivo DICOM criptografado truncado.');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(8, 20));
  decipher.setAuthTag(payload.subarray(20, 36));
  return Buffer.concat([decipher.update(payload.subarray(36)), decipher.final()]);
}

export function writeDicomFile(path, plain, key = loadDataKey()) {
  writeFileSync(path, encryptDicomBuffer(plain, key), { mode: 0o600 });
}

export function readDicomFile(path, key = loadDataKey(), options) {
  return decryptDicomBuffer(readFileSync(path), key, options);
}

// Same as readDicomFile but uses the async fs API. The GET routes that serve
// a study's images (/api/instances/:id/file and /pixels) are on the hot path
// every time a user opens a study — one request per image, sometimes dozens
// per series. readFileSync blocks Node's single event loop thread for the
// whole disk read, which stalls *every other* request the server is handling
// at that moment (including other workstations on the local network). This
// async version lets the server keep serving other requests while the disk
// I/O is in flight.
export async function readDicomFileAsync(path, key = loadDataKey(), options) {
  return decryptDicomBuffer(await readFile(path), key, options);
}

export function isEncryptedDicom(path) {
  const payload = readFileSync(path);
  return payload.subarray(0, DICOM_MAGIC.length).equals(DICOM_MAGIC);
}

export function encryptDicomFileInPlace(path, key = loadDataKey()) {
  const payload = readFileSync(path);
  if (payload.subarray(0, DICOM_MAGIC.length).equals(DICOM_MAGIC)) return false;
  const temporary = `${path}.encrypting`;
  try {
    writeFileSync(temporary, encryptDicomBuffer(payload, key), { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function dataDigest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
