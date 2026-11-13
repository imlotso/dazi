import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { articles, difficulties, type Article, type Difficulty, type Language } from '../src/data/articles';
import { articleLength } from '../src/lib/analysis';
import type { AdminActor } from './admin';

type Audit = (actor: AdminActor, action: string, targetType: 'article', targetId: string, targetLabel: string, reason: string | null) => void;

const states = ['draft', 'published', 'archived'] as const;
type Status = typeof states[number];
type ArticleFields = Omit<Article, 'id' | 'content'> & { text: string };
type ArticleDetail = ArticleFields & { id: string; status: Status; revision: number; updatedAt: number; length: number };
type ArticleRow = Omit<ArticleDetail, 'source' | 'status'> & { source: string; status: Status | 'deleted' };

const singleLine = (max: number, min = 1) => z.string().trim().min(min).max(max).regex(/^[^\p{Cc}\p{Cf}\p{Cs}]*$/u);
const cleanText = (value: string) => value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').normalize('NFC').trim();
const normalizeSearch = (value: string) => value.normalize('NFKC').toLowerCase();
const searchText = (article: ArticleFields) => normalizeSearch([article.title, article.author, article.theme].join('\n'));
const bodyHash = (text: string) => createHash('sha256').update(text.normalize('NFC').trim().replace(/\s+/gu, ' ')).digest('hex');
const articleSchema = z.strictObject({
  title: singleLine(200),
  author: singleLine(300, 0).default(''),
  theme: singleLine(300, 0).default(''),
  language: z.enum(['zh', 'en']),
  difficulty: z.enum(difficulties),
  text: z.string().max(30_000).default('').transform(cleanText).pipe(z.string().max(30_000).refine((text) => (
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(text.replace(/[\n\t]/gu, ''))
  ))),
  source: z.strictObject({
    name: singleLine(300, 0).default(''),
    url: singleLine(2048, 0).default('').refine((input) => {
      if (!input) return true;
      if (!/^https?:\/\/[^/\s]/iu.test(input) || /[\s\\]/u.test(input)) return false;
      try {
        const url = new URL(input);
        return !!url.hostname && !url.username && !url.password;
      } catch { return false; }
    }),
    license: z.enum(['public-domain', 'reusable']).default('public-domain'),
  }).prefault({}),
});
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const reason = singleLine(300);
const editSchema = articleSchema.extend({ revision });
const statusSchema = z.strictObject({ status: z.enum(['published', 'archived']), revision, reason: reason.optional() });
const deleteSchema = z.strictObject({ revision, reason });
const pageNumber = (max: number, fallback: string) => z.string().regex(/^[1-9]\d{0,6}$/u).default(fallback)
  .transform(Number).pipe(z.number().max(max));
const listSchema = z.strictObject({
  q: z.string().trim().max(200).regex(/^[^\p{Cc}\p{Cf}\p{Cs}]*$/u).default('').transform(normalizeSearch),
  language: z.enum(['zh', 'en']).optional(),
  difficulty: z.enum(difficulties).optional(),
  status: z.enum(states).optional(),
  page: pageNumber(1_000_000, '1'),
  pageSize: pageNumber(100, '20'),
});

class CatalogError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

function detail({ source, ...row }: ArticleRow): ArticleDetail {
  return { ...row, source: JSON.parse(source) as Article['source'], status: row.status as Status };
}

function publicArticle({ id, title, author, theme, language, difficulty, text, source }: ArticleDetail): Article {
  return { id, title, author, theme, language, difficulty, content: text, source };
}

export function createCatalogStore(db: Database.Database, now: () => number) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_articles (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, theme TEXT NOT NULL,
      language TEXT NOT NULL, difficulty TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived', 'deleted')),
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, display_order INTEGER,
      length INTEGER NOT NULL, search_text TEXT NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_public_groups ON public_articles(language, difficulty) WHERE status='published';
    CREATE UNIQUE INDEX IF NOT EXISTS catalog_public_content ON public_articles(language, content_hash) WHERE status='published';
    CREATE TABLE IF NOT EXISTS public_article_groups (
      article_id TEXT NOT NULL REFERENCES public_articles(id), language TEXT NOT NULL, difficulty TEXT NOT NULL,
      PRIMARY KEY(article_id, language, difficulty)
    );
  `);

  const projection = 'id,title,author,theme,language,difficulty,text,source,status,revision,updated_at AS updatedAt,length';
  const listProjection = 'id,title,author,theme,language,difficulty,source,status,revision,updated_at AS updatedAt,length';
  const byId = db.prepare("SELECT " + projection + " FROM public_articles WHERE id=? AND status!='deleted'");
  const publicById = db.prepare("SELECT " + projection + " FROM public_articles WHERE id=? AND status='published'");
  const allPublic = db.prepare("SELECT " + projection + " FROM public_articles WHERE status='published' ORDER BY display_order IS NULL,display_order,updated_at,id");
  const recordGroup = db.prepare('INSERT OR IGNORE INTO public_article_groups(article_id,language,difficulty) VALUES (?,?,?)');
  const hasGroup = db.prepare('SELECT 1 FROM public_article_groups WHERE article_id=? AND language=? AND difficulty=?');
  const insert = db.prepare(
    'INSERT INTO public_articles(id,title,author,theme,language,difficulty,text,source,status,revision,updated_at,display_order,length,search_text,content_hash) ' +
    'VALUES (@id,@title,@author,@theme,@language,@difficulty,@text,@source,@status,1,@updatedAt,@displayOrder,@length,@searchText,@hash) ' +
    'ON CONFLICT(id) DO NOTHING'
  );
  const update = db.prepare(
    'UPDATE public_articles SET title=@title,author=@author,theme=@theme,language=@language,difficulty=@difficulty,text=@text,source=@source,' +
    'revision=revision+1,updated_at=@updatedAt,length=@length,search_text=@searchText,content_hash=@hash WHERE id=@id'
  );
  const setStatus = db.prepare('UPDATE public_articles SET status=?,revision=revision+1,updated_at=? WHERE id=?');
  const remove = db.prepare("UPDATE public_articles SET status='deleted',text='',search_text='',content_hash='',length=0,revision=revision+1,updated_at=? WHERE id=?");
  const remaining = db.prepare(
    "SELECT count(*) AS total, count(*) FILTER (WHERE difficulty=?) AS stage FROM public_articles WHERE language=? AND id!=? AND status='published'"
  );
  const duplicate = db.prepare("SELECT 1 FROM public_articles WHERE language=? AND content_hash=? AND status='published' AND id!=?");
  const countStatus = db.prepare("SELECT status, count(*) AS count FROM public_articles WHERE status!='deleted' GROUP BY status");
  const listWhere = "WHERE status!='deleted' AND (@status IS NULL OR status=@status) AND (@language IS NULL OR language=@language) " +
    'AND (@difficulty IS NULL OR difficulty=@difficulty) AND instr(search_text,@q)>0';
  const pageRows = db.prepare('SELECT ' + listProjection + ' FROM public_articles ' + listWhere + ' ORDER BY updated_at DESC,id LIMIT @pageSize OFFSET @offset');
  const countRows = db.prepare('SELECT count(*) AS total FROM public_articles ' + listWhere);

  function columns(fields: ArticleFields) {
    return {
      ...fields, source: JSON.stringify(fields.source), updatedAt: now(),
      length: articleLength(fields), searchText: searchText(fields), hash: bodyHash(fields.text),
    };
  }

  db.transaction(() => {
    articles.forEach(({ id, content, ...metadata }, displayOrder) => {
      if (insert.run({ ...columns({ ...metadata, text: content }), id, status: 'published', displayOrder }).changes) {
        recordGroup.run(id, metadata.language, metadata.difficulty);
      }
    });
  }).immediate();

  function find(id: string) {
    const row = byId.get(id) as ArticleRow | undefined;
    return row && detail(row);
  }

  function current(id: string, expected: number) {
    const found = find(id);
    if (!found) throw new CatalogError('文章不存在', 404);
    if (found.revision !== expected) throw new CatalogError('文章已更新，请重新打开', 409);
    return found;
  }

  function checkPublication(id: string, fields: ArticleFields) {
    if (!fields.author || !fields.theme || !fields.source.name || !fields.source.url) {
      throw new CatalogError('请填写作者、主题、来源名称和原文链接', 400);
    }
    if (articleLength(fields) < 1000) {
      throw new CatalogError(fields.language === 'zh' ? '中文正文须至少 1000 个汉字' : '英文正文须至少 1000 个单词', 400);
    }
    if (duplicate.get(fields.language, bodyHash(fields.text), id)) throw new CatalogError('已有相同正文的已发布文章', 409);
  }

  function checkCoverage(previous: ArticleDetail, replacement?: ArticleFields) {
    if (previous.status !== 'published') return;
    const sameLanguage = replacement?.language === previous.language;
    if (sameLanguage && replacement?.difficulty === previous.difficulty) return;
    const { total, stage } = remaining.get(previous.difficulty, previous.language, previous.id) as { total: number; stage: number };
    if (stage < 1 || total + Number(sameLanguage) < 20) {
      throw new CatalogError('每种语言须保留至少 20 篇已发布文章，并覆盖全部难度', 409);
    }
  }

  return {
    listPublic: () => (allPublic.all() as ArticleRow[]).map((row) => publicArticle(detail(row))),
    findPublished(id: unknown) {
      if (typeof id !== 'string' || id.length > 200) return undefined;
      const row = publicById.get(id) as ArticleRow | undefined;
      return row && publicArticle(detail(row));
    },
    hasHistorical: (id: string, language: Language, difficulty: Difficulty) => !!hasGroup.get(id, language, difficulty),
    counts() {
      const counts = { draft: 0, published: 0, archived: 0 };
      for (const { status, count } of countStatus.all() as { status: Status; count: number }[]) counts[status] = count;
      return counts;
    },
    find,
    list({ page, pageSize, q, language, difficulty, status }: z.output<typeof listSchema>) {
      const params = { q, language: language ?? null, difficulty: difficulty ?? null, status: status ?? null, pageSize, offset: (page - 1) * pageSize };
      const { total } = countRows.get(params) as { total: number };
      const entries = (pageRows.all(params) as Omit<ArticleRow, 'text'>[]).map(({ source, ...row }) => ({ ...row, source: JSON.parse(source) as Article['source'] }));
      return { page, pageSize, total, entries };
    },
    create: db.transaction((fields: ArticleFields, audit: Audit, actor: AdminActor) => {
      const id = 'public-' + randomUUID();
      insert.run({ ...columns(fields), id, status: 'draft', displayOrder: null });
      audit(actor, 'article.create', 'article', id, fields.title, null);
      return find(id)!;
    }).immediate,
    edit: db.transaction((id: string, { revision, ...fields }: z.output<typeof editSchema>, audit: Audit, actor: AdminActor) => {
      const previous = current(id, revision);
      if (previous.status === 'published') {
        checkPublication(id, fields);
        checkCoverage(previous, fields);
        recordGroup.run(id, fields.language, fields.difficulty);
      }
      update.run({ ...columns(fields), id });
      audit(actor, 'article.update', 'article', id, fields.title, null);
      return find(id)!;
    }).immediate,
    setStatus: db.transaction((id: string, input: z.output<typeof statusSchema>, audit: Audit, actor: AdminActor) => {
      const previous = current(id, input.revision);
      const publishing = input.status === 'published';
      if (publishing) {
        if (previous.status === 'published') throw new CatalogError('文章已发布', 409);
        checkPublication(id, previous);
        recordGroup.run(id, previous.language, previous.difficulty);
      } else {
        if (previous.status !== 'published') throw new CatalogError('仅可归档已发布文章', 409);
        checkCoverage(previous);
      }
      setStatus.run(input.status, now(), id);
      audit(actor, publishing ? 'article.publish' : 'article.archive', 'article', id, previous.title, input.reason ?? null);
      return find(id)!;
    }).immediate,
    remove: db.transaction((id: string, input: z.output<typeof deleteSchema>, audit: Audit, actor: AdminActor) => {
      const previous = current(id, input.revision);
      if (previous.status === 'published') throw new CatalogError('请先归档文章', 409);
      remove.run(now(), id);
      audit(actor, 'article.delete', 'article', id, previous.title, input.reason);
    }).immediate,
  };
}

export function registerCatalogRoutes(app: FastifyInstance, catalog: ReturnType<typeof createCatalogStore>, audit: Audit) {
  type ArticleRequest = { Params: { id: string } };
  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: '文章信息或筛选条件无效' });
  const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: '没有管理权限' });
  function change(reply: FastifyReply, action: () => unknown) {
    try { return action(); }
    catch (error) {
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 403) {
        return reply.code(403).send({ error: error.message });
      }
      if (!(error instanceof CatalogError)) throw error;
      return reply.code(error.statusCode).send({ error: error.message });
    }
  }

  app.get('/articles', async (request, reply) => {
    if (!request.admin) return forbidden(reply);
    const input = listSchema.safeParse(request.query);
    return input.success ? catalog.list(input.data) : invalid(reply);
  });
  app.get<ArticleRequest>('/articles/:id', async (request, reply) => {
    if (!request.admin) return forbidden(reply);
    const article = catalog.find(request.params.id);
    return article ? { article } : reply.code(404).send({ error: '文章不存在' });
  });
  app.post('/articles', async (request, reply) => {
    const actor = request.admin;
    if (!actor) return forbidden(reply);
    const input = articleSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    return change(reply, () => reply.code(201).send({ article: catalog.create(input.data, audit, actor) }));
  });
  app.post<ArticleRequest>('/articles/:id', async (request, reply) => {
    const actor = request.admin;
    if (!actor) return forbidden(reply);
    const input = editSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    return change(reply, () => ({ article: catalog.edit(request.params.id, input.data, audit, actor) }));
  });
  app.post<ArticleRequest>('/articles/:id/status', async (request, reply) => {
    const actor = request.admin;
    if (!actor) return forbidden(reply);
    const input = statusSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    return change(reply, () => ({ article: catalog.setStatus(request.params.id, input.data, audit, actor) }));
  });
  app.post<ArticleRequest>('/articles/:id/delete', async (request, reply) => {
    const actor = request.admin;
    if (!actor) return forbidden(reply);
    const input = deleteSchema.safeParse(request.body);
    if (!input.success) return invalid(reply);
    return change(reply, () => {
      catalog.remove(request.params.id, input.data, audit, actor);
      return { ok: true };
    });
  });
}
