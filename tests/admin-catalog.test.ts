import Database from 'better-sqlite3';
import { AsyncSqlite } from '../server/database/sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalogStore, registerCatalogRoutes } from '../server/catalog';
import { articles } from '../src/data/articles';

const actor = { id: 'admin', username: 'editor', authVersion: 0 };
const draft = {
  title: '旅行散记',
  author: '作者',
  theme: '成长',
  language: 'zh',
  difficulty: 'beginner',
  source: { name: '文库', url: 'https://example.test/work', license: 'reusable' },
  text: '一篇短稿',
};
const longText = articles.find((item) => item.language === 'zh')!.content + '\n这是一篇独立的测试稿。';
const seeded = articles.filter((item) => item.language === 'zh');
const archivePayload = { status: 'archived', revision: 1, reason: '校对原文' };

describe('public catalog administration', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let adapter: AsyncSqlite;
  let catalog: Awaited<ReturnType<typeof createCatalogStore>>;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE audit (action TEXT, target_id TEXT)');
    adapter = new AsyncSqlite(db);
    catalog = await createCatalogStore(adapter, () => 1_000);
    app = Fastify();
    // Production installs this hook on the entire admin API scope.
    await app.register(async (routes: FastifyInstance) => {
      routes.decorateRequest('admin');
      routes.addHook('preHandler', async (request, reply) => {
        const identity = request.headers.authorization;
        if (identity !== 'test-admin' && identity !== 'stale-admin') return reply.code(403).send();
        request.admin = identity === 'test-admin' ? actor : { ...actor, authVersion: -1 };
      });
      registerCatalogRoutes(routes, catalog, (actor, action, _type, id) => {
        if (actor.authVersion < 0) throw Object.assign(new Error('管理权限已变更'), { statusCode: 403 });
        db.prepare('INSERT INTO audit VALUES (?, ?)').run(action, id);
      });
    }, { prefix: '/api/admin' });
  });

  afterEach(async () => {
    await app.close();
    await adapter.close();
  });

  const get = (path: string) => app.inject({ method: 'GET', url: '/api/admin/articles' + path, headers: { authorization: 'test-admin' } });
  const post = (path: string, payload: object) => app.inject({ method: 'POST', url: '/api/admin/articles' + path, headers: { authorization: 'test-admin' }, payload });

  it('lists safe paged metadata and seeds the public catalog in its original order', async () => {
    expect((await catalog.listPublic())).toEqual(articles);
    const response = await get('?language=zh&status=published&page=2&pageSize=2');
    expect(response.statusCode).toBe(200);
    const { entries, page, pageSize, total } = response.json();
    expect([page, pageSize, total, entries.length]).toEqual([2, 2, seeded.length, 2]);
    expect(entries[0]).not.toHaveProperty('text');
    expect((await get('?q=%25')).json().total).toBe(0);
    expect((await get('?status=deleted')).statusCode).toBe(400);
    expect((await get('?page=0')).statusCode).toBe(400);
    expect((await get('?page=1&page=2')).statusCode).toBe(400);
    expect((await app.inject('/api/admin/articles')).statusCode).toBe(403);
  });

  it('supports draft editing and publication and rejects stale edits, short articles and duplicate text', async () => {
    const created = await post('', draft);
    expect(created.statusCode).toBe(201);
    const { article: { id } } = created.json();
    expect((await catalog.findPublished(id))).toBeUndefined();
    expect((await post('/' + id + '/status', { revision: 1, status: 'published' })).statusCode).toBe(400);
    const edited = await post('/' + id, { ...draft, text: longText, revision: 1 });
    expect(edited.json().article).toMatchObject({ text: longText, revision: 2, status: 'draft' });
    expect((await post('/' + id, { ...draft, text: longText, revision: 1 })).statusCode).toBe(409);
    const published = await post('/' + id + '/status', { revision: 2, status: 'published' });
    expect(published.json().article).toMatchObject({ revision: 3, status: 'published' });
    expect((await catalog.findPublished(id))).toMatchObject({ content: longText, source: draft.source });
    expect((await post('/' + id, { ...draft, revision: 3 })).statusCode).toBe(400);
    expect((await post('/' + id, { ...draft, revision: 3, text: seeded[0].content })).statusCode).toBe(409);
    expect((await post('/' + id + '/delete', { revision: 3, reason: '删除' })).statusCode).toBe(409);
    expect((await get('/' + id)).json().article).toMatchObject({ text: longText, revision: 3, status: 'published' });
    expect(db.prepare('SELECT action FROM audit').pluck().all()).toEqual(['article.create', 'article.update', 'article.publish']);
  });

  it('saves an incomplete draft and requires attribution before publication or editing a published article', async () => {
    const fields = { ...draft, author: '', theme: '', source: { ...draft.source, name: '', url: '' }, text: longText };
    const created = await post('', fields);
    expect(created.statusCode).toBe(201);
    const { article: { id } } = created.json();
    expect((await post('/' + id + '/status', { revision: 1, status: 'published' })).statusCode).toBe(400);
    expect((await post('/' + id, { ...draft, text: longText, revision: 1 })).statusCode).toBe(200);
    expect((await post('/' + id + '/status', { revision: 2, status: 'published' })).statusCode).toBe(200);
    expect((await post('/' + id, { ...fields, revision: 3 })).statusCode).toBe(400);
    expect((await catalog.findPublished(id))?.source).toEqual(draft.source);
  });

  it('keeps language coverage and historical groups while preserving archived and deleted state during startup', async () => {
    const archived = await post('/' + seeded[0].id + '/status', archivePayload);
    expect(archived.statusCode).toBe(200);
    expect((await catalog.findPublished(seeded[0].id))).toBeUndefined();
    expect((await post('/' + seeded[1].id + '/status', archivePayload)).statusCode).toBe(409);
    expect((await post('/' + seeded[1].id, {
      ...draft, revision: 1, text: articles.find((item) => item.language === 'en')!.content + ' Revised.', language: 'en',
    })).statusCode).toBe(409);
    expect((await post('/' + seeded[0].id + '/delete', { revision: 2, reason: '已归档' })).statusCode).toBe(200);
    const reopened = await createCatalogStore(adapter, () => 2_000);
    expect((await reopened.findPublished(seeded[0].id))).toBeUndefined();
    expect((await reopened.hasHistorical(seeded[0].id, 'zh', seeded[0].difficulty))).toBe(true);
    expect((await get('/' + seeded[0].id)).statusCode).toBe(404);
    expect((await reopened.counts())).toEqual({ draft: 0, archived: 0, published: articles.length - 1 });
  });

  it('preserves at least one published article in every difficulty when reclassifying', async () => {
    const beginners = seeded.filter((item) => item.difficulty === 'beginner');
    for (const { id, content, difficulty, ...fields } of beginners.slice(1)) {
      const moved = await post('/' + id, { ...fields, text: content, difficulty: 'intermediate', revision: 1 });
      expect(moved.statusCode).toBe(200);
      expect((await catalog.hasHistorical(id, 'zh', difficulty))).toBe(true);
      expect((await catalog.hasHistorical(id, 'zh', 'intermediate'))).toBe(true);
    }
    const [{ id, content, ...fields }] = beginners;
    expect((await post('/' + id, { ...fields, text: content, difficulty: 'intermediate', revision: 1 })).statusCode).toBe(409);
    expect((await post('/' + id + '/status', archivePayload)).statusCode).toBe(409);
    expect((await catalog.findPublished(id))?.difficulty).toBe('beginner');
  });

  it('counts English words rather than characters before publishing', async () => {
    const titleOnly = await post('', { title: 'A journey', language: 'en', difficulty: 'advanced' });
    expect(titleOnly.json().article).toMatchObject({ status: 'draft', text: '', author: '' });
    const fields = { ...draft, language: 'en', text: 'long-word '.repeat(999).trim() };
    const { article: { id, length } } = (await post('', fields)).json();
    expect(length).toBe(999);
    expect((await post('/' + id + '/status', { revision: 1, status: 'published' })).statusCode).toBe(400);
  });

  it('rejects invalid source URLs and rolls back mutations when audit fails', async () => {
    for (const url of ['javascript:alert(1)', 'https://a:b@example.test', 'https://example.test/\u0000']) {
      expect((await post('', { ...draft, source: { ...draft.source, url } })).statusCode).toBe(400);
    }
    expect((await post('', { ...draft, text: '字'.repeat(30_001) })).statusCode).toBe(400);
    expect((await post('', { ...draft, title: '\u0000' })).statusCode).toBe(400);
    const revoked = await app.inject({
      method: 'POST', url: '/api/admin/articles', headers: { authorization: 'stale-admin' }, payload: draft,
    });
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).toEqual({ error: '管理权限已变更' });
    expect((await catalog.counts()).draft).toBe(0);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'no audit'); END");
    expect((await post('', draft)).statusCode).toBe(500);
    expect((await catalog.counts()).draft).toBe(0);
  });
});
