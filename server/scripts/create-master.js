import { loadConfig } from '../src/config.js';
import { initDb } from '../src/database.js';
import { appendAudit, changePassword, createUser } from '../src/securityStore.js';

const password = process.env.PACS_MASTER_PASSWORD || 'admin123admin';
const resetPassword = process.argv.includes('--reset-password');
const db = initDb(loadConfig().dbPath);

try {
  const existing = db.prepare("SELECT id, username, role FROM users WHERE username='master'").get();
  if (existing) {
    if (existing.role !== 'master') {
      db.prepare("UPDATE users SET role='master', active=1, updated_at=datetime('now') WHERE id=?").run(existing.id);
    }
    if (resetPassword) {
      changePassword(db, Number(existing.id), password, false);
      appendAudit(db, { actor: 'SYSTEM', role: 'master', action: 'MASTER_PASSWORD_RESET', resource: `USER:${existing.id}` });
    }
    console.log(JSON.stringify({ created: false, passwordReset: resetPassword, id: Number(existing.id), username: 'master', role: 'master' }));
  } else {
    const id = createUser(db, { username: 'master', displayName: 'Master PACS CHX', password, role: 'master' });
    appendAudit(db, { actor: 'SYSTEM', role: 'master', action: 'MASTER_USER_CREATED', resource: `USER:${id}` });
    console.log(JSON.stringify({ created: true, id, username: 'master', role: 'master', mustChangePassword: false }));
  }
} finally {
  db.close();
}
