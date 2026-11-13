import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Database from 'better-sqlite3';
import argon2 from 'argon2';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { articles, difficulties, type Difficulty, type Language } from '../src/data/articles';
import { scoreTyping, splitCharacters } from '../src/lib/scoring';

export type Mailer = { sendCode(email: string, code: string, purpose: string): Promise<void> };
export type AppOptions = {
  databasePath: string;
  now?: () => number;
  secureCookies?: boolean;
  mailer?: Mailer;
  codeSecret?: string;
  adminEmail?: string;
  staticRoot?: string;
};

type User = { id: string; username: string; email: string; password_hash: string };
type Challenge = {
  id: string; owner: string; language: Language; difficulty: Difficulty; duration: number;
  target: string; started_at: number; finished_at: number | null; status: string;
  correct: number | null; total: number | null; accuracy: number | null; speed: number | null;
  published: number; nickname: string | null;
};
type Input = Record<string, unknown>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emailPattern = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const durations = [30, 60, 120];
const invalid = (reply: FastifyReply, message: string, code = 400) => reply.code(code).send({ error: message });
const cleanEmail = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const bodyOf = (request: FastifyRequest): Input => request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Input : {};

export async function createApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const codeSecret = options.codeSecret || randomBytes(32).toString('hex');
  const adminEmail = cleanEmail(options.adminEmail);
  const db = new Database(options.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(email, purpose)
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, language TEXT NOT NULL, difficulty TEXT NOT NULL,
      duration INTEGER NOT NULL, target TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active', correct INTEGER, total INTEGER, accuracy REAL, speed REAL,
      published INTEGER NOT NULL DEFAULT 0, nickname TEXT
    );
    CREATE TABLE IF NOT EXISTS scores (
      owner TEXT NOT NULL, language TEXT NOT NULL, difficulty TEXT NOT NULL, duration INTEGER NOT NULL,
      nickname TEXT NOT NULL, speed REAL NOT NULL, accuracy REAL NOT NULL, correct INTEGER NOT NULL,
      created_at INTEGER NOT NULL, attempt_id TEXT NOT NULL,
      PRIMARY KEY(owner, language, difficulty, duration)
    );
    CREATE INDEX IF NOT EXISTS scores_rank ON scores(language, difficulty, duration, speed DESC, accuracy DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS challenges_owner ON challenges(owner, started_at DESC);
  `);

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
  app.addHook('onClose', async () => { db.close(); });
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || !request.headers.origin) return;
    try {
      if (new URL(request.headers.origin).host !== request.headers.host) return invalid(reply, '请求来源无效', 403);
    } catch { return invalid(reply, '请求来源无效', 403); }
  });

  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: secureCookies };
  const userFor = (request: FastifyRequest): User | undefined => {
    const token = request.cookies.session;
    if (!token || token.length > 100) return undefined;
    return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(digest(token), now()) as User | undefined;
  };
  const publicUser = (user: User) => ({ id: user.id, username: user.username, email: user.email, isAdmin: !!adminEmail && user.email.toLowerCase() === adminEmail });
  const startSession = (reply: FastifyReply, user: User) => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(digest(token), user.id, now() + 30 * 86400_000);
    reply.setCookie('session', token, { ...cookieOptions, maxAge: 30 * 86400 });
  };
  const getOwner = (request: FastifyRequest, reply: FastifyReply, create = true): string | null => {
    const user = userFor(request);
    if (user) return `u:${user.id}`;
    let guest = request.cookies.guest;
    if (!guest || !/^[A-Za-z0-9_-]{43}$/.test(guest)) {
      if (!create) return null;
      guest = randomBytes(32).toString('base64url');
      reply.setCookie('guest', guest, { ...cookieOptions, maxAge: 365 * 86400 });
    }
    return `g:${digest(guest)}`;
  };
  const getCodeHash = (email: string, purpose: string, code: string) => createHmac('sha256', codeSecret).update(`${email}\0${purpose}\0${code}`).digest('hex');
  const consumeCode = (email: string, purpose: string, code: string): boolean => {
    const row = db.prepare('SELECT * FROM email_codes WHERE email = ? AND purpose = ?').get(email, purpose) as { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!row || row.expires_at < now() || row.attempts >= 5 || !/^\d{6}$/.test(code)) return false;
    const supplied = Buffer.from(getCodeHash(email, purpose, code), 'hex');
    const stored = Buffer.from(row.code_hash, 'hex');
    if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) {
      db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?').run(email, purpose);
      return false;
    }
    db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(email, purpose);
    return true;
  };
  const saveScore = (challenge: Challenge) => {
    db.prepare(`INSERT INTO scores(owner, language, difficulty, duration, nickname, speed, accuracy, correct, created_at, attempt_id)
      VALUES (@owner, @language, @difficulty, @duration, @nickname, @speed, @accuracy, @correct, @finished_at, @id)
      ON CONFLICT(owner, language, difficulty, duration) DO UPDATE SET
        nickname=excluded.nickname, speed=excluded.speed, accuracy=excluded.accuracy, correct=excluded.correct,
        created_at=excluded.created_at, attempt_id=excluded.attempt_id
      WHERE excluded.speed > scores.speed OR (excluded.speed = scores.speed AND excluded.accuracy > scores.accuracy)`)
      .run(challenge);
  };
  const asAdmin = (request: FastifyRequest) => {
    const user = userFor(request);
    return user && adminEmail && user.email.toLowerCase() === adminEmail ? user : null;
  };

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/me', async (request) => {
    const user = userFor(request);
    return { user: user ? publicUser(user) : null };
  });

  app.post('/api/auth/code', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const email = cleanEmail(body.email);
    const purpose = body.purpose;
    if (!emailPattern.test(email) || email.length > 254 || !['register', 'login', 'reset'].includes(String(purpose))) return invalid(reply, '请输入有效邮箱');
    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if ((purpose === 'register' && existingUser) || (purpose !== 'register' && !existingUser)) return { ok: true };
    const previous = db.prepare('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ?').get(email, purpose) as { created_at: number } | undefined;
    if (previous && now() - previous.created_at < 60_000) return invalid(reply, '请稍后再获取验证码', 429);
    if (!options.mailer) return invalid(reply, '邮件服务尚未配置，请稍后再试', 503);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try { await options.mailer.sendCode(email, code, String(purpose)); }
    catch { return invalid(reply, '邮件发送失败，请稍后再试', 503); }
    db.prepare(`INSERT INTO email_codes(email,purpose,code_hash,created_at,expires_at,attempts) VALUES (?,?,?,?,?,0)
      ON CONFLICT(email,purpose) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at,expires_at=excluded.expires_at,attempts=0`)
      .run(email, purpose, getCodeHash(email, String(purpose), code), now(), now() + 10 * 60_000);
    return { ok: true };
  });

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const email = cleanEmail(body.email);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const code = typeof body.code === 'string' ? body.code : '';
    if (!emailPattern.test(email) || email.length > 254 || !/^[\p{L}\p{N}_-]{3,24}$/u.test(username) || password.length < 10 || password.length > 128) return invalid(reply, '用户名需为 3–24 位字母、数字或下划线，密码至少 10 位');
    if (db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username)) return invalid(reply, '账号信息不可用，请检查后重试', 409);
    if (!consumeCode(email, 'register', code)) return invalid(reply, '验证码错误或已过期');
    const user: User = { id: randomUUID(), username, email, password_hash: await argon2.hash(password, { type: argon2.argon2id }) };
    db.prepare('INSERT INTO users(id,username,email,password_hash,created_at) VALUES (?,?,?,?,?)').run(user.id, user.username, user.email, user.password_hash, now());
    startSession(reply, user);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (identifier.length > 254 || password.length > 128) return invalid(reply, '账号或密码不正确', 401);
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(identifier, identifier.toLowerCase()) as User | undefined;
    if (!user || !(await argon2.verify(user.password_hash, password))) return invalid(reply, '账号或密码不正确', 401);
    startSession(reply, user);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login-code', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const email = cleanEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
    if (!user || !consumeCode(email, 'login', code)) return invalid(reply, '邮箱或验证码不正确', 401);
    startSession(reply, user);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/reset', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const email = cleanEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
    if (!user || password.length < 10 || password.length > 128 || !consumeCode(email, 'reset', code)) return invalid(reply, '邮箱、验证码或新密码不正确');
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    })();
    reply.clearCookie('session', cookieOptions);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.cookies.session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(request.cookies.session));
    reply.clearCookie('session', cookieOptions);
    return { ok: true };
  });

  app.post('/api/tests/start', async (request, reply) => {
    const body = bodyOf(request);
    const article = articles.find((item) => item.id === body.articleId);
    const duration = Number(body.duration);
    if (!article || !durations.includes(duration)) return invalid(reply, '请选择有效文章和时长');
    const owner = getOwner(request, reply)!;
    const rest = articles.filter((item) => item.language === article.language && item.difficulty === article.difficulty && item.id !== article.id);
    const target = [article, ...rest].map((item) => item.content).join(article.language === 'zh' ? '' : ' ');
    const id = randomUUID();
    db.prepare('INSERT INTO challenges(id,owner,language,difficulty,duration,target,started_at) VALUES (?,?,?,?,?,?,?)').run(id, owner, article.language, article.difficulty, duration, target, now());
    return { id, target, duration };
  });

  app.post('/api/tests/:id/finish', async (request, reply) => {
    const { id } = request.params as { id: string };
    const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as Challenge | undefined;
    const owner = getOwner(request, reply, false);
    if (!challenge || !owner || challenge.owner !== owner) return invalid(reply, '练习记录不存在', 404);
    if (challenge.status !== 'active') return invalid(reply, '这次成绩已经提交过', 409);
    const elapsed = now() - challenge.started_at;
    if (elapsed < challenge.duration * 1000 - 1000 || elapsed > challenge.duration * 1000 + 20_000) return invalid(reply, '测试时间无效，成绩无法上榜');
    const body = bodyOf(request);
    const typed = typeof body.typed === 'string' ? body.typed.normalize('NFC') : '';
    if (splitCharacters(typed).length > splitCharacters(challenge.target).length) return invalid(reply, '输入内容超过文章长度');
    const score = scoreTyping(challenge.target, typed, challenge.duration);
    const speed = challenge.language === 'zh' ? score.cpm : score.wpm;
    const suspicious = body.suspicious === true || (challenge.language === 'zh' ? speed > 400 : speed > 300);
    const status = suspicious ? 'review' : 'finished';
    db.prepare('UPDATE challenges SET finished_at=?,status=?,correct=?,total=?,accuracy=?,speed=? WHERE id=?').run(now(), status, score.correct, score.total, score.accuracy, speed, id);
    return { attemptId: id, score, status, eligible: score.correct > 0 };
  });

  app.post('/api/leaderboard', async (request, reply) => {
    const body = bodyOf(request);
    const challenge = typeof body.attemptId === 'string' ? db.prepare('SELECT * FROM challenges WHERE id = ?').get(body.attemptId) as Challenge | undefined : undefined;
    const owner = getOwner(request, reply, false);
    if (!challenge || !owner || challenge.owner !== owner) return invalid(reply, '练习记录不存在', 404);
    if (!['finished', 'review'].includes(challenge.status) || challenge.published) return invalid(reply, '这次成绩无法重复提交', 409);
    if (!challenge.finished_at || now() - challenge.finished_at > 10 * 60_000 || !challenge.correct) return invalid(reply, '成绩已过期或没有有效输入');
    const user = userFor(request);
    const nickname = user ? user.username : typeof body.nickname === 'string' ? body.nickname.trim() : '';
    if (splitCharacters(nickname).length < 1 || splitCharacters(nickname).length > 16 || /[\p{Cc}\p{Cf}]/u.test(nickname)) return invalid(reply, '昵称需为 1–16 个字符');
    db.prepare('UPDATE challenges SET nickname=?,published=1 WHERE id=?').run(nickname, challenge.id);
    challenge.nickname = nickname;
    if (challenge.status === 'finished') saveScore(challenge);
    return { status: challenge.status === 'review' ? 'review' : 'ranked' };
  });

  app.get('/api/leaderboard', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const language = query.language;
    const difficulty = query.difficulty;
    const duration = Number(query.duration);
    if (!['zh', 'en'].includes(language) || !difficulties.includes(difficulty as Difficulty) || !durations.includes(duration)) return invalid(reply, '请选择有效的排行榜');
    const entries = db.prepare(`SELECT nickname, speed, accuracy, attempt_id AS attemptId, created_at AS createdAt, CASE WHEN owner LIKE 'g:%' THEN 1 ELSE 0 END AS guest
      FROM scores WHERE language=? AND difficulty=? AND duration=? ORDER BY speed DESC, accuracy DESC, created_at ASC LIMIT 100`).all(language, difficulty, duration);
    return { entries };
  });

  app.get('/api/history', async (request, reply) => {
    const user = userFor(request);
    if (!user) return invalid(reply, '请先登录', 401);
    const entries = db.prepare(`SELECT language,difficulty,duration,correct,total,accuracy,speed,status,finished_at AS finishedAt
      FROM challenges WHERE owner=? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 100`).all(`u:${user.id}`);
    return { entries };
  });

  app.get('/api/admin/review', async (request, reply) => {
    if (!asAdmin(request)) return invalid(reply, '没有管理权限', 403);
    return { entries: db.prepare(`SELECT id,nickname,language,difficulty,duration,speed,accuracy,finished_at AS finishedAt FROM challenges WHERE status='review' AND published=1 ORDER BY finished_at DESC LIMIT 100`).all() };
  });
  app.post('/api/admin/review/:id', async (request, reply) => {
    if (!asAdmin(request)) return invalid(reply, '没有管理权限', 403);
    const { id } = request.params as { id: string };
    const action = bodyOf(request).action;
    const challenge = db.prepare("SELECT * FROM challenges WHERE id=? AND status='review' AND published=1").get(id) as Challenge | undefined;
    if (!challenge || !['approve', 'reject'].includes(String(action))) return invalid(reply, '记录或操作无效');
    db.transaction(() => {
      db.prepare('UPDATE challenges SET status=? WHERE id=?').run(action === 'approve' ? 'finished' : 'rejected', id);
      if (action === 'approve') saveScore(challenge);
    })();
    return { ok: true };
  });
  app.post('/api/admin/remove/:id', async (request, reply) => {
    if (!asAdmin(request)) return invalid(reply, '没有管理权限', 403);
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM scores WHERE attempt_id=?').run(id);
    return { ok: true };
  });

  if (options.staticRoot && existsSync(options.staticRoot)) {
    await app.register(staticFiles, { root: options.staticRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: '未找到页面' });
    });
  }
  return app;
}
