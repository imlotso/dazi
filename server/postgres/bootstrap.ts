import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { AsyncDatabase } from '../database/types.js';
import { encodeEmail } from '../database/email.js';

/** Create the first administrator atomically; no SMTP is required. */
export async function bootstrapPostgresAdmin(db: AsyncDatabase, username: string, email: string, password: string) {
  if (db.dialect !== 'postgres') throw new Error('PostgreSQL target required');
  username = username.trim(); email = email.trim().toLowerCase();
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username) || email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email) ||
    password.length < 10 || password.length > 128 || /[\r\n]/u.test(password)) throw new Error('Invalid administrator details');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  return db.transaction(async () => {
    if (await db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) throw new Error('An administrator already exists');
    const existing = await db.prepare(`SELECT 1 FROM users WHERE
      translate(username,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C" = translate(?,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"
      OR dazi_email_key(email)=dazi_email_key(?) LIMIT 1`).get(username, encodeEmail(email));
    if (existing) throw new Error('Administrator account is unavailable');
    const id = randomUUID();
    const now = Date.now();
    await db.prepare("INSERT INTO users(id,username,email,password_hash,role,created_at) VALUES (?,?,?,?,'admin',?)")
      .run(id, username, encodeEmail(email), hash, now);
    await db.prepare("INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,target_label,reason,created_at) VALUES (?,?,'user.bootstrap','user',?,?,?,?)")
      .run(id, username, id, username, '本机命令初始化', now);
    return id;
  })();
}
