import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { catalogSnapshotKey, type ArticleSnapshot } from '../src/lib/models';

describe('administrator console API', () => {
  const password = 'test-password-123';
  const adminEmail = 'owner@example.test';
  const codes = new Map<string, string>();
  const now = 1_800_000_000_000;
  let path: string;
  let directory: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  const open = (configuredEmail = adminEmail) => createApp({
    databasePath: path, adminEmail: configuredEmail, secureCookies: false, now: () => now,
    mailer: { async sendCode(email, code, purpose) { codes.set(email + ':' + purpose, code); } },
  });
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'dazi-admin-'));
    path = join(directory, 'admin.sqlite');
    app = await open();
  });
  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    codes.clear();
  });

  async function register(username: string) {
    const email = username.toLowerCase() + '@example.test';
    expect((await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email, purpose: 'register' } })).statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST', url: '/api/auth/register', payload: { username, email, password, code: codes.get(email + ':register') },
    });
    expect(response.statusCode).toBe(200);
    return { cookie: response.cookies[0].value, ...response.json().user } as { id: string; email: string; username: string; isAdmin: boolean; cookie: string };
  }
  const get = (url: string, cookie?: string, owner?: string) => app.inject({
    url, headers: { ...(cookie && { cookie: 'session=' + cookie }), ...(owner && { 'x-workspace-owner': owner }) },
  });
  const post = (url: string, cookie: string, payload: object, origin?: string) => app.inject({
    method: 'POST', url, headers: { cookie: 'session=' + cookie, ...(origin && { origin }) }, payload,
  });
  const login = (identifier: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier, password } });

  it('authorizes every management read and write and rejects stale account identity and foreign origins', async () => {
    const user = await register('reader');
    const admin = await register('owner');
    for (const path of ['overview', 'users', 'users/' + user.id, 'articles', 'articles/zh-beginner-1', 'scores', 'audit', 'review']) {
      expect((await get('/api/admin/' + path)).statusCode).toBe(403);
      expect((await get('/api/admin/' + path, user.cookie)).statusCode).toBe(403);
    }
    for (const path of ['users/' + user.id + '/role', 'users/' + user.id + '/status', 'users/' + user.id + '/sessions/revoke', 'articles', 'articles/zh-beginner-1', 'articles/zh-beginner-1/status', 'articles/zh-beginner-1/delete', 'scores/moderate', 'remove/attempt', 'review/attempt']) {
      expect((await post('/api/admin/' + path, user.cookie, {})).statusCode).toBe(403);
    }
    expect((await get('/api/admin/overview', admin.cookie, user.id)).statusCode).toBe(403);
    expect((await post('/api/admin/users/' + user.id + '/status', admin.cookie, { status: 'disabled', reason: 'request' }, 'https://other.test')).statusCode).toBe(403);
    const overview = await get('/api/admin/overview', admin.cookie, admin.id);
    expect(overview.headers['cache-control']).toBe('no-store');
    expect(overview.json()).toMatchObject({ metrics: { users: 2, admins: 1, disabledUsers: 0, finishedPractices7d: 0, pendingScores: 0, publishedScores: 0, publishedArticles: 42 }, recentActions: [] });
  });

  it('lists account metadata with literal search, bounded pagination and no private data', async () => {
    const admin = await register('owner');
    const user = await register('reader_1');
    await register('readerX2');
    const users = await get('/api/admin/users?q=reader_&pageSize=1', admin.cookie);
    expect(users.json()).toEqual({ total: 1, page: 1, pageSize: 1, entries: [{ id: user.id, username: user.username, email: user.email, status: 'active', role: 'user', createdAt: now }] });
    expect((await get('/api/admin/users?page=0', admin.cookie)).statusCode).toBe(400);
    expect((await get('/api/admin/users?pageSize=101', admin.cookie)).statusCode).toBe(400);
    expect((await get('/api/admin/users/' + user.id, admin.cookie)).json()).toEqual({
      user: { ...users.json().entries[0], activeSessions: 1, finishedPractices: 0, publishedScores: 0, lastPracticeAt: null },
    });
  });

  it('revokes sessions on disable and role change, protects self and persists audit and roles', async () => {
    const owner = await register('owner');
    const reader = await register('reader');
    const pathFor = (id: string, action: string) => '/api/admin/users/' + id + '/' + action;
    const reason = '用户请求';
    expect((await post(pathFor(owner.id, 'status'), owner.cookie, { status: 'disabled', reason })).statusCode).toBe(409);
    expect((await post(pathFor(owner.id, 'role'), owner.cookie, { role: 'user', reason })).statusCode).toBe(409);
    expect((await post(pathFor(reader.id, 'status'), owner.cookie, { status: 'disabled', reason: '  ' })).statusCode).toBe(400);
    expect((await post(pathFor(reader.id, 'status'), owner.cookie, { status: 'disabled', reason })).statusCode).toBe(200);
    expect((await get('/api/me', reader.cookie)).json()).toEqual({ user: null });
    expect((await get('/api/workspace', reader.cookie)).statusCode).toBe(401);
    expect((await login('reader')).statusCode).toBe(401);
    expect((await post(pathFor(reader.id, 'role'), owner.cookie, { role: 'admin', reason })).statusCode).toBe(409);
    expect((await post(pathFor(reader.id, 'status'), owner.cookie, { status: 'active', reason })).statusCode).toBe(200);
    expect((await get('/api/me', reader.cookie)).json()).toEqual({ user: null });
    const loginBefore = await login('reader');
    expect(loginBefore.statusCode).toBe(200);
    expect((await post(pathFor(reader.id, 'role'), owner.cookie, { role: 'admin', reason })).statusCode).toBe(200);
    expect((await get('/api/me', loginBefore.cookies[0].value)).json()).toEqual({ user: null });
    const newAdmin = await login('reader');
    expect(newAdmin.json().user.isAdmin).toBe(true);
    await app.close();
    app = await open();
    expect((await get('/api/admin/overview', newAdmin.cookies[0].value)).statusCode).toBe(200);
    expect((await post(pathFor(owner.id, 'role'), newAdmin.cookies[0].value, { role: 'user', reason })).statusCode).toBe(200);
    expect((await get('/api/admin/overview', owner.cookie)).statusCode).toBe(403);
    expect((await login('owner')).json().user.isAdmin).toBe(false);
    const events = await get('/api/admin/audit?targetType=user', newAdmin.cookies[0].value);
    expect(events.json().entries.map((entry: { action: string }) => entry.action)).toEqual(['user.demote', 'user.promote', 'user.enable', 'user.disable']);
    expect(events.json().entries[0]).toMatchObject({ actorId: reader.id, targetId: owner.id, reason });
  });

  it('revokes all sessions independently of account status and role', async () => {
    const admin = await register('owner');
    const reader = await register('reader');
    const otherSession = await login(reader.username);
    const url = '/api/admin/users/' + reader.id + '/sessions/revoke';
    expect((await post(url, admin.cookie, {})).statusCode).toBe(400);
    expect((await post(url, admin.cookie, { reason: '用户设备遗失' })).statusCode).toBe(200);
    expect((await get('/api/me', reader.cookie)).json().user).toBeNull();
    expect((await get('/api/me', otherSession.cookies[0].value)).json().user).toBeNull();
    expect((await get('/api/admin/users/' + reader.id, admin.cookie)).json().user).toMatchObject({ status: 'active', role: 'user', activeSessions: 0 });
    expect((await login(reader.username)).statusCode).toBe(200);
    expect((await get('/api/admin/audit', admin.cookie)).json().entries[0]).toMatchObject({ action: 'user.revoke_sessions', reason: '用户设备遗失' });
  });

  it('bootstraps an existing verified account when first configured and revokes older sessions', async () => {
    await app.close();
    app = await open('');
    const owner = await register('owner');
    expect(owner.isAdmin).toBe(false);
    await app.close();
    app = await open();
    expect((await get('/api/me', owner.cookie)).json()).toEqual({ user: null });
    const fresh = await login('owner');
    expect(fresh.json().user.isAdmin).toBe(true);
    expect((await get('/api/admin/overview', fresh.cookies[0].value)).statusCode).toBe(200);
  });

  it('moderates a batch atomically, records explicit reasons and never returns typed text', async () => {
    const owner = await register('owner');
    const db = new Database(path);
    const insert = db.prepare(`INSERT INTO challenges(id,owner,language,difficulty,duration,target,typed,started_at,finished_at,status,correct,total,
      accuracy,speed,published,nickname,review_reasons,article_id,article_metadata)
      VALUES (?,'guest-secret','zh','beginner',60,'秘密练习原文','秘密输入',?,?,?,10,12,83,30,1,?,'["high_speed"]','zh-beginner-1','{"title":"示例文章"}')`);
    insert.run('pending-a', now - 1000, now, 'review', 'visitor-a');
    insert.run('pending-b', now - 1000, now, 'review', 'visitor-b');
    insert.run('published', now - 1000, now, 'finished', 'visitor-c');
    db.close();
    const moderate = (payload: object) => post('/api/admin/scores/moderate', owner.cookie, payload);
    expect((await moderate({ ids: ['pending-a'], action: 'approve', reason: ' ' })).statusCode).toBe(400);
    expect((await moderate({ ids: ['pending-a', 'published'], action: 'approve', reason: '核对完成' })).statusCode).toBe(409);
    expect((await moderate({ ids: ['pending-a', 'pending-a'], action: 'approve', reason: '核对完成' })).statusCode).toBe(400);
    const pending = await get('/api/admin/scores?status=pending&language=zh', owner.cookie);
    expect(pending.json().total).toBe(2);
    expect(pending.json().entries[0]).toMatchObject({ articleTitle: '示例文章', reasons: ['high_speed'], status: 'pending' });
    expect(pending.payload).not.toMatch(/秘密|guest-secret/);
    expect((await moderate({ ids: ['pending-a', 'pending-b'], action: 'approve', reason: '核对完成' })).json()).toEqual({ ok: true, count: 2 });
    expect((await moderate({ ids: ['pending-a'], action: 'remove', reason: '后续复核' })).json()).toEqual({ ok: true, count: 1 });
    expect((await get('/api/admin/scores?status=removed', owner.cookie)).json().entries[0]).toMatchObject({ id: 'pending-a', status: 'removed' });
    const events = await get('/api/admin/audit?targetType=score', owner.cookie);
    expect(events.json().entries).toMatchObject([{ action: 'score.remove', reason: '后续复核' }, { action: 'score.approve' }, { action: 'score.approve' }]);
  });

  it('keeps an active attempt on its original text and attribution through an edit and archival', async () => {
    const owner = await register('owner');
    const articleId = 'zh-beginner-2';
    const url = '/api/admin/articles/' + articleId;
    const { article } = (await get(url, owner.cookie)).json();
    const original = (await get('/api/articles')).json().articles.find((entry: ArticleSnapshot) => entry.id === articleId);
    const selection = { articleId, duration: 60, articleKey: catalogSnapshotKey(original) };
    const started = await post('/api/tests/start', owner.cookie, selection);
    expect(started.statusCode).toBe(200);
    const { id, target } = started.json();
    const { title, text, author, theme, language, difficulty, source, revision } = article;
    const edit = await post(url, owner.cookie, { title: title + '（更新）', text: text + '。', author, theme, language, difficulty, source, revision });
    expect(edit.statusCode).toBe(200);
    expect((await post('/api/tests/start', owner.cookie, selection)).statusCode).toBe(409);
    const archive = await post(url + '/status', owner.cookie, { status: 'archived', revision: edit.json().article.revision, reason: '整理文库' });
    expect(archive.statusCode).toBe(200);
    const finished = await post('/api/tests/' + id + '/finish', owner.cookie, { typed: target, early: true, elapsedMs: 1000 });
    expect(finished.statusCode).toBe(200);
    const { entries } = (await get('/api/history', owner.cookie)).json();
    expect(entries[0]).toMatchObject({ recordId: id, typed: original.text, article: original });
  });

  it('serves the published catalog and never starts a draft or archived article', async () => {
    const owner = await register('owner');
    const catalog = await get('/api/articles');
    expect(catalog.json().articles).toHaveLength(42);
    expect(catalog.json().articles[0]).toMatchObject({ id: 'zh-beginner-1', text: expect.any(String), custom: false });
    const archive = await post('/api/admin/articles/zh-beginner-2/status', owner.cookie, { status: 'archived', revision: 1, reason: '整理选文' });
    expect(archive.statusCode).toBe(200);
    expect((await get('/api/articles')).json().articles.find((article: { id: string }) => article.id === 'zh-beginner-2')).toBeUndefined();
    expect((await post('/api/tests/start', owner.cookie, { articleId: 'zh-beginner-2', duration: 60 })).statusCode).toBe(400);
    expect((await get('/api/leaderboard?language=zh&difficulty=beginner&duration=60&articleId=zh-beginner-2')).statusCode).toBe(200);
  });
});
