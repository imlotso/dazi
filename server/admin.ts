import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { difficulties, type Difficulty, type Language } from '../src/data/articles';

export type AdminActor = { id: string; username: string; authVersion: number };
type TargetType = 'user' | 'article' | 'score';
export class AdminAccessError extends Error {
  readonly statusCode = 403;
  constructor() { super('管理权限已变更'); }
}
type Role = 'admin' | 'user';
type AccountStatus = 'active' | 'disabled';

declare module 'fastify' {
  interface FastifyRequest { admin: AdminActor }
}

const reasonField = z.string().trim().min(1).max(500).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const idField = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const scoreAction = z.enum(['approve', 'reject', 'remove']);
const scoreStatus = z.enum(['pending', 'published', 'rejected', 'removed']);
const roleField = z.enum(['admin', 'user']);
const statusField = z.enum(['active', 'disabled']);
const actionIds = z.array(idField).min(1).max(50).refine((ids) => new Set(ids).size === ids.length);
const moderation = z.strictObject({ ids: actionIds, action: scoreAction, reason: reasonField });
const reviewAction = z.strictObject({ action: z.enum(['approve', 'reject']), reason: reasonField });
const pagination = z.object({
  page: z.string().regex(/^[1-9]\d{0,5}$/).transform(Number).optional().default(1),
  pageSize: z.string().regex(/^(?:[1-9]\d?|100)$/).transform(Number).optional().default(20),
  q: z.string().trim().max(254).optional().default(''),
});
const userQuery = pagination.extend({ role: roleField.optional(), status: statusField.optional() });
const scoreQuery = pagination.extend({
  status: scoreStatus.optional(), language: z.enum(['zh', 'en']).optional(), difficulty: z.enum(difficulties).optional(),
});
const auditQuery = pagination.extend({ targetType: z.enum(['user', 'article', 'score']).optional() });
const accountStatus = z.strictObject({ status: statusField, reason: reasonField });
const accountRole = z.strictObject({ role: roleField, reason: reasonField });

const invalid = (reply: FastifyReply, message: string, status = 400) => reply.code(status).send({ error: message });
type PageQuery = z.output<typeof pagination>;
type SqlValues = Record<string, string | number | null>;
type Count = { count: number };
type UserSummary = Pick<AdminActor, 'id' | 'username'> & { email: string; role: Role; status: AccountStatus; createdAt: number };
const accountFields = "id,username,email,role,CASE WHEN disabled_at IS NULL THEN 'active' ELSE 'disabled' END AS status,created_at AS createdAt";
const auditFields = 'id,actor_id AS actorId,actor_name AS actorName,action,target_type AS targetType,target_id AS targetId,target_label AS targetLabel,reason,created_at AS createdAt';
const scoreState = "CASE WHEN status='review' THEN 'pending' WHEN status='rejected' THEN 'rejected' WHEN ranking_removed=1 THEN 'removed' ELSE 'published' END";

export function migrateAdministration(db: Database.Database, adminEmail: string) {
  db.transaction(() => {
    const columns = new Set((db.pragma('table_info(users)') as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has('role')) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))");
    }
    if (!columns.has('disabled_at')) db.exec('ALTER TABLE users ADD COLUMN disabled_at INTEGER');
    if (!columns.has('auth_version')) db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0');
    if (adminEmail && !db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) {
      const promoted = db.prepare("UPDATE users SET role='admin',auth_version=auth_version+1 WHERE email=? AND disabled_at IS NULL RETURNING id")
        .get(adminEmail) as { id: string } | undefined;
      if (promoted) {
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(promoted.id);
        db.prepare('DELETE FROM email_codes WHERE email=?').run(adminEmail);
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
        action TEXT NOT NULL, target_type TEXT NOT NULL CHECK (target_type IN ('user','article','score')),
        target_id TEXT NOT NULL, target_label TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit(target_type,id DESC);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS challenges_admin_scores ON challenges(finished_at DESC,id) WHERE published=1;
      CREATE INDEX IF NOT EXISTS challenges_recent_finished ON challenges(finished_at,owner) WHERE finished_at IS NOT NULL;
    `);
  }).immediate();
}

export function createAdminAudit(db: Database.Database, now: () => number) {
  const insert = db.prepare('INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,target_label,reason,created_at) VALUES (?,?,?,?,?,?,?,?)');
  const authorized = db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND disabled_at IS NULL AND auth_version=?");
  return (actor: AdminActor, action: string, targetType: TargetType, targetId: string, targetLabel: string, reason: string | null) => {
    if (!authorized.get(actor.id, actor.authVersion)) {
      throw new AdminAccessError();
    }
    insert.run(actor.id, actor.username, action, targetType, targetId, targetLabel, reason, now());
  };
}

type RankableChallenge = {
  id: string; owner: string; language: Language; difficulty: Difficulty; duration: number; mode: string; strict: number;
  nickname: string; speed: number; accuracy: number; correct: number; finished_at: number;
  status: string; ranking_removed: number;
};

type Options = {
  db: Database.Database;
  now: () => number;
  publishedArticleCount: () => number;
  audit: ReturnType<typeof createAdminAudit>;
  saveScore: (challenge: RankableChallenge) => void;
};

function listPage(db: Database.Database, query: PageQuery, from: string, fields: string, order: string, values: SqlValues) {
  const total = (db.prepare(`SELECT COUNT(*) AS count ${from}`).get(values) as Count).count;
  const entries = db.prepare(`SELECT ${fields} ${from} ORDER BY ${order} LIMIT @limit OFFSET @offset`).all({
    ...values, limit: query.pageSize, offset: (query.page - 1) * query.pageSize,
  });
  return { entries, total, page: query.page, pageSize: query.pageSize };
}

function decodeReasons(value: string) {
  try {
    const decoded: unknown = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.filter((reason): reason is string => typeof reason === 'string') : [];
  } catch { return []; }
}

export function registerAdminRoutes(app: FastifyInstance, { db, now, publishedArticleCount, audit, saveScore }: Options) {
  const findUser = db.prepare(`SELECT ${accountFields} FROM users WHERE id=?`);
  const auditRecent = db.prepare(`SELECT ${auditFields} FROM admin_audit ORDER BY id DESC LIMIT 8`);
  const summary = db.prepare(`
    SELECT (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabledUsers,
      (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled_at IS NULL) AS admins,
      (SELECT COUNT(DISTINCT owner) FROM challenges WHERE finished_at>=@since AND owner LIKE 'u:%') AS activeUsers7d,
      (SELECT COUNT(*) FROM challenges WHERE finished_at>=@since) AS finishedPractices7d,
      (SELECT COUNT(*) FROM challenges WHERE published=1 AND status='review') AS pendingScores,
      (SELECT COUNT(*) FROM challenges WHERE published=1 AND status='finished' AND ranking_removed=0) AS publishedScores
  `);
  const readAccountCounts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM sessions WHERE user_id=@id AND expires_at>@now) AS activeSessions,
      COUNT(finished_at) AS finishedPractices,
      COUNT(CASE WHEN published=1 AND status='finished' AND ranking_removed=0 THEN 1 END) AS publishedScores,
      MAX(finished_at) AS lastPracticeAt FROM challenges WHERE owner=@owner
  `);
  const activeAdmins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled_at IS NULL");
  const setStatus = db.prepare('UPDATE users SET disabled_at=?,auth_version=auth_version+1 WHERE id=?');
  const setRole = db.prepare('UPDATE users SET role=?,auth_version=auth_version+1 WHERE id=?');
  const revoke = db.prepare('DELETE FROM sessions WHERE user_id=?');
  const invalidateAuth = db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?');
  const revokeCodes = db.prepare('DELETE FROM email_codes WHERE email=?');

  const changeAccount = db.transaction((actor: AdminActor, id: string, change: z.output<typeof accountRole> | z.output<typeof accountStatus>) => {
    const user = findUser.get(id) as UserSummary | undefined;
    if (!user) return { error: '账号不存在', status: 404 } as const;
    const disabling = 'status' in change && change.status === 'disabled';
    const demoting = 'role' in change && change.role === 'user';
    if ((disabling || demoting) && actor.id === id) return { error: '无法停用自己的账号或撤销自己的管理权限', status: 409 } as const;
    if ((disabling || demoting) && user.role === 'admin' && user.status === 'active' && (activeAdmins.get() as Count).count <= 1) {
      return { error: '至少保留一个启用的管理员账号', status: 409 } as const;
    }
    if ('role' in change && change.role === 'admin' && user.status === 'disabled') return { error: '请先启用账号', status: 409 } as const;
    const unchanged = 'role' in change ? change.role === user.role : change.status === user.status;
    if (unchanged) return { error: '账号状态已变更，请刷新后重试', status: 409 } as const;
    if ('status' in change) {
      setStatus.run(disabling ? now() : null, id);
      audit(actor, disabling ? 'user.disable' : 'user.enable', 'user', id, user.username, change.reason);
    } else {
      setRole.run(change.role, id);
      audit(actor, demoting ? 'user.demote' : 'user.promote', 'user', id, user.username, change.reason);
    }
    revoke.run(id);
    revokeCodes.run(user.email);
    return { ok: true } as const;
  });

  app.get('/overview', async () => ({
    metrics: { ...summary.get({ since: now() - 7 * 86_400_000 }) as object, publishedArticles: publishedArticleCount() },
    recentActions: auditRecent.all(),
  }));

  app.get('/users', async (request, reply) => {
    const parsed = userQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, '用户筛选条件无效');
    const query = parsed.data;
    return listPage(db, query, `FROM users WHERE
      (@role IS NULL OR role=@role)
      AND (@status IS NULL OR (disabled_at IS NULL AND @status='active') OR (disabled_at IS NOT NULL AND @status='disabled'))
      AND (instr(lower(username),lower(@q))>0 OR instr(lower(email),lower(@q))>0 OR id=@q)`,
    accountFields, 'created_at DESC,id', { role: query.role ?? null, status: query.status ?? null, q: query.q });
  });

  app.get<{ Params: { id: string } }>('/users/:id', async (request, reply) => {
    const user = findUser.get(request.params.id) as UserSummary | undefined;
    if (!user) return invalid(reply, '账号不存在', 404);
    const counts = readAccountCounts.get({ id: user.id, owner: 'u:' + user.id, now: now() }) as object;
    return { user: { ...user, ...counts } };
  });

  app.post<{ Params: { id: string } }>('/users/:id/status', async (request, reply) => {
    const parsed = accountStatus.safeParse(request.body);
    if (!parsed.success) return invalid(reply, '请选择有效状态并填写原因');
    const result = changeAccount.immediate(request.admin, request.params.id, parsed.data);
    return 'error' in result ? invalid(reply, result.error ?? '操作未完成', result.status) : result;
  });

  app.post<{ Params: { id: string } }>('/users/:id/role', async (request, reply) => {
    const parsed = accountRole.safeParse(request.body);
    if (!parsed.success) return invalid(reply, '请选择有效角色并填写原因');
    const result = changeAccount.immediate(request.admin, request.params.id, parsed.data);
    return 'error' in result ? invalid(reply, result.error ?? '操作未完成', result.status) : result;
  });

  const revokeAccountSessions = db.transaction((actor: AdminActor, id: string, reason: string) => {
    const user = findUser.get(id) as UserSummary | undefined;
    if (!user) return { error: '账号不存在', status: 404 } as const;
    if (actor.id === id) return { error: '请从账号菜单退出登录', status: 409 } as const;
    invalidateAuth.run(id);
    revoke.run(id);
    revokeCodes.run(user.email);
    audit(actor, 'user.revoke_sessions', 'user', id, user.username, reason);
    return { ok: true } as const;
  });

  app.post<{ Params: { id: string } }>('/users/:id/sessions/revoke', async (request, reply) => {
    const parsed = z.strictObject({ reason: reasonField }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, '请填写退出会话原因');
    const result = revokeAccountSessions.immediate(request.admin, request.params.id, parsed.data.reason);
    return 'error' in result ? invalid(reply, result.error ?? '操作未完成', result.status) : result;
  });

  const scoreFields = `id,nickname,language,difficulty,article_id AS articleId,duration,mode,strict,speed,accuracy,
    checkpoints,review_reasons AS reviewReasons,finished_at AS finishedAt,${scoreState} AS status,
    CASE WHEN json_valid(article_metadata) THEN json_extract(article_metadata,'$.title') END AS articleTitle`;
  const scoreScope = "published=1 AND status IN ('review','finished','rejected') AND nickname IS NOT NULL AND finished_at IS NOT NULL";

  app.get('/scores', async (request, reply) => {
    const parsed = scoreQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, '成绩筛选条件无效');
    const query = parsed.data;
    const page = listPage(db, query, `FROM challenges WHERE ${scoreScope}
      AND (@status IS NULL OR ${scoreState}=@status) AND (@language IS NULL OR language=@language)
      AND (@difficulty IS NULL OR difficulty=@difficulty)
      AND (@q='' OR instr(lower(nickname),lower(@q))>0 OR id=@q OR article_id=@q
        OR instr(lower(CASE WHEN json_valid(article_metadata) THEN json_extract(article_metadata,'$.title') END),lower(@q))>0)`,
    scoreFields, 'finished_at DESC,id', {
      status: query.status ?? null, language: query.language ?? null, difficulty: query.difficulty ?? null, q: query.q,
    });
    return { ...page, entries: (page.entries as Array<{ reviewReasons: string; strict: number }>).map(({ reviewReasons, strict, ...row }) => ({
      ...row, strict: Boolean(strict), reasons: decodeReasons(reviewReasons),
    })) };
  });

  const findScore = db.prepare(`SELECT id,owner,language,difficulty,duration,mode,strict,nickname,speed,accuracy,correct,finished_at,status,ranking_removed
    FROM challenges WHERE id=? AND ${scoreScope}`);
  const setScoreStatus = db.prepare('UPDATE challenges SET status=? WHERE id=?');
  const flagRemoved = db.prepare('UPDATE challenges SET ranking_removed=1 WHERE id=?');
  const deleteScore = db.prepare('DELETE FROM scores WHERE attempt_id=?');
  const moderateScores = db.transaction((actor: AdminActor, { ids, action, reason }: z.output<typeof moderation>) => {
    const entries = ids.map((id) => findScore.get(id) as RankableChallenge | undefined);
    if (entries.some((entry) => !entry)) return { error: '成绩不存在，请刷新后重试', status: 404 } as const;
    for (const entry of entries as RankableChallenge[]) {
      const allowed = action === 'remove' ? entry.status === 'finished' && !entry.ranking_removed : entry.status === 'review';
      if (!allowed) return { error: '成绩状态已变更，请刷新后重试', status: 409 } as const;
    }
    for (const entry of entries as RankableChallenge[]) {
      if (action === 'remove') {
        flagRemoved.run(entry.id);
        deleteScore.run(entry.id);
      } else {
        setScoreStatus.run(action === 'approve' ? 'finished' : 'rejected', entry.id);
        if (action === 'approve' && entry.mode === 'timed' && !entry.strict) saveScore(entry);
      }
      audit(actor, `score.${action}`, 'score', entry.id, entry.nickname, reason);
    }
    return { ok: true, count: entries.length } as const;
  });

  function moderate(request: FastifyRequest, reply: FastifyReply, body: unknown) {
    const parsed = moderation.safeParse(body);
    if (!parsed.success) return invalid(reply, '请选择有效成绩并填写原因');
    const result = moderateScores.immediate(request.admin, parsed.data);
    return 'error' in result ? invalid(reply, result.error ?? '操作未完成', result.status) : result;
  }

  app.post('/scores/moderate', async (request, reply) => moderate(request, reply, request.body));
  app.get('/review', async () => {
    const rows = db.prepare(`SELECT id,nickname,language,difficulty,duration,speed,accuracy,checkpoints,review_reasons AS reviewReasons,finished_at AS finishedAt
      FROM challenges WHERE ${scoreScope} AND status='review' ORDER BY finished_at DESC,id LIMIT 100`).all() as Array<{ reviewReasons: string }>;
    return { entries: rows.map(({ reviewReasons, ...row }) => ({ ...row, reasons: decodeReasons(reviewReasons) })) };
  });
  app.post<{ Params: { id: string } }>('/review/:id', async (request, reply) => {
    const parsed = reviewAction.safeParse(request.body);
    if (!parsed.success) return invalid(reply, '请选择有效操作并填写原因');
    return moderate(request, reply, { ids: [request.params.id], ...parsed.data });
  });
  app.post<{ Params: { id: string } }>('/remove/:id', async (request, reply) => {
    const parsed = z.strictObject({ reason: reasonField }).safeParse(request.body);
    if (!parsed.success) return invalid(reply, '请填写下架原因');
    return moderate(request, reply, { ids: [request.params.id], action: 'remove', ...parsed.data });
  });

  app.get('/audit', async (request, reply) => {
    const parsed = auditQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply, '日志筛选条件无效');
    const query = parsed.data;
    return listPage(db, query, `FROM admin_audit WHERE (@target IS NULL OR target_type=@target)
      AND (@q='' OR instr(lower(actor_name),lower(@q))>0 OR instr(lower(target_label),lower(@q))>0
        OR instr(lower(reason),lower(@q))>0 OR target_id=@q)`,
    auditFields, 'id DESC', { target: query.targetType ?? null, q: query.q });
  });
}
