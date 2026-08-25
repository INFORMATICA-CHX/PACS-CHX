import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readDicomFile } from './dataProtection.js';

const MAGIC = Buffer.from('CHXBAK01');
function digest(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function walkFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkFiles(join(root, entry.name)) : [join(root, entry.name)]);
}

export function loadBackupKey(keyPath) {
  if (!existsSync(keyPath)) { mkdirSync(dirname(keyPath), { recursive: true }); writeFileSync(keyPath, randomBytes(32), { mode: 0o600 }); }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('Chave de backup inválida.');
  return key;
}

export function encryptFile(source, target, key) {
  return encryptBuffer(readFileSync(source), target, key);
}

export function encryptBuffer(plain, target, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.concat([MAGIC, iv, tag, encrypted]));
  return { sourceBytes: plain.length, encryptedBytes: statSync(target).size, checksum: digest(plain) };
}

export function verifyEncryptedFile(target, key, expectedChecksum) {
  const payload = readFileSync(target);
  if (!payload.subarray(0, 8).equals(MAGIC)) throw new Error(`Formato de backup inválido: ${target}`);
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(8, 20));
  decipher.setAuthTag(payload.subarray(20, 36));
  const plain = Buffer.concat([decipher.update(payload.subarray(36)), decipher.final()]);
  return digest(plain) === expectedChecksum;
}

export function createEncryptedBackup({ db, config, destination, keyPath }) {
  const key = loadBackupKey(keyPath);
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = join(destination, `pacs-chx-${stamp}`);
  mkdirSync(root, { recursive: true });
  const files = [];
  const dbResult = encryptFile(config.dbPath, join(root, 'database.chxbak'), key);
  files.push({ type: 'database', path: 'database.chxbak', ...dbResult });
  for (const row of db.prepare('SELECT file_path FROM instances ORDER BY id').all()) {
    if (!row.file_path || !existsSync(row.file_path)) continue;
    const rel = relative(config.storagePath, row.file_path);
    const targetRel = join('dicom', `${rel}.chxbak`);
    files.push({ type: 'dicom', path: targetRel, ...encryptBuffer(readDicomFile(row.file_path), join(root, targetRel), key) });
  }
  const auditRoot = join(config.logPath, 'audit');
  for (const source of walkFiles(auditRoot)) {
    const rel = relative(auditRoot, source);
    const targetRel = join('audit', `${rel}.chxbak`);
    files.push({ type: 'audit', path: targetRel, ...encryptFile(source, join(root, targetRel), key) });
  }
  const manifest = { format: 1, createdAt: new Date().toISOString(), aeTitle: config.aeTitle, fileCount: files.length, files };
  const manifestPath = join(root, 'manifest.chxbak');
  const temporaryManifest = join(root, 'manifest.json.tmp');
  writeFileSync(temporaryManifest, JSON.stringify(manifest));
  encryptFile(temporaryManifest, manifestPath, key);
  // Overwrite temporary plaintext immediately; no clinical metadata remains in clear text.
  writeFileSync(temporaryManifest, '');
  rmSync(temporaryManifest, { force: true });
  const verified = files.every((file) => verifyEncryptedFile(join(root, file.path), key, file.checksum));
  return { root, files: files.length, bytes: files.reduce((sum, file) => sum + file.encryptedBytes, 0), verified };
}
