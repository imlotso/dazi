// One-time setup for a database initialized by the current service.
// Set DATABASE_PATH (defaults to ./data/dazi.sqlite), ADMIN_USERNAME and ADMIN_EMAIL.
// Pass one UTF-8 password line via stdin from a silent prompt or a secret manager.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import Database from 'better-sqlite3';

class BootstrapError extends Error {}

async function readPassword() {
  if (process.stdin.isTTY) throw new BootstrapError('请通过标准输入传入一行密码');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 514) throw new BootstrapError('密码须为 10–128 个字符，且只能输入一行');
    chunks.push(chunk);
  }
  let password;
  try {
    password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/u, '');
  } catch { throw new BootstrapError('密码须使用 UTF-8 编码'); }
  if (password.length < 10 || password.length > 128 || /[\r\n]/u.test(password)) {
    throw new BootstrapError('密码须为 10–128 个字符，且只能输入一行');
  }
  return password;
}

async function bootstrap() {
  const username = (process.env.ADMIN_USERNAME ?? '').trim();
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) throw new BootstrapError('ADMIN_USERNAME 须为 3–24 位字母、数字、下划线或连字符');
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email)) {
    throw new BootstrapError('请通过 ADMIN_EMAIL 设置有效邮箱');
  }
  let db;
  try {
    db = new Database(resolve(process.env.DATABASE_PATH || './data/dazi.sqlite'), { fileMustExist: true });
  } catch (error) {
    if (error.code === 'SQLITE_CANTOPEN') throw new BootstrapError('无法打开数据库，请先启动服务初始化数据库并检查 DATABASE_PATH');
    throw error;
  }
  try {
    const columns = new Set(db.pragma('table_info(users)').map((column) => column.name));
    const auditTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='admin_audit'");
    if (!['id', 'username', 'email', 'password_hash', 'role', 'disabled_at', 'auth_version', 'created_at'].every((name) => columns.has(name)) || !auditTable.get()) {
      throw new BootstrapError('请先启动当前版本服务初始化数据库');
    }

    const adminExists = db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    const accountExists = db.prepare('SELECT 1 FROM users WHERE username=? OR email=? LIMIT 1');
    const checkAvailable = () => {
      if (adminExists.get()) throw new BootstrapError('管理员已存在，请在管理后台调整角色');
      if (accountExists.get(username, email)) throw new BootstrapError('用户名或邮箱已存在，请换用新账号');
    };
    checkAvailable();
    const hash = await argon2.hash(await readPassword(), { type: argon2.argon2id });
    db.transaction(() => {
      checkAvailable();
      const id = randomUUID();
      const now = Date.now();
      db.prepare("INSERT INTO users(id,username,email,password_hash,role,created_at) VALUES (?,?,?,?,'admin',?)")
        .run(id, username, email, hash, now);
      db.prepare("INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,target_label,reason,created_at) VALUES (?,?,'user.bootstrap','user',?,?,?,?)")
        .run(id, username, id, username, '本机命令初始化', now);
    }).immediate();
  } finally { db.close(); }
  console.log('首位管理员已创建');
}

try {
  await bootstrap();
} catch (error) {
  console.error(error instanceof BootstrapError ? error.message : '管理员初始化失败，请检查数据库权限和服务版本');
  process.exitCode = 1;
}
