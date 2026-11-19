const Database = require('./release/win-unpacked/resources/app.asar.unpacked/server/node_modules/better-sqlite3-multiple-ciphers');
const fs = require('fs');
const { execSync } = require('child_process');
let dbPath = ['server/data/pacs.db', 'data/pacs.db', 'pacs.db'].find(p => fs.existsSync(p));
if (!dbPath) {
  try {
    dbPath = execSync('powershell -NoProfile -Command "Get-ChildItem -Recurse -Filter pacs.db -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName"', { encoding: 'utf8' }).trim();
  } catch {}
}
if (!dbPath || !fs.existsSync(dbPath)) { console.log('DB_NOT_FOUND'); process.exit(0); }
const db = new Database(dbPath, { readonly: true });
const mapped = db.prepare('SELECT ris_code FROM worklist_mapped_exams').all().map(r => r.ris_code);
console.log('MAPEADOS:' + mapped.length);
const datContent = fs.readFileSync('public/konica-base-mapping.dat', 'utf8').replace(/^\uFEFF/, '');
const datCodes = [...new Set(datContent.split(/\r?\n/).map(l => (l.split('\t')[1] || '').trim()).filter(Boolean))];
console.log('KONICA_TOTAL:' + datCodes.length);
const missing = datCodes.filter(c => !mapped.includes(c));
console.log('FALTAM:' + missing.length);
missing.forEach(c => console.log('MISSING:' + c));
db.close();
