import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Database from 'better-sqlite3';
import argon2 from 'argon2';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { difficulties, type Difficulty, type Language } from '../src/data/articles';
import { scoreTyping, splitCharacters } from '../src/lib/scoring';
import { catalogSnapshotKey, type ArticleSnapshot, type PracticeMode, type RankingEntry } from '../src/lib/models';
import { createWorkspaceStore, syncBodyLimit, validateWorkspaceItems, WorkspaceLimitError } from './workspace';
import { AdminAccessError, createAdminAudit, migrateAdministration, registerAdminRoutes } from './admin';
import { createCatalogStore, registerCatalogRoutes } from './catalog';

export type Mailer = { sendCode(email: string, code: string, purpose: string): Promise<void> };
export type AppOptions = {
  databasePath: string;
  now?: () => number;
  secureCookies?: boolean;
  mailer?: Mailer;
  codeSecret?: string;
  adminEmail?: string;
  staticRoot?: string;
  trustProxy?: boolean;
};

type User = { id: string; username: string; email: string; password_hash: string; role: 'user' | 'admin'; auth_version: number };
type Challenge = {
  id: string; owner: string; language: Language; difficulty: Difficulty; duration: number;
  target: string; started_at: number; finished_at: number | null; status: string;
  correct: number | null; total: number | null; accuracy: number | null; speed: number | null;
  published: number; nickname: string | null;
  checkpoints: number; last_checkpoint_at: number | null; last_correct: number; activity_flag: number;
  review_reasons: string;
  elapsed_ms: number; active_started_at: number | null; pause_count: number;
  last_checkpoint_elapsed_ms: number | null; last_client_checkpoint_elapsed_ms: number | null;
  missing_client_checkpoint_time: number; last_checkpoint_total: number;
  backspaces: number; errors: number;
  article_id: string | null; article_metadata: string | null; typed: string | null;
  mode: PracticeMode; strict: number; ranking_removed: number;
};
type Input = Record<string, unknown>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const emailPattern = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const isValidDuration = (duration: number) => Number.isInteger(duration) && duration >= 60 && duration <= 3600 && duration % 60 === 0;
const durationMs = (challenge: Challenge) => challenge.mode === 'article' ? 24 * 60 * 60_000 : challenge.duration * 1000;
const isPracticeMode = (mode: unknown): mode is PracticeMode => mode === 'timed' || mode === 'article';
const isEligible = (challenge: Challenge) => (challenge.correct ?? 0) > 0 &&
  (challenge.mode !== 'article' || (
    challenge.total === splitCharacters(challenge.target).length && (!challenge.strict || challenge.correct === challenge.total)
  ));
const hasStrictProgress = (expected: string[], actual: string[]) =>
  actual.every((character, index) => character === expected[index] || index === actual.length - 1);
// Each pause cycle adds two network legs. Keep the extra allowance bounded.
const timingGraceMs = (challenge: Challenge) => 20_000 + Math.min(120_000, challenge.pause_count * 24_000);
const activeElapsed = (challenge: Challenge, time: number) =>
  challenge.elapsed_ms + (challenge.active_started_at === null ? 0 : Math.max(0, time - challenge.active_started_at));
const challengeTiming = (challenge: Challenge, time: number) => {
  const elapsedMs = Math.min(activeElapsed(challenge, time), durationMs(challenge));
  return { elapsedMs, remainingMs: durationMs(challenge) - elapsedMs };
};
const settledResult = (challenge: Challenge) => {
  if (challenge.status !== 'finished' && challenge.status !== 'review') return undefined;
  const correct = challenge.correct ?? 0;
  const total = challenge.total ?? 0;
  const seconds = challenge.elapsed_ms / 1000;
  const cpm = seconds > 0 ? correct * 60 / seconds : 0;
  return {
    attemptId: challenge.id,
    score: { correct, total, accuracy: challenge.accuracy ?? 0, cpm: Math.round(cpm * 100) / 100, wpm: Math.round(cpm / 5 * 100) / 100 },
    status: challenge.status,
    eligible: isEligible(challenge),
    elapsedMs: challenge.elapsed_ms,
  };
};
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
  const challengeColumns = new Set((db.pragma('table_info(challenges)') as Array<{ name: string }>).map((column) => column.name));
  db.transaction(() => {
    for (const [name, definition] of [
      ['checkpoints', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_checkpoint_at', 'INTEGER'],
      ['last_correct', 'INTEGER NOT NULL DEFAULT 0'],
      ['activity_flag', 'INTEGER NOT NULL DEFAULT 0'],
      ['review_reasons', "TEXT NOT NULL DEFAULT '[]'"],
      ['elapsed_ms', 'INTEGER NOT NULL DEFAULT 0'],
      ['active_started_at', 'INTEGER'],
      ['pause_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_checkpoint_elapsed_ms', 'INTEGER'],
      ['last_client_checkpoint_elapsed_ms', 'INTEGER'],
      ['missing_client_checkpoint_time', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_checkpoint_total', 'INTEGER NOT NULL DEFAULT 0'],
      ['backspaces', 'INTEGER NOT NULL DEFAULT 0'],
      ['errors', 'INTEGER NOT NULL DEFAULT 0'],
      ['article_id', 'TEXT'],
      ['article_metadata', 'TEXT'],
      ['typed', 'TEXT'],
      ['mode', "TEXT NOT NULL DEFAULT 'timed'"],
      ['strict', 'INTEGER NOT NULL DEFAULT 0'],
      ['ranking_removed', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!challengeColumns.has(name)) db.exec(`ALTER TABLE challenges ADD COLUMN ${name} ${definition}`);
    }
    if (!challengeColumns.has('active_started_at')) {
      db.exec("UPDATE challenges SET active_started_at=started_at WHERE status='active'");
    }
    if (!challengeColumns.has('elapsed_ms')) {
      db.exec('UPDATE challenges SET elapsed_ms=duration*1000, errors=MAX(0, COALESCE(total, 0)-COALESCE(correct, 0)) WHERE finished_at IS NOT NULL');
    }
    if (!challengeColumns.has('last_checkpoint_elapsed_ms')) {
      db.exec('UPDATE challenges SET last_checkpoint_elapsed_ms=MAX(0,last_checkpoint_at-started_at) WHERE last_checkpoint_at IS NOT NULL');
    }
    if (!challengeColumns.has('ranking_removed')) {
      // Legacy removals only deleted the best score row. Published attempts without
      // a score row are ambiguous, so preserve the visible legacy rankings.
      db.exec(`UPDATE challenges SET ranking_removed=1 WHERE published=1 AND status='finished'
        AND NOT EXISTS (SELECT 1 FROM scores WHERE scores.attempt_id=challenges.id)`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS challenges_rank
      ON challenges(language, difficulty, mode, strict, finished_at)
      WHERE published=1 AND status='finished' AND ranking_removed=0`);
  })();
  const workspace = createWorkspaceStore(db);
  migrateAdministration(db, adminEmail);
  const catalog = createCatalogStore(db, now);
  const audit = createAdminAudit(db, now);

  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, trustProxy: options.trustProxy ?? false });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute', allowList: (request) => !request.url.startsWith('/api/') });
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
    return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL').get(digest(token), now()) as User | undefined;
  };
  const expectedAccount = (request: FastifyRequest) => request.headers['x-workspace-owner'];
  const accountMatches = (request: FastifyRequest, user: User) =>
    expectedAccount(request) === undefined || expectedAccount(request) === user.id;
  const publicUser = (user: User) => ({ id: user.id, username: user.username, email: user.email, isAdmin: user.role === 'admin' });
  const startSession = (reply: FastifyReply, user: User) => {
    const token = randomBytes(32).toString('base64url');
    const inserted = db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) SELECT ?,id,? FROM users WHERE id=? AND password_hash=? AND auth_version=? AND disabled_at IS NULL')
      .run(digest(token), now() + 30 * 86400_000, user.id, user.password_hash, user.auth_version);
    if (!inserted.changes) return false;
    reply.setCookie('session', token, { ...cookieOptions, maxAge: 30 * 86400 });
    return true;
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
      db.prepare('UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND purpose=? AND code_hash=? AND attempts<5').run(email, purpose, row.code_hash);
      return false;
    }
    return db.prepare('DELETE FROM email_codes WHERE email=? AND purpose=? AND code_hash=? AND expires_at>=? AND attempts<5')
      .run(email, purpose, row.code_hash, now()).changes === 1;
  };
  const saveScore = (challenge: Pick<Challenge, 'id' | 'owner' | 'language' | 'difficulty' | 'duration' | 'nickname' | 'speed' | 'accuracy' | 'correct' | 'finished_at'>) => {
    db.prepare(`INSERT INTO scores(owner, language, difficulty, duration, nickname, speed, accuracy, correct, created_at, attempt_id)
      VALUES (@owner, @language, @difficulty, @duration, @nickname, @speed, @accuracy, @correct, @finished_at, @id)
      ON CONFLICT(owner, language, difficulty, duration) DO UPDATE SET
        nickname=excluded.nickname, speed=excluded.speed, accuracy=excluded.accuracy, correct=excluded.correct,
        created_at=excluded.created_at, attempt_id=excluded.attempt_id
      WHERE excluded.speed > scores.speed OR (excluded.speed = scores.speed AND excluded.accuracy > scores.accuracy)`)
      .run(challenge);
  };
  await app.register(async (admin) => {
    admin.decorateRequest('admin');
    const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      const user = userFor(request);
      if (!user || user.role !== 'admin') return invalid(reply, '没有管理权限', 403);
      if (!accountMatches(request, user)) return invalid(reply, '登录账号已变更', 403);
      request.admin = { id: user.id, username: user.username, authVersion: user.auth_version };
    };
    admin.addHook('onRequest', authorize);
    admin.addHook('preHandler', authorize);
    admin.setErrorHandler((error, _request, reply) => {
      if (error instanceof AdminAccessError) return invalid(reply, error.message, error.statusCode);
      return reply.send(error);
    });
    registerAdminRoutes(admin, { db, now, audit, publishedArticleCount: () => catalog.counts().published, saveScore });
    registerCatalogRoutes(admin, catalog, audit);
  }, { prefix: '/api/admin' });

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
    const existingUser = db.prepare('SELECT disabled_at FROM users WHERE email = ?').get(email) as { disabled_at: number | null } | undefined;
    if ((purpose === 'register' && existingUser) || (purpose !== 'register' && (!existingUser || existingUser.disabled_at !== null))) return { ok: true };
    const previous = db.prepare('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ?').get(email, purpose) as { created_at: number } | undefined;
    if (previous && now() - previous.created_at < 60_000) return invalid(reply, '请稍后再获取验证码', 429);
    if (!options.mailer) return invalid(reply, '邮件服务尚未配置，请稍后再试', 503);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = getCodeHash(email, String(purpose), code);
    const issuedAt = now();
    db.prepare(`INSERT INTO email_codes(email,purpose,code_hash,created_at,expires_at,attempts) VALUES (?,?,?,?,?,0)
      ON CONFLICT(email,purpose) DO UPDATE SET code_hash=excluded.code_hash,created_at=excluded.created_at,expires_at=excluded.expires_at,attempts=0`)
      .run(email, purpose, codeHash, issuedAt, issuedAt + 10 * 60_000);
    try { await options.mailer.sendCode(email, code, String(purpose)); }
    catch {
      db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ? AND code_hash = ?').run(email, purpose, codeHash);
      return invalid(reply, '邮件发送失败，请稍后再试', 503);
    }
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
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = db.transaction((): User | undefined => {
      if (db.prepare('SELECT id FROM users WHERE email=? OR username=?').get(email, username)) return undefined;
      const bootstrap = email === adminEmail && !db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
      const account: User = { id: randomUUID(), username, email, password_hash: passwordHash, role: bootstrap ? 'admin' : 'user', auth_version: 0 };
      db.prepare('INSERT INTO users(id,username,email,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
        .run(account.id, account.username, account.email, account.password_hash, account.role, now());
      return account;
    }).immediate();
    if (!user) return invalid(reply, '账号信息不可用，请检查后重试', 409);
    if (!startSession(reply, user)) return invalid(reply, '账号或密码不正确', 401);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (identifier.length > 254 || password.length > 128) return invalid(reply, '账号或密码不正确', 401);
    const user = db.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND disabled_at IS NULL').get(identifier, identifier.toLowerCase()) as User | undefined;
    if (!user || !(await argon2.verify(user.password_hash, password))) return invalid(reply, '账号或密码不正确', 401);
    if (!startSession(reply, user)) return invalid(reply, '账号或密码不正确', 401);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login-code', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const email = cleanEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND disabled_at IS NULL').get(email) as User | undefined;
    if (!user || !consumeCode(email, 'login', code)) return invalid(reply, '邮箱或验证码不正确', 401);
    if (!startSession(reply, user)) return invalid(reply, '邮箱或验证码不正确', 401);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/reset', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyOf(request);
    const email = cleanEmail(body.email);
    const code = typeof body.code === 'string' ? body.code : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND disabled_at IS NULL').get(email) as User | undefined;
    if (!user || password.length < 10 || password.length > 128 || !consumeCode(email, 'reset', code)) return invalid(reply, '邮箱、验证码或新密码不正确');
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const reset = db.transaction(() => {
      const changed = db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=? AND auth_version=? AND disabled_at IS NULL')
        .run(hash, user.id, user.auth_version).changes;
      if (!changed) return false;
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
      return true;
    }).immediate();
    if (!reset) return invalid(reply, '邮箱、验证码或新密码不正确');
    reply.clearCookie('session', cookieOptions);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const current = userFor(request);
    if (current && !accountMatches(request, current)) return invalid(reply, '登录账号已变更', 403);
    if (request.cookies.session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(request.cookies.session));
    // A delayed response from a former account must not erase a newer login cookie.
    // Scoped clients only revoke their token; an inert cookie is replaced on the next login.
    if (expectedAccount(request) === undefined) reply.clearCookie('session', cookieOptions);
    return { ok: true };
  });

  function workspaceResponse(request: FastifyRequest, owner: string, serverTime: number) {
    const items = workspace.get(owner);
    const known = request.headers['x-workspace-backgrounds'];
    if (typeof known !== 'string') return { items, serverTime };
    const backgrounds = items.filter((item) => item.kind === 'background');
    const version = createHash('sha256').update(owner).update(JSON.stringify(backgrounds)).digest('hex');
    const unchanged = known === version;
    return {
      items: unchanged ? items.filter((item) => item.kind !== 'background') : items,
      serverTime, backgroundsVersion: version, backgroundsUnchanged: unchanged,
    };
  }

  app.get('/api/workspace', async (request, reply) => {
    const user = userFor(request);
    if (!user) return invalid(reply, '请先登录', 401);
    if (!accountMatches(request, user)) return invalid(reply, '登录账号已变更', 403);
    reply.header('Cache-Control', 'no-store');
    return workspaceResponse(request, user.id, now());
  });

  app.post('/api/workspace/sync', { bodyLimit: syncBodyLimit }, async (request, reply) => {
    const user = userFor(request);
    if (!user) return invalid(reply, '请先登录', 401);
    if (!accountMatches(request, user)) return invalid(reply, '登录账号已变更', 403);
    const serverTime = now();
    const items = validateWorkspaceItems(bodyOf(request).items, user.id, serverTime);
    if (!items) return invalid(reply, '同步数据无效');
    try { workspace.merge(user.id, items); }
    catch (error) {
      if (error instanceof WorkspaceLimitError) return invalid(reply, '同步空间已满', 413);
      throw error;
    }
    reply.header('Cache-Control', 'no-store');
    return workspaceResponse(request, user.id, serverTime);
  });

  const findOwnedChallenge = (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const owner = getOwner(request, reply, false);
    if (!owner) return undefined;
    return db.prepare('SELECT * FROM challenges WHERE id=? AND owner=?').get(id, owner) as Challenge | undefined;
  };

  app.get('/api/articles', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { articles: catalog.listPublic().map(({ content, ...article }) => ({ ...article, text: content, custom: false })) };
  });

  app.post('/api/tests/start', async (request, reply) => {
    const expected = expectedAccount(request);
    if (expected !== undefined) {
      const user = userFor(request);
      if (!user && expected !== 'guest') return invalid(reply, '请先登录', 401);
      if (expected !== (user?.id ?? 'guest')) return invalid(reply, '登录账号已变更', 403);
    }
    const body = bodyOf(request);
    const article = catalog.findPublished(body.articleId);
    const duration = Number(body.duration);
    const mode = body.mode === undefined ? 'timed' : body.mode;
    const strict = body.strict === undefined ? false : body.strict;
    if (body.clientId !== undefined && (typeof body.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.clientId))) {
      return invalid(reply, '练习标识无效');
    }
    if (!article || !isValidDuration(duration)) return invalid(reply, '请选择有效文章和时长');
    if (body.articleKey !== undefined && body.articleKey !== catalogSnapshotKey({ ...article, text: article.content, custom: false })) {
      return invalid(reply, '文章已更新，请重新选择', 409);
    }
    if (!isPracticeMode(mode) || typeof strict !== 'boolean') return invalid(reply, '练习模式无效');
    const owner = getOwner(request, reply)!;
    const target = article.content;
    const id = body.clientId ?? randomUUID();
    const startedAt = now();
    const { content, ...articleMetadata } = article;
    const created = db.prepare(`INSERT INTO challenges(id,owner,language,difficulty,duration,target,started_at,active_started_at,article_id,article_metadata,mode,strict)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .run(id, owner, article.language, article.difficulty, duration, content, startedAt, startedAt, article.id,
        JSON.stringify({ ...articleMetadata, custom: false }), mode, Number(strict));
    if (!created.changes) return invalid(reply, '练习无法创建', 409);
    return { id, target, duration };
  });

  app.get('/api/tests/:id', async (request, reply) => {
    const challenge = findOwnedChallenge(request, reply);
    if (!challenge) return invalid(reply, '练习记录不存在', 404);
    const result = settledResult(challenge);
    return { status: challenge.status, ...challengeTiming(challenge, now()), duration: challenge.duration, ...(result && { result }) };
  });

  app.post('/api/tests/:id/pause', async (request, reply) => {
    const challenge = findOwnedChallenge(request, reply);
    if (!challenge) return invalid(reply, '练习记录不存在', 404);
    const time = now();
    if (challenge.status === 'paused') return challengeTiming(challenge, time);
    if (challenge.status !== 'active') return invalid(reply, '这次练习已经结束', 409);
    const elapsed = activeElapsed(challenge, time);
    if (elapsed > durationMs(challenge) + timingGraceMs(challenge)) return invalid(reply, '练习时间已结束', 409);
    const changed = db.prepare("UPDATE challenges SET status='paused',elapsed_ms=?,active_started_at=NULL,pause_count=pause_count+1 WHERE id=? AND status='active' AND active_started_at IS ? AND pause_count=?")
      .run(elapsed, challenge.id, challenge.active_started_at, challenge.pause_count).changes;
    if (!changed) return invalid(reply, '练习状态已变更', 409);
    return challengeTiming(challenge, time);
  });

  app.post('/api/tests/:id/resume', async (request, reply) => {
    const challenge = findOwnedChallenge(request, reply);
    if (!challenge) return invalid(reply, '练习记录不存在', 404);
    if (challenge.status !== 'paused') return invalid(reply, '这次练习未暂停', 409);
    const time = now();
    if (challenge.elapsed_ms > durationMs(challenge) + timingGraceMs(challenge)) return invalid(reply, '练习时间已结束', 409);
    const changed = db.prepare("UPDATE challenges SET status='active',active_started_at=? WHERE id=? AND status='paused' AND pause_count=?")
      .run(time, challenge.id, challenge.pause_count).changes;
    if (!changed) return invalid(reply, '练习状态已变更', 409);
    return challengeTiming(challenge, time);
  });

  app.post('/api/tests/:id/checkpoint', async (request, reply) => {
    const challenge = findOwnedChallenge(request, reply);
    if (!challenge) return invalid(reply, '练习记录不存在', 404);
    if (challenge.status !== 'active') return invalid(reply, '这次练习当前无法提交进度', 409);
    const time = now();
    const elapsed = activeElapsed(challenge, time);
    const body = bodyOf(request);
    let clientElapsed: number | null = null;
    if (body.elapsedMs !== undefined) {
      const reported = body.elapsedMs;
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0 ||
        reported > durationMs(challenge) || reported > elapsed + 1000 ||
        Math.round(reported) < (challenge.last_client_checkpoint_elapsed_ms ?? 0)) {
        return invalid(reply, '练习进度用时无效');
      }
      clientElapsed = Math.round(reported);
    }
    if (elapsed > durationMs(challenge) + 5000) return invalid(reply, '练习时间无效');
    const typed = body.typed;
    if (typeof typed !== 'string') return invalid(reply, '输入内容无效');
    const actual = splitCharacters(typed);
    const expected = splitCharacters(challenge.target);
    if (actual.length > expected.length || (challenge.strict && !hasStrictProgress(expected, actual))) return invalid(reply, '输入内容无效');
    if (elapsed > durationMs(challenge)) return { ok: true };
    const lastSampleElapsed = challenge.last_checkpoint_elapsed_ms;
    if (lastSampleElapsed !== null && elapsed - lastSampleElapsed < 2000) return invalid(reply, '提交过于频繁', 429);
    const { correct, total } = scoreTyping(challenge.target, typed, elapsed / 1000);
    const lastClientElapsed = challenge.last_client_checkpoint_elapsed_ms;
    const growth = correct - challenge.last_correct;
    if (clientElapsed !== null && clientElapsed === lastClientElapsed &&
      (growth > 0 || total > challenge.last_checkpoint_total)) {
      return invalid(reply, '练习进度增加时有效用时也必须增加');
    }
    const serverInterval = elapsed - (lastSampleElapsed ?? 0);
    const clientInterval = clientElapsed === null ? serverInterval : clientElapsed - (lastClientElapsed ?? 0);
    const interval = Math.max(0, Math.min(serverInterval, clientInterval) / 1000);
    const allowance = (challenge.language === 'zh' ? 8 : 32) * interval + 20;
    const flagged = challenge.activity_flag || growth > allowance ? 1 : 0;
    const changed = db.prepare(`UPDATE challenges SET checkpoints=checkpoints+1,last_checkpoint_at=?,last_checkpoint_elapsed_ms=?,
      last_client_checkpoint_elapsed_ms=COALESCE(?,last_client_checkpoint_elapsed_ms),
      missing_client_checkpoint_time=MAX(missing_client_checkpoint_time,?),last_correct=?,last_checkpoint_total=?,activity_flag=?
      WHERE id=? AND status='active' AND pause_count=? AND checkpoints=?`)
      .run(time, elapsed, clientElapsed, clientElapsed === null ? 1 : 0, correct, total, flagged, challenge.id, challenge.pause_count, challenge.checkpoints).changes;
    if (!changed) return invalid(reply, '练习状态已变更', 409);
    return { ok: true };
  });

  app.post('/api/tests/:id/finish', async (request, reply) => {
    const challenge = findOwnedChallenge(request, reply);
    if (!challenge) return invalid(reply, '练习记录不存在', 404);
    const existingResult = settledResult(challenge);
    if (existingResult) return existingResult;
    const paused = challenge.status === 'paused';
    if (!paused && challenge.status !== 'active') return invalid(reply, '这次成绩已经提交过', 409);
    const body = bodyOf(request);
    const time = now();
    const elapsed = activeElapsed(challenge, time);
    const limit = durationMs(challenge);
    let elapsedMs = Math.min(elapsed, limit);
    if (body.elapsedMs !== undefined) {
      const reported = body.elapsedMs;
      if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 1000 || reported > limit ||
        reported > elapsed + 1000 || Math.round(reported) < (challenge.last_client_checkpoint_elapsed_ms ?? 0)) {
        return invalid(reply, '有效用时无效');
      }
      elapsedMs = Math.round(reported);
    }
    if (elapsedMs < 1000 || elapsed > limit + timingGraceMs(challenge) ||
      (challenge.mode === 'timed' && !paused && body.early !== true && elapsedMs < limit)) {
      return invalid(reply, '测试时间无效，成绩无法上榜');
    }
    const typed = typeof body.typed === 'string' ? body.typed.normalize('NFC') : '';
    const actual = splitCharacters(typed);
    const expected = splitCharacters(challenge.target);
    const typedLength = actual.length;
    const targetLength = expected.length;
    if (typedLength > targetLength) return invalid(reply, '输入内容超过文章长度');
    const correctLast = !challenge.strict || actual.at(-1) === expected.at(-1);
    const articleComplete = typedLength === targetLength && correctLast;
    const requiresCompletion = !paused && (challenge.mode === 'article' || elapsedMs < limit);
    if (challenge.strict && !hasStrictProgress(expected, actual)) return invalid(reply, '请先纠正输入');
    if (requiresCompletion && !articleComplete) return invalid(reply, '请先完成当前文章');
    const backspaces = body.backspaces ?? 0;
    if (typeof backspaces !== 'number' || !Number.isSafeInteger(backspaces) || backspaces < 0) return invalid(reply, '退格次数无效');

    const score = scoreTyping(challenge.target, typed, elapsedMs / 1000);
    const speed = challenge.language === 'zh' ? score.cpm : score.wpm;
    const errors = score.total - score.correct;
    const minimumCheckpoints = Math.min(
      Math.floor(Math.max(0, elapsedMs - 3000) / 5000),
      Math.max(2, Math.floor(elapsedMs / 15_000) - 1),
    );
    const lastSampleElapsed = challenge.last_checkpoint_elapsed_ms;
    const observedElapsed = Math.min(elapsed, limit);
    const serverTail = observedElapsed - (lastSampleElapsed ?? 0);
    const lastClientElapsed = challenge.last_client_checkpoint_elapsed_ms;
    const clientTimed = body.elapsedMs !== undefined;
    const clientTail = clientTimed ? elapsedMs - (lastClientElapsed ?? 0) : serverTail;
    const sinceCheckpoint = Math.max(0, Math.min(serverTail, clientTail) / 1000);
    const finalAllowance = (challenge.language === 'zh' ? 5 : 16) * sinceCheckpoint + 10;
    const reasons: string[] = [];
    if (body.suspicious === true) reasons.push('paste_or_drop');
    if (challenge.activity_flag === 1 || score.correct - challenge.last_correct > finalAllowance) reasons.push('unusual_progress');
    if (challenge.checkpoints < minimumCheckpoints) reasons.push('missing_activity');
    const staleServerEvidence = lastSampleElapsed === null || serverTail > 10_000;
    const staleClientEvidence = clientTimed && (lastClientElapsed === null || clientTail > 10_000);
    if (minimumCheckpoints > 0 && (staleServerEvidence || staleClientEvidence)) reasons.push('stale_activity');
    if (challenge.language === 'zh' ? speed > 220 : speed > 180) reasons.push('high_speed');
    if (challenge.pause_count > 0) reasons.push('paused_session');
    if (clientTimed && (elapsed - elapsedMs > 3000 || challenge.missing_client_checkpoint_time)) reasons.push('timing_discrepancy');
    const status = reasons.length ? 'review' : 'finished';
    const changed = db.prepare(`UPDATE challenges SET finished_at=?,status=?,correct=?,total=?,accuracy=?,speed=?,review_reasons=?,elapsed_ms=?,active_started_at=NULL,backspaces=?,errors=?,typed=?
      WHERE id=? AND status=? AND published=0 AND pause_count=? AND checkpoints=?`)
      .run(time, status, score.correct, score.total, score.accuracy, speed, JSON.stringify(reasons), elapsedMs, backspaces, errors, typed,
        challenge.id, challenge.status, challenge.pause_count, challenge.checkpoints).changes;
    if (!changed) {
      const latest = findOwnedChallenge(request, reply);
      const result = latest && settledResult(latest);
      return result ?? invalid(reply, '练习状态已变更', 409);
    }
    const eligible = score.correct > 0 && (challenge.mode !== 'article' || articleComplete);
    return { attemptId: challenge.id, score, status, eligible, elapsedMs };
  });

  const publishScore = db.transaction((attemptId: string, owner: string, nickname: string) => {
    const challenge = db.prepare('SELECT * FROM challenges WHERE id=? AND owner=?').get(attemptId, owner) as Challenge | undefined;
    if (!challenge) return { error: '练习记录不存在', code: 404 } as const;
    if (!['finished', 'review'].includes(challenge.status) || challenge.published) return { error: '这次成绩无法重复提交', code: 409 } as const;
    if (!challenge.finished_at || now() - challenge.finished_at > 10 * 60_000 || !isEligible(challenge)) {
      return { error: '成绩已过期或没有有效输入', code: 400 } as const;
    }
    db.prepare('UPDATE challenges SET nickname=?,published=1 WHERE id=?').run(nickname, challenge.id);
    if (challenge.status === 'finished' && challenge.mode === 'timed' && !challenge.strict) saveScore({ ...challenge, nickname });
    return { status: challenge.status === 'review' ? 'review' : 'ranked' } as const;
  });

  app.post('/api/leaderboard', async (request, reply) => {
    const body = bodyOf(request);
    const owner = getOwner(request, reply, false);
    if (typeof body.attemptId !== 'string' || !owner) return invalid(reply, '练习记录不存在', 404);
    const user = userFor(request);
    const nickname = user ? user.username : typeof body.nickname === 'string' ? body.nickname.trim() : '';
    const maxNicknameLength = user ? 24 : 16;
    if (splitCharacters(nickname).length < 1 || splitCharacters(nickname).length > maxNicknameLength || /[\p{Cc}\p{Cf}]/u.test(nickname)) return invalid(reply, `昵称需为 1–${maxNicknameLength} 个字符`);
    const result = publishScore.immediate(body.attemptId, owner, nickname);
    return 'error' in result ? invalid(reply, result.error ?? '提交失败', result.code) : result;
  });

  app.get('/api/leaderboard', async (request, reply) => {
    if (expectedAccount(request) !== undefined) {
      const user = userFor(request);
      if (!user) return invalid(reply, '请先登录', 401);
      if (!accountMatches(request, user)) return invalid(reply, '登录账号已变更', 403);
    }
    const query = request.query as Record<string, string>;
    const { language, difficulty, period = 'all', articleId, mode = 'timed', strict = 'false' } = query;
    const duration = Number(query.duration);
    if (!['zh', 'en'].includes(language) || !difficulties.includes(difficulty as Difficulty) ||
      !['all', 'week', 'month'].includes(period) || !isPracticeMode(mode) || !['true', 'false'].includes(strict) ||
      (mode === 'timed' && !isValidDuration(duration)) ||
      (articleId !== undefined && !catalog.hasHistorical(articleId, language as Language, difficulty as Difficulty))) {
      return invalid(reply, '请选择有效的排行榜');
    }
    const owner = getOwner(request, reply, false);
    const since = period === 'all' ? 0 : now() - (period === 'week' ? 7 : 30) * 86_400_000;
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT id, owner, nickname, speed, accuracy, finished_at, article_id,
          ROW_NUMBER() OVER (PARTITION BY owner ORDER BY speed DESC, accuracy DESC, finished_at, id) AS owner_rank
        FROM challenges
        WHERE published=1 AND status='finished' AND ranking_removed=0 AND language=@language
          AND difficulty=@difficulty AND mode=@mode AND strict=@strict AND finished_at>=@since
          AND nickname IS NOT NULL AND speed IS NOT NULL
          AND (@duration IS NULL OR duration=@duration) AND (@articleId IS NULL OR article_id=@articleId)
      ), ranked AS (
        SELECT owner, nickname, speed, accuracy, id AS attemptId, finished_at AS createdAt, article_id AS articleId,
          CASE WHEN owner LIKE 'g:%' THEN 1 ELSE 0 END AS guest,
          ROW_NUMBER() OVER (ORDER BY speed DESC, accuracy DESC, finished_at, id) AS rank,
          COUNT(*) OVER () AS total
        FROM candidates WHERE owner_rank=1
      )
      SELECT * FROM ranked WHERE rank<=100 OR owner=@owner ORDER BY rank
    `).all({
      language, difficulty, mode, strict: Number(strict === 'true'), since, owner,
      duration: mode === 'timed' ? duration : null, articleId: articleId ?? null,
    }) as Array<Omit<RankingEntry, 'articleId'> & { owner: string; total: number; rank: number; articleId: string | null }>;
    const entries = rows.map(({ owner: rowOwner, total: _total, articleId, ...row }) => ({
      ...row, ...(articleId && { articleId }), mode, strict: strict === 'true', mine: rowOwner === owner,
    }));
    reply.header('Cache-Control', 'no-store');
    return { entries: entries.slice(0, 100), self: entries.find((entry) => entry.mine) ?? null, total: rows[0]?.total ?? 0 };
  });

  app.get('/api/history', async (request, reply) => {
    const user = userFor(request);
    if (!user) return invalid(reply, '请先登录', 401);
    if (!accountMatches(request, user)) return invalid(reply, '登录账号已变更', 403);
    const rows = db.prepare(`SELECT id AS recordId,language,difficulty,duration,correct,total,accuracy,speed,status,elapsed_ms AS elapsedMs,backspaces,errors,
      finished_at AS finishedAt,article_metadata AS metadata,target,typed,mode,strict
      FROM challenges WHERE owner=? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 100`).all(`u:${user.id}`) as Array<{
        metadata: string | null; target: string; typed: string | null; mode: PracticeMode; strict: number;
      }>;
    const entries = rows.map(({ metadata, target, typed, mode, strict, ...summary }) => {
      if (!metadata || typed === null) return summary;
      const article = { ...JSON.parse(metadata) as Omit<ArticleSnapshot, 'text'>, text: target };
      return { ...summary, article, typed, offset: 0, articleTotal: splitCharacters(target).length, mode, strict: !!strict };
    });
    reply.header('Cache-Control', 'no-store');
    return { entries };
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
