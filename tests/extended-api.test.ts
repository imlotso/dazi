import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createApp } from '../server/app';
import { splitCharacters } from '../src/lib/scoring';
import { pngFixture } from './background-fixture';

describe('extended practice API', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let now: number;
  let codes: Map<string, string>;
  const open = () => createApp({
    databasePath: join(directory, 'test.sqlite'),
    now: () => now,
    secureCookies: false,
    adminEmail: 'admin@example.com',
    mailer: { sendCode: async (email, code) => { codes.set(email, code); } },
  });

  beforeEach(async () => {
    now = 1_800_000_000_000;
    codes = new Map();
    directory = mkdtempSync(join(tmpdir(), 'dazi-extended-'));
    app = await open();
  });

  afterEach(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function register(username: string) {
    const email = username + '@example.com';
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email, purpose: 'register' } });
    const response = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email, username, password: 'long-password-123', code: codes.get(email) },
    });
    expect(response.statusCode).toBe(200);
    return { cookie: response.cookies[0].name + '=' + response.cookies[0].value };
  }

  function sync(items: unknown[], headers?: { cookie: string }) {
    return app.inject({ method: 'POST', url: '/api/workspace/sync', headers, payload: { items } });
  }

  function workspace(headers?: { cookie: string }) {
    return app.inject({ method: 'GET', url: '/api/workspace', headers });
  }

  it('does not let an outdated account view log out a newly signed-in account', async () => {
    const first = await register('first'); const second = await register('second');
    const me = (headers: { cookie: string }) => app.inject({ method: 'GET', url: '/api/me', headers });
    const firstId = (await me(first)).json().user.id;
    const secondId = (await me(second)).json().user.id;
    const rejected = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...second, 'x-workspace-owner': firstId }, payload: {} });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.cookies).toEqual([]);
    expect((await me(second)).json().user.id).toBe(secondId);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...second, 'x-workspace-owner': secondId }, payload: {} })).statusCode).toBe(200);
    expect((await me(second)).json().user).toBeNull();
  });

  it('does not overwrite a newer login cookie when an older scoped logout response arrives late', async () => {
    const first = await register('first');
    const firstId = (await app.inject({ method: 'GET', url: '/api/me', headers: first })).json().user.id;
    const delayedLogout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...first, 'x-workspace-owner': firstId }, payload: {} });
    expect(delayedLogout.statusCode).toBe(200);
    const second = await register('second');
    let sharedCookie = second.cookie;
    for (const cookie of delayedLogout.cookies) if (cookie.name === 'session') sharedCookie = cookie.name + '=' + cookie.value;
    const current = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sharedCookie } })).json().user;
    expect(current?.username).toBe('second');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: first })).json().user).toBeNull();
  });

  it('retains the newer tombstone through restart and isolates the workspace by account', async () => {
    expect((await workspace()).statusCode).toBe(401);
    expect((await sync([])).statusCode).toBe(401);
    const first = await register('first');
    const second = await register('second');
    const { user } = (await app.inject({ method: 'GET', url: '/api/me', headers: first })).json();
    const favorite = { kind: 'favorite', id: 'zh-beginner-1', updatedAt: now, value: { articleId: 'zh-beginner-1' } };
    const staleClient = { ...second, 'x-workspace-owner': user.id };
    expect((await workspace(staleClient)).statusCode).toBe(403);
    expect((await sync([favorite], staleClient)).statusCode).toBe(403);
    expect((await sync([{ ...favorite, ownerId: 'second' }], first)).json()).toEqual({ items: [favorite], serverTime: now });
    expect((await workspace(second)).json().items).toEqual([]);
    const deleted = { kind: favorite.kind, id: favorite.id, updatedAt: ++now, deleted: true };
    expect((await sync([deleted], first)).json().items).toEqual([deleted]);
    expect((await sync([favorite, { ...favorite, updatedAt: now }], first)).json().items).toEqual([deleted]);
    await app.close();
    app = await open();
    expect((await workspace(first)).json().items).toEqual([deleted]);
  });

  it('validates a workspace batch before persisting any of its items', async () => {
    const headers = await register('first');
    const favorite = { kind: 'favorite', id: 'zh-beginner-1', updatedAt: now, value: { articleId: 'zh-beginner-1' } };
    const oversized = { kind: 'article', id: 'private-1', updatedAt: now, value: {
      id: 'private-1', title: '长文', text: '字'.repeat(20_001), language: 'zh', difficulty: 'beginner', custom: true,
    } };
    for (const invalid of [oversized, { ...favorite, updatedAt: now + 86_400_000 }, { ...favorite, kind: 'leaderboard' }]) {
      expect((await sync([favorite, invalid], headers)).statusCode).toBe(400);
    }
    expect((await sync(Array(101).fill(favorite), headers)).statusCode).toBe(400);
    expect((await workspace(headers)).json().items).toEqual([]);
  });

  it('syncs private day/night backgrounds, validates images and preserves resets across restart', async () => {
    const owner = await register('background_owner');
    const other = await register('background_other');
    const value = {
      image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=',
      name: 'cloud.png', width: 1, height: 1, fit: 'cover', positionX: 50, positionY: 50, blur: 0, shade: 20,
    };
    const day = { kind: 'background', id: 'light', updatedAt: now, value };
    const night = { ...day, id: 'dark', value: { ...value, shade: 40 } };
    expect((await sync([day, night], owner)).statusCode).toBe(200);
    expect((await workspace(other)).json().items).toEqual([]);
    const firstHeaders = { ...owner, 'x-workspace-backgrounds': 'initial' };
    const first = (await workspace(firstHeaders)).json();
    expect(first.backgroundsVersion).toMatch(/^[a-f0-9]{64}$/);
    const knownHeaders = { ...owner, 'x-workspace-backgrounds': first.backgroundsVersion };
    const cached = (await workspace(knownHeaders)).json();
    expect(cached.backgroundsUnchanged).toBe(true);
    expect(cached.items).toEqual([]);
    expect((await sync([], knownHeaders)).json().items).toEqual([]);
    for (const invalid of [
      { ...day, id: 'arbitrary' },
      { ...day, value: { ...value, image: 'data:image/svg+xml;base64,PHN2Zz4=' } },
      { ...day, value: { ...value, image: 'https://example.com/image.png' } },
      { ...day, value: { ...value, image: value.image.replace('image/png', 'image/jpeg') } },
      { ...day, value: { ...value, image: 'data:image/png;base64,' + 'A'.repeat(1_100_000) } },
      { ...day, value: { ...value, shade: 100 } },
      { ...day, value: { ...value, image: pngFixture(10_000, 5000) } },
    ]) expect((await sync([invalid], owner)).statusCode).toBe(400);
    const deleted = { kind: 'background', id: 'light', updatedAt: ++now, deleted: true };
    expect((await sync([deleted], owner)).statusCode).toBe(200);
    expect((await workspace(knownHeaders)).json().backgroundsUnchanged).toBe(false);
    await sync([day], owner);
    await app.close(); app = await open();
    expect((await workspace(owner)).json().items).toEqual(expect.arrayContaining([deleted, night]));
    expect((await sync([{ ...day, updatedAt: ++now }], owner)).statusCode).toBe(200);
    expect((await workspace(owner)).json().items.find((item: { id: string }) => item.id === 'light').deleted).toBeUndefined();
  });

  it('preserves a draft tombstone against live uploads regardless of timestamps', async () => {
    const headers = await register('first');
    const draft = {
      id: 'draft-1', article: { id: 'private-1', title: '练习', text: '你好', language: 'zh', difficulty: 'beginner', custom: true },
      typed: '你', elapsedMs: 3000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0,
      recordId: 'record-1', offline: true, savedAt: now,
    };
    const live = { kind: 'draft', id: draft.id, updatedAt: now, value: draft };
    const deleted = { kind: 'draft', id: draft.id, updatedAt: now - 1, deleted: true };
    expect((await sync([live], headers)).json().items[0]).toMatchObject(live);
    expect((await sync([deleted], headers)).json().items).toEqual([deleted]);
    expect((await sync([{ ...live, updatedAt: now + 1 }], headers)).json().items).toEqual([deleted]);
  });

  it('keeps synced client records out of official scores', async () => {
    const headers = await register('first');
    const record = {
      kind: 'record', id: 'invented', updatedAt: now,
      value: { recordId: 'invented', language: 'zh', difficulty: 'beginner', duration: 60, speed: 100, accuracy: 100, finishedAt: now, status: 'finished' },
    };
    expect((await sync([record], headers)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/leaderboard', headers, payload: { attemptId: 'invented' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/leaderboard?language=zh&difficulty=beginner&duration=60', headers })).json()).toEqual({ entries: [], self: null, total: 0 });
  });

  it('binds account history and personalized ranks to the expected account when requested', async () => {
    const headers = await register('first');
    const { user } = (await app.inject({ method: 'GET', url: '/api/me', headers })).json();
    for (const url of ['/api/history', '/api/leaderboard?language=zh&difficulty=beginner&duration=60']) {
      expect((await app.inject({ url, headers: { 'x-workspace-owner': user.id } })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { ...headers, 'x-workspace-owner': 'stale-account' } })).statusCode).toBe(403);
      expect((await app.inject({ url, headers: { ...headers, 'x-workspace-owner': user.id } })).statusCode).toBe(200);
    }
  });

  it('binds a new practice attempt to the expected account or guest identity', async () => {
    const headers = await register('first');
    const { user } = (await app.inject({ method: 'GET', url: '/api/me', headers })).json();
    const attempt = (owner: string, cookies?: { cookie: string }) => app.inject({
      method: 'POST', url: '/api/tests/start', headers: { ...cookies, 'x-workspace-owner': owner },
      payload: { articleId: 'zh-beginner-1', duration: 60 },
    });
    expect((await attempt('guest', headers)).statusCode).toBe(403);
    expect((await attempt('stale-account', headers)).statusCode).toBe(403);
    expect((await attempt(user.id)).statusCode).toBe(401);
    expect((await attempt(user.id, headers)).statusCode).toBe(200);
    expect((await attempt('guest')).cookies[0]?.name).toBe('guest');
  });

  it('accepts local high-resolution active times and scopes saved drafts to the account', async () => {
    const headers = await register('first');
    const { user } = (await app.inject({ method: 'GET', url: '/api/me', headers })).json();
    const article = { id: 'private-1', title: '练习', text: '你好', language: 'zh', difficulty: 'beginner', custom: true };
    const draft = {
      id: 'private-1:f8924', recordId: 'draft-round', article, typed: '你', duration: 300, elapsedMs: 1234.56,
      backspaces: 1, offset: 0, mode: 'timed', strict: false, offline: true, savedAt: now, ownerId: 'another-user', suspicious: true,
    };
    const result = await sync([
      { kind: 'draft', id: draft.id, updatedAt: now, value: draft },
      { kind: 'record', id: 'result', updatedAt: now, value: {
        recordId: 'result', language: 'zh', difficulty: 'beginner', duration: 300, speed: 18_000_000, accuracy: 100, finishedAt: now, elapsedMs: 0.1,
      } },
    ], headers);
    expect(result.statusCode).toBe(200);
    expect(result.json().items[0].value).toEqual({ ...draft, ownerId: user.id });
    expect(result.json().items[1].value).toMatchObject({ elapsedMs: 0.1, speed: 18_000_000 });
  });

  async function start(headers: { cookie: string }, articleId: string, mode = 'timed', strict = false) {
    const response = await app.inject({ method: 'POST', url: '/api/tests/start', headers, payload: { articleId, duration: 60, mode, strict } });
    expect(response.statusCode).toBe(200);
    const { id, target } = response.json() as { id: string; target: string };
    const post = (path: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/tests/${id}/${path}`, headers, payload });
    const publish = () => app.inject({ method: 'POST', url: '/api/leaderboard', headers, payload: { attemptId: id } });
    return { id, target, post, publish };
  }

  it('validates strict correction and saves a whole-article attempt after its configured minutes', async () => {
    const headers = await register('first');
    const attempt = await start(headers, 'zh-beginner-1', 'article', true);
    const graphemes = splitCharacters(attempt.target);
    now += 61_000;
    expect((await attempt.post('checkpoint', { typed: '🧪' + graphemes[1], elapsedMs: 61_000 })).statusCode).toBe(400);
    expect((await attempt.post('checkpoint', { typed: '🧪', elapsedMs: 61_000 })).statusCode).toBe(200);
    expect((await attempt.post('finish', { typed: '🧪', elapsedMs: 61_000 })).statusCode).toBe(400);
    now += 3000;
    const wrongLast = graphemes.slice(0, -1).join('') + '🧪';
    expect((await attempt.post('checkpoint', { typed: wrongLast, elapsedMs: 64_000 })).statusCode).toBe(200);
    expect((await attempt.post('finish', { typed: wrongLast, elapsedMs: 64_000 })).statusCode).toBe(400);
    const finish = await attempt.post('finish', { typed: attempt.target, elapsedMs: 64_000 });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ eligible: true, elapsedMs: 64_000 });
    const history = await app.inject({ method: 'GET', url: '/api/history', headers });
    expect(history.json().entries[0]).toMatchObject({
      recordId: attempt.id, mode: 'article', strict: true, typed: attempt.target, offset: 0,
      total: graphemes.length, correct: graphemes.length, articleTotal: graphemes.length,
      article: { id: 'zh-beginner-1', custom: false, text: attempt.target, source: { license: 'public-domain' } },
    });
  });

  it('allows partial article-mode history when paused and keeps it ineligible for publication', async () => {
    const headers = await register('first');
    const attempt = await start(headers, 'zh-beginner-1', 'article');
    now += 61_000;
    expect((await attempt.post('pause')).json().elapsedMs).toBe(61_000);
    now += 300_000;
    const finish = await attempt.post('finish', { typed: attempt.target.slice(0, 3) });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ eligible: false, elapsedMs: 61_000 });
    expect((await attempt.post('finish')).json()).toEqual(finish.json());
    expect((await attempt.publish()).statusCode).toBe(400);
  });

  it('finishes strict timed attempts with a final uncorrected character at timeout or while paused', async () => {
    const headers = await register('first');
    for (const paused of [false, true]) {
      const attempt = await start(headers, 'zh-beginner-1', 'timed', true);
      const graphemes = splitCharacters(attempt.target);
      const typed = graphemes.slice(0, -1).join('') + '🧪';
      now += 30_000;
      expect((await attempt.post('finish', { typed, early: true })).statusCode).toBe(400);
      if (paused) expect((await attempt.post('pause')).statusCode).toBe(200);
      else now += 30_000;
      const finish = await attempt.post('finish', { typed });
      expect(finish.statusCode).toBe(200);
      expect(finish.json().score).toMatchObject({ total: graphemes.length, correct: graphemes.length - 1 });
    }
  });

  it('saves a paused strict article with a final uncorrected character as ineligible', async () => {
    const headers = await register('first');
    const attempt = await start(headers, 'zh-beginner-1', 'article', true);
    now += 30_000;
    expect((await attempt.post('pause')).statusCode).toBe(200);
    const typed = splitCharacters(attempt.target).slice(0, -1).join('') + '🧪';
    const finish = await attempt.post('finish', { typed });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().eligible).toBe(false);
    expect((await attempt.post('finish')).json()).toEqual(finish.json());
    expect((await attempt.publish()).statusCode).toBe(400);
  });

  it('selects each owner’s best attempt inside the requested filters and respects moderation', async () => {
    const headers = await register('admin');
    const complete = async (articleId: string, rate: number) => {
      const attempt = await start(headers, articleId);
      for (const seconds of [15, 30, 45, 55]) {
        now += seconds === 55 ? 10_000 : 15_000;
        expect((await attempt.post('checkpoint', { typed: attempt.target.slice(0, Math.floor(rate * seconds / 60)) })).statusCode).toBe(200);
      }
      now += 5000;
      expect((await attempt.post('finish', { typed: attempt.target.slice(0, rate) })).json().status).toBe('finished');
      expect((await attempt.publish()).json().status).toBe('ranked');
      return attempt.id;
    };
    const older = await complete('zh-beginner-1', 30);
    now += 8 * 86_400_000;
    const recent = await complete('zh-beginner-2', 20);
    const request = async (query = '') => {
      const response = await app.inject({ method: 'GET', url: '/api/leaderboard?language=zh&difficulty=beginner&duration=60' + query, headers });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    expect(await request('&period=week')).toMatchObject({
      total: 1, entries: [{ attemptId: recent, rank: 1, mine: true, articleId: 'zh-beginner-2' }],
      self: { attemptId: recent, rank: 1, mine: true },
    });
    expect((await request('&period=month')).entries[0].attemptId).toBe(older);
    expect((await request('&articleId=zh-beginner-2')).entries[0].attemptId).toBe(recent);
    expect((await request('&strict=true')).entries).toEqual([]);
    expect((await request('&mode=article')).entries).toEqual([]);
    await app.inject({ method: 'POST', url: '/api/admin/remove/' + older, headers, payload: { reason: '复核结果' } });
    await app.close();
    app = await open();
    expect((await request()).entries[0].attemptId).toBe(recent);
    expect((await request('&articleId=zh-beginner-1')).entries).toEqual([]);
  });

  it('returns the requester’s rank outside the first hundred and ignores article-mode duration', async () => {
    const guestToken = 'Z'.repeat(43);
    const owner = 'g:' + createHash('sha256').update(guestToken).digest('hex');
    const database = new Database(join(directory, 'test.sqlite'));
    const insert = database.prepare(`INSERT INTO challenges
      (id, owner, language, difficulty, duration, target, started_at, finished_at, status,
        speed, accuracy, published, nickname, mode, strict, article_id)
      VALUES (?, ?, 'en', 'beginner', ?, 'text', ?, ?, 'finished', ?, 100, 1, 'Cloud', 'article', 1, 'en-beginner-1')`);
    database.transaction(() => {
      for (let index = 0; index < 100; index++) insert.run('guest-' + index, 'g:guest-' + index, 60, now - 60_000, now, index + 2);
      insert.run('guest-self', owner, 3600, now - 120_000, now, 1);
    })();
    database.close();
    const response = await app.inject({
      method: 'GET', url: '/api/leaderboard?language=en&difficulty=beginner&duration=300&mode=article&strict=true',
      headers: { cookie: 'guest=' + guestToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toHaveLength(100);
    expect(response.json()).toMatchObject({
      total: 101, self: { attemptId: 'guest-self', rank: 101, mine: true, guest: 1, mode: 'article', strict: true },
    });
    expect(response.json().entries.every((entry: { mine: boolean }) => !entry.mine)).toBe(true);
  });

  it('keeps legacy history summaries and visible ranks without resurrecting removed attempts', async () => {
    const headers = await register('first');
    const { user } = (await app.inject({ method: 'GET', url: '/api/me', headers })).json();
    const owner = 'u:' + user.id;
    await app.close();
    const database = new Database(join(directory, 'test.sqlite'));
    database.exec(`
      DROP INDEX challenges_rank;
      ALTER TABLE challenges DROP COLUMN ranking_removed;
      ALTER TABLE challenges DROP COLUMN mode;
      ALTER TABLE challenges DROP COLUMN strict;
      ALTER TABLE challenges DROP COLUMN article_id;
      ALTER TABLE challenges DROP COLUMN article_metadata;
      ALTER TABLE challenges DROP COLUMN typed;
    `);
    const insert = database.prepare(`INSERT INTO challenges
      (id, owner, language, difficulty, duration, target, started_at, finished_at, status, speed, accuracy, correct, total, published, nickname)
      VALUES (?, ?, 'zh', 'beginner', 60, '你好', ?, ?, 'finished', ?, 100, 2, 2, 1, 'Cloud')`);
    insert.run('legacy-visible', owner, now - 60_000, now, 2);
    insert.run('legacy-removed', owner, now - 120_000, now - 60_000, 50);
    database.prepare(`INSERT INTO scores VALUES (?, 'zh', 'beginner', 60, 'Cloud', 2, 100, 2, ?, 'legacy-visible')`).run(owner, now);
    database.close();
    app = await open();
    const history = (await app.inject({ method: 'GET', url: '/api/history', headers })).json().entries;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ recordId: 'legacy-visible', total: 2, correct: 2 });
    expect(history[0]).not.toHaveProperty('article');
    const rankings = await app.inject({ method: 'GET', url: '/api/leaderboard?language=zh&difficulty=beginner&duration=60', headers });
    expect(rankings.json()).toMatchObject({ total: 1, self: { attemptId: 'legacy-visible' } });
  });
});
