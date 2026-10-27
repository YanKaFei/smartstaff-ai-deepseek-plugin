import { openDatabase } from '../src/db/index.js';
import { get, run } from '../src/lib/db.js';
import { id, sha256, token } from '../src/lib/ids.js';

const args = process.argv.slice(2);
const phone = args[args.indexOf('--phone') + 1];
const email = args[args.indexOf('--email') + 1];
if (!phone || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run migrate:link-email -- --phone 13800000001 --email user@example.com');
  process.exit(1);
}
const h = openDatabase('./data/smartstaff.db');
try {
  const user = get<{ id: string; role: string }>(h.db, 'SELECT id, role FROM users WHERE phone = ?', [phone]);
  if (!user) throw new Error('legacy phone user not found');
  run(h.db, 'UPDATE users SET email = ?, email_verified = 0 WHERE id = ?', [email.toLowerCase(), user.id]);
  const raw = token();
  run(h.db, 'INSERT INTO account_tokens(id, user_id, type, token_hash, expires_at, created_at) VALUES(?,?,?,?,?,?)', [id('atk'), user.id, 'email_verify', sha256(raw), Date.now() + 30 * 60_000, Date.now()]);
  console.log(JSON.stringify({ ok: true, userId: user.id, email: email.toLowerCase(), verificationToken: raw, note: 'Send this token by a secure channel; never log it in production.' }, null, 2));
} finally { h.close(); }
