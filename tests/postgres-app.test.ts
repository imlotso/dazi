import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { createApp } from '../server/app';
import { migratePostgres } from '../server/postgres/migrate';
import { PostgresDatabase } from '../server/postgres/database';
import { AsyncPostgres } from '../server/database/postgres';
import { seedPostgresCatalog } from '../server/postgres/seed';
import { createVercelHandler } from '../server/vercel';

const url = process.env.DAZI_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('the PostgreSQL application on independent instances', () => {
  let setup: pg.Client;
  let db: PostgresDatabase;
  let apps: Awaited<ReturnType<typeof createApp>>[] = [];
  let schema: string;
  let adminCookie: string;
  const codes = new Map<string, string>();
  const sent: string[] = [];
  let now = 1_800_000_000_000;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('This integration test requires disposable loopback PostgreSQL');
    setup = new pg.Client({ connectionString: url });
    await setup.connect();
    schema = 'dazi_app_test_' + randomBytes(8).toString('hex');
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await migratePostgres(setup, { database: parsed.pathname.slice(1), schema });
    db = new PostgresDatabase(url!, schema);
    await seedPostgresCatalog(new AsyncPostgres(db), () => now);
    apps = await Promise.all([0, 1].map(() => createApp({ databaseUrl: url, postgresSchema: schema,
      codeSecret: 'x'.repeat(32), secureCookies: false, adminEmail: 'admin@example.test', now: () => now,
      trustProxy: true, mailer: { async sendCode(email, code) { codes.set(email, code); sent.push(email); } },
    })));
  });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await db?.close();
    if (setup) {
      await setup.query('SET search_path TO public');
      if (schema) await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
      await setup.end();
    }
  });
  it('supports catalog, concurrent registration and single-use login codes across instances', async () => {
    const catalog = await apps[0].inject('/api/articles');
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().articles.length).toBeGreaterThanOrEqual(40);
    const email = 'admin@example.test';
    expect((await apps[0].inject({ method: 'POST', url: '/api/auth/code', payload: { email, purpose: 'register' } })).statusCode).toBe(200);
    const registration = { email, username: 'AdminUser', password: 'long-password-123', code: codes.get(email) };
    const registrations = await Promise.all(apps.map((app) => app.inject({ method: 'POST', url: '/api/auth/register', payload: registration })));
    expect(registrations.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(registrations.filter((response) => response.statusCode !== 200)).toHaveLength(1);
    const login = await apps[1].inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'adminuser', password: 'long-password-123' } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0].name + '=' + login.cookies[0].value;
    adminCookie = cookie;
    const settings = await apps[1].inject({ url: '/api/admin/settings/site', headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().revision).toBe(0);
    const changedSettings = { ...settings.json().settings, reviewThresholdZh: 201 };
    const writes = await Promise.all(apps.map((app) => app.inject({ method: 'POST', url: '/api/admin/settings/site',
      headers: { cookie }, payload: { revision: 0, settings: changedSettings } })));
    expect(writes.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const otherEmail = 'other@example.test';
    const codeRequests = await Promise.all(apps.map((app) => app.inject({ method: 'POST', url: '/api/auth/code',
      payload: { email: otherEmail, purpose: 'register' } })));
    expect(codeRequests.map((result) => result.statusCode).sort()).toEqual([200, 429]);
    expect(sent.filter((recipient) => recipient === otherEmail)).toHaveLength(1);
    expect((await apps[1].inject({ method: 'POST', url: '/api/auth/code', payload: { email, purpose: 'login' } })).statusCode).toBe(200);
    const logins = await Promise.all(apps.map((app) => app.inject({ method: 'POST', url: '/api/auth/login-code', payload: { email, code: codes.get(email) } })));
    expect(logins.map((result) => result.statusCode).sort()).toEqual([200, 401]);
    const other = await apps[0].inject({ method: 'POST', url: '/api/auth/register', payload: {
      email: otherEmail, username: 'other_user', password: 'long-password-123', code: codes.get(otherEmail),
    } });
    expect(other.statusCode).toBe(200);
    const otherCookie = other.cookies[0].name + '=' + other.cookies[0].value;
    const otherId = other.json().user.id;
    const [disabled, racingLogin] = await Promise.all([
      apps[0].inject({ method: 'POST', url: `/api/admin/users/${otherId}/status`, headers: { cookie }, payload: { status: 'disabled', reason: '测试' } }),
      apps[1].inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'other_user', password: 'long-password-123' } }),
    ]);
    expect(disabled.statusCode).toBe(200);
    expect((await apps[1].inject({ url: '/api/me', headers: { cookie: otherCookie } })).json().user).toBeNull();
    if (racingLogin.statusCode === 200) {
      const racingCookie = racingLogin.cookies[0].name + '=' + racingLogin.cookies[0].value;
      expect((await apps[0].inject({ url: '/api/me', headers: { cookie: racingCookie } })).json().user).toBeNull();
    } else expect(racingLogin.statusCode).toBe(401);
    expect((await apps[0].inject({ url: '/api/admin/scores', headers: { cookie } })).statusCode).toBe(200);
    const start = await apps[0].inject({ method: 'POST', url: '/api/tests/start', headers: { cookie },
      payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const challenge = start.json();
    for (const [advance, length] of [[15_000, 5], [15_000, 10], [15_000, 15], [10_000, 20]]) {
      now += advance;
      const checkpoint = await apps[1].inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie },
        payload: { typed: challenge.target.slice(0, length) } });
      expect(checkpoint.statusCode).toBe(200);
    }
    now += 5_000;
    const finish = await apps[0].inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie },
      payload: { typed: challenge.target.slice(0, 25) } });
    expect(finish.statusCode).toBe(200);
    const publications = await Promise.all(apps.map((app) => app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie },
      payload: { attemptId: challenge.id } })));
    expect(publications.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const rankings = await apps[0].inject({ url: '/api/leaderboard?language=zh&difficulty=beginner&duration=60', headers: { cookie } });
    expect(rankings.statusCode).toBe(200);
    expect(rankings.json().entries).toHaveLength(1);
    const items = Array.from({ length: 84 }, (_, index) => {
      const id = `large-${index.toString().padStart(3, '0')}`;
      return { kind: 'article', id, updatedAt: now, value: { id, title: id, text: '字'.repeat(20_000),
        language: 'zh', difficulty: 'beginner', custom: true } };
    });
    for (let offset = 0; offset < items.length; offset += 10) {
      const saved = await apps[offset % 2].inject({ method: 'POST', url: '/api/workspace/sync?paged=1', headers: { cookie },
        payload: { items: items.slice(offset, offset + 10) } });
      expect(saved.statusCode).toBe(200);
      expect(Buffer.byteLength(saved.body)).toBeLessThan(4 * 1024 * 1024);
    }
    let cursor: string | null = null;
    let totalBytes = 0;
    let count = 0;
    do {
      const query: URLSearchParams = new URLSearchParams({ paged: '1', ...(cursor && { cursor }) });
      const page = await apps[count % 2].inject({ url: `/api/workspace?${query}`, headers: { cookie } });
      expect(page.statusCode).toBe(200);
      expect(Buffer.byteLength(page.body)).toBeLessThan(4 * 1024 * 1024);
      totalBytes += Buffer.byteLength(page.body);
      const body: { items: unknown[]; nextCursor: string | null } = page.json();
      count += body.items.length;
      cursor = body.nextCursor;
    } while (cursor);
    expect(count).toBe(84);
    expect(totalBytes).toBeGreaterThan(4.5 * 1024 * 1024);
  });
  it('pauses and resumes active practice across PostgreSQL instances', async () => {
    const headers = { 'x-workspace-owner': 'guest', cookie: 'guest=' + randomBytes(32).toString('base64url') };
    const start = await apps[0].inject({ method: 'POST', url: '/api/tests/start', headers,
      payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const id = start.json().id;
    now += 5_000;
    expect((await apps[1].inject({ method: 'POST', url: `/api/tests/${id}/pause`, headers })).json()).toMatchObject({ elapsedMs: 5_000 });
    now += 3_000;
    expect((await apps[0].inject({ method: 'POST', url: `/api/tests/${id}/resume`, headers })).json()).toMatchObject({ elapsedMs: 5_000 });
  });
  it('does not finish an account attempt after session revocation commits', async () => {
    const email = 'racing@example.test';
    await apps[0].inject({ method: 'POST', url: '/api/auth/code', payload: { email, purpose: 'register' } });
    const registration = await apps[0].inject({ method: 'POST', url: '/api/auth/register', payload: {
      email, username: 'racing_user', password: 'long-password-123', code: codes.get(email),
    } });
    expect(registration.statusCode).toBe(200);
    const cookie = registration.cookies[0].name + '=' + registration.cookies[0].value;
    const userId = registration.json().user.id;
    const start = await apps[0].inject({ method: 'POST', url: '/api/tests/start', headers: { cookie },
      payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    now += 60_000;
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
      await lock.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', ['dazi.application.writer', schema]);
      const finish = apps[1].inject({ method: 'POST', url: `/api/tests/${start.json().id}/finish`, headers: { cookie },
        payload: { typed: start.json().target.slice(0, 5) } });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const state = await setup.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'");
        waiting = state.rows[0].count > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await lock.query('UPDATE users SET disabled_at=$1,auth_version=auth_version+1 WHERE id=$2', [now, userId]);
      await lock.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await lock.query('COMMIT');
      expect((await finish).statusCode).toBe(404);
      const row = await setup.query('SELECT status FROM challenges WHERE id=$1', [start.json().id]);
      expect(row.rows[0].status).toBe('active');
    } finally {
      try { await lock.query('ROLLBACK'); } catch { /* Already committed. */ }
      lock.release();
    }
  });
  it('uses the current review threshold when a finish waits behind a settings change', async () => {
    const headers = { 'x-workspace-owner': 'guest', cookie: 'guest=' + randomBytes(32).toString('base64url') };
    const start = await apps[0].inject({ method: 'POST', url: '/api/tests/start', headers,
      payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const challenge = start.json();
    for (const [advance, length] of [[15_000, 5], [15_000, 10], [15_000, 15], [10_000, 20]]) {
      now += advance;
      expect((await apps[0].inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers,
        payload: { typed: challenge.target.slice(0, length) } })).statusCode).toBe(200);
    }
    now += 5_000;
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query(`SET LOCAL search_path TO "${schema}",pg_catalog`);
      await lock.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', ['dazi.application.writer', schema]);
      const finish = apps[1].inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers,
        payload: { typed: challenge.target.slice(0, 25) } });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const state = await setup.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'");
        waiting = state.rows[0].count > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const settings = JSON.stringify({ registrationEnabled: true, guestPracticeEnabled: true, guestLeaderboardEnabled: true,
        reviewThresholdZh: 1, reviewThresholdEn: 180 });
      await lock.query(`INSERT INTO site_settings(id,settings,revision) VALUES (1,$1,1)
        ON CONFLICT(id) DO UPDATE SET settings=excluded.settings,revision=site_settings.revision+1`, [settings]);
      await lock.query('COMMIT');
      expect((await finish).json().status).toBe('review');
      const row = await setup.query('SELECT review_reasons FROM challenges WHERE id=$1', [challenge.id]);
      expect(JSON.parse(row.rows[0].review_reasons)).toContain('high_speed');
    } finally {
      try { await lock.query('ROLLBACK'); } catch { /* Already committed. */ }
      lock.release();
    }
  });
  it('stores typed control characters without losing the practice result', async () => {
    const headers = { 'x-workspace-owner': 'guest', cookie: 'guest=' + randomBytes(32).toString('base64url') };
    const start = await apps[0].inject({ method: 'POST', url: '/api/tests/start', headers,
      payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    now += 60_000;
    const finish = await apps[1].inject({ method: 'POST', url: `/api/tests/${start.json().id}/finish`, headers,
      payload: { typed: '\0' } });
    expect(finish.statusCode).toBe(200);
    expect((await setup.query("SELECT encode(typed,'hex') AS typed FROM challenges WHERE id=$1", [start.json().id])).rows[0].typed).toBe('00');
  });
  it('recovers interrupted guest practice and submits it for review', async () => {
    const id = randomUUID();
    const recoveryKey = randomBytes(32).toString('base64url');
    const headers = { 'x-workspace-owner': 'guest', cookie: 'guest=' + randomBytes(32).toString('base64url') };
    const start = await apps[0].inject({ method: 'POST', url: '/api/tests/start', headers,
      payload: { clientId: id, recoveryKey, articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const target: string = start.json().target;
    now += 20_000;
    const checkpoint = await apps[1].inject({ method: 'POST', url: `/api/tests/${id}/checkpoint`, headers,
      payload: { typed: target.slice(0, 5), elapsedMs: 18_000 } });
    expect(checkpoint.statusCode).toBe(200);
    const recovery = await apps[1].inject({ method: 'POST', url: '/api/tests/recover', headers, payload: {
      clientId: id, recoveryKey, articleId: 'zh-beginner-1', target, duration: 60, mode: 'timed', strict: false,
      elapsedMs: 9_000, draftId: `draft-${id}`,
    } });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).toMatchObject({ status: 'paused', elapsedMs: 18_000 });
    const finish = await apps[0].inject({ method: 'POST', url: `/api/tests/${id}/finish`, headers,
      payload: { typed: target.slice(0, 5), elapsedMs: 18_000 } });
    expect(finish.statusCode).toBe(200);
    expect((await apps[1].inject({ method: 'POST', url: '/api/leaderboard', headers,
      payload: { attemptId: id, nickname: '云朵' } })).json()).toEqual({ status: 'review' });
    const review = await apps[0].inject({ url: '/api/admin/review', headers: { cookie: adminCookie } });
    expect(review.statusCode).toBe(200);
    expect(review.json().entries).toContainEqual(expect.objectContaining({ id, reasons: expect.arrayContaining(['recovered_session']) }));
  });
  it('shares authentication limits between application instances', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.77' };
    const responses = await Promise.all(Array.from({ length: 9 }, (_, index) => apps[index % 2].inject({
      method: 'POST', url: '/api/auth/code', headers, payload: { email: 'invalid', purpose: 'register' },
    })));
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 400)).toHaveLength(8);
  });
  it('keeps large public catalog and history responses below the Function limit', async () => {
    await setup.query(`INSERT INTO public_articles(id,title,author,theme,language,difficulty,text,source,status,revision,updated_at,display_order,length,search_text,content_hash)
      SELECT 'bulk-'||n,'title','author','theme','zh','beginner',repeat('字',20000),'{}','published',1,1,100000+n,20000,'title','bulk-'||n FROM generate_series(1,84) n`);
    const user = (await setup.query("SELECT id FROM users WHERE email='admin@example.test'")).rows[0].id;
    await setup.query(`INSERT INTO challenges(id,owner,language,difficulty,duration,target,started_at,finished_at,status,article_metadata,typed)
      SELECT 'history-'||n,$1,'zh','beginner',60,repeat('字',20000),1,n,'finished',
      '{"id":"a","title":"标题","language":"zh","difficulty":"beginner","custom":false}',convert_to(repeat('字',20000),'UTF8') FROM generate_series(1,50) n`, ['u:' + user]);
    try {
      for (const [path, field, minimum] of [['/api/articles', 'articles', 120], ['/api/history', 'entries', 50]] as const) {
        let cursor: string | undefined;
        let bytes = 0;
        let count = 0;
        do {
          const headers: Record<string, string> = { cookie: adminCookie, 'x-list-paged': '1' };
          if (cursor) headers['x-list-cursor'] = cursor;
          const response = await apps[0].inject({ url: path, headers });
          expect(response.statusCode).toBe(200);
          const length = Buffer.byteLength(response.body);
          expect(length).toBeLessThan(4 * 1024 * 1024);
          bytes += length;
          const body = response.json();
          count += body[field].length;
          cursor = body.nextCursor ?? undefined;
        } while (cursor);
        expect(count).toBeGreaterThanOrEqual(minimum);
        expect(bytes).toBeGreaterThan(4.5 * 1024 * 1024);
      }
    } finally {
      await setup.query("DELETE FROM challenges WHERE id LIKE 'history-%'");
      await setup.query("DELETE FROM public_articles WHERE id LIKE 'bulk-%'");
    }
  });
  it('does not expose database errors in an unexpected server response', async () => {
    await setup.query('ALTER TABLE public_articles RENAME TO unavailable_articles');
    try {
      const response = await apps[0].inject('/api/articles');
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('public_articles');
      expect(response.body).not.toContain(schema);
      expect(response.body).not.toContain('disposable-local-test');
    } finally { await setup.query('ALTER TABLE unavailable_articles RENAME TO public_articles'); }
  });
  it('serves same-origin HTTP with secure cookies and recovers from a failed cold start', async () => {
    if (!(await setup.query("SELECT 1 FROM users WHERE username='AdminUser'")).rowCount) {
      await apps[0].inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'admin@example.test', purpose: 'register' } });
      const registration = await apps[0].inject({ method: 'POST', url: '/api/auth/register', payload: {
        email: 'admin@example.test', username: 'AdminUser', password: 'long-password-123', code: codes.get('admin@example.test'),
      } });
      expect(registration.statusCode).toBe(200);
    }
    const env = { DATABASE_URL: '', CODE_SECRET: 'x'.repeat(32), DAZI_DATABASE_SCHEMA: schema };
    const handler = createVercelHandler(env);
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const endpoint = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(endpoint + '/api/health')).status).toBe(503);
      env.DATABASE_URL = url!;
      const health = await fetch(endpoint + '/api/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const routed = await fetch(endpoint + '/api/handler?__dazi_path=health&path=health');
      expect(await routed.json()).toEqual({ ok: true });
      const routedLogin = await fetch(endpoint + '/api/handler?__dazi_path=auth%2Flogin&path=auth%2Flogin', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'adminuser', password: 'long-password-123' }),
      });
      expect(routedLogin.status).toBe(200);
      const login = await fetch(endpoint + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'adminuser', password: 'long-password-123' }) });
      expect(login.status).toBe(200);
      expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/);
      expect(login.headers.get('set-cookie')).toMatch(/Secure/);
      expect(login.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await handler.close();
    }
  });
});
