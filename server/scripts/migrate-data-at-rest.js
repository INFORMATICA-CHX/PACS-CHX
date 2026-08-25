import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { initDb } from '../src/database.js';
import { encryptDicomFileInPlace, isEncryptedDicom, loadDataKey } from '../src/dataProtection.js';

if (process.env.PACS_DB_ALLOW_PLAINTEXT_MIGRATION !== '1') {
  throw new Error('Defina PACS_DB_ALLOW_PLAINTEXT_MIGRATION=1 somente depois de criar e verificar um backup.');
}

const config = loadConfig();
const key = loadDataKey();
const db = initDb(config.dbPath);
const rows = db.prepare('SELECT file_path FROM instances ORDER BY id').all();
let encrypted = 0;
let alreadyEncrypted = 0;
let missing = 0;

for (const { file_path: path } of rows) {
  if (!path || !existsSync(path)) { missing += 1; continue; }
  if (isEncryptedDicom(path)) { alreadyEncrypted += 1; continue; }
  if (encryptDicomFileInPlace(path, key)) encrypted += 1;
}

const integrity = db.pragma('integrity_check', { simple: true });
db.close();
console.log(JSON.stringify({ databaseIntegrity: integrity, indexed: rows.length, encrypted, alreadyEncrypted, missing }, null, 2));
if (integrity !== 'ok' || missing) process.exitCode = 1;
