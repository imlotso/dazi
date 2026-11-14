import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { AsyncSqlite } from '../server/database/sqlite';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { createSiteSettings, registerSiteSettingsRoutes } from '../server/site-settings';
import { splitCharacters } from '../src/lib/scoring';

const url = '/api/admin/settings/site';
const defaults = {
  registrationEnabled: true,
  guestPracticeEnabled: true,
  guestLeaderboardEnabled: true,
  reviewThresholdZh: 220,
  reviewThresholdEn: 180,
};

describe('site settings', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let adapter: AsyncSqlite;
  let store: Awaited<ReturnType<typeof createSiteSettings>>;
  let audit: Parameters<typeof createSiteSettings>[1];

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE audit (actor_id TEXT, action TEXT, target_type TEXT, reason TEXT)');
    audit = async (actor, action, targetType, _targetId, _targetLabel, reason) => {
      if (actor.authVersion < 0) throw Object.assign(new Error('管理权限已变更'), { statusCode: 403 });
      db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(actor.id, action, targetType, reason);
    };
    adapter = new AsyncSqlite(db);
    store = await createSiteSettings(adapter, audit);
    app = Fastify();
    await app.register(async (routes: FastifyInstance) => {
      routes.decorateRequest('admin');
      routes.addHook('preHandler', async (request, reply) => {
        const identity = request.headers.authorization;
        if (identity !== 'admin' && identity !== 'stale-admin') return reply.code(403).send();
        request.admin = { id: 'admin', username: 'editor', authVersion: identity === 'admin' ? 0 : -1 };
      });
      registerSiteSettingsRoutes(routes, store);
    }, { prefix: '/api/admin' });
  });

  afterEach(async () => {
    await app.close();
    await adapter.close();
  });

  const read = () => app.inject({ method: 'GET', url, headers: { authorization: 'admin' } });
  const write = (settings: object, revision = 0, authorization = 'admin') => app.inject({
    method: 'POST', url, headers: { authorization }, payload: { settings, revision },
  });

  it('keeps the original defaults, persists changes and audits the previous and new values', async () => {
    expect((await read()).json()).toEqual({ settings: defaults, revision: 0 });
    const next = { ...defaults, registrationEnabled: false, guestPracticeEnabled: false, guestLeaderboardEnabled: false, reviewThresholdZh: 200 };
    expect((await write(next)).json()).toEqual({ settings: next, revision: 1 });
    expect(await (await createSiteSettings(adapter, audit)).read()).toEqual({ settings: next, revision: 1 });
    expect((await write(next, 1)).json()).toEqual({ settings: next, revision: 1 });
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([{
      actor_id: 'admin', action: 'settings.site.update', target_type: 'setting',
      reason: '开放注册（开启 → 关闭）、游客新开在线练习（开启 → 关闭）、游客提交排行榜（开启 → 关闭）、中文速度复核阈值（220 → 200）',
    }]);
  });

  it('rejects invalid fields, stale writes, and users without management access', async () => {
    expect((await app.inject(url)).statusCode).toBe(403);
    expect((await write(defaults, 0, 'user')).statusCode).toBe(403);
    expect((await write({ ...defaults, reviewThresholdEn: 0 })).statusCode).toBe(400);
    expect((await write({ ...defaults, reviewThresholdEn: 1001 })).statusCode).toBe(400);
    expect((await write({ ...defaults, reviewThresholdEn: 75.5 })).statusCode).toBe(400);
    expect((await write({ ...defaults, reviewThresholdZh: '220' })).statusCode).toBe(400);
    expect((await write({ ...defaults, extra: false })).statusCode).toBe(400);
    expect((await write(defaults, 99)).statusCode).toBe(409);
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([]);
    expect(await store.read()).toEqual({ settings: defaults, revision: 0 });
  });

  it('rolls back settings if the audit recheck finds revoked administrator access', async () => {
    expect((await write({ ...defaults, guestPracticeEnabled: false }, 0, 'stale-admin')).statusCode).toBe(403);
    expect(await store.read()).toEqual({ settings: defaults, revision: 0 });
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([]);
  });
});

describe('site settings on the production API', () => {
  const adminEmail = 'owner@example.test';
  const password = 'test-password-123';
  const codes = new Map<string, string>();
  const guest = { 'x-workspace-owner': 'guest', cookie: 'guest=' + randomBytes(32).toString('base64url') };
  let now: number;
  let app: Awaited<ReturnType<typeof createApp>>;
  let admin: Record<string, string>;

  const post = (path: string, payload: object = {}, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: path, payload, headers,
  });
  const requestCode = (email: string, purpose = 'register') => post('/api/auth/code', { email, purpose });
  const register = (email: string) => post('/api/auth/register', {
    email, username: email.split('@')[0], password, code: codes.get(`${email}:register`),
  });

  beforeEach(async () => {
    now = 1_800_000_000_000;
    codes.clear();
    app = await createApp({
      databasePath: ':memory:', now: () => now, secureCookies: false, adminEmail,
      mailer: { async sendCode(email, code, purpose) { codes.set(`${email}:${purpose}`, code); } },
    });
    expect((await requestCode(adminEmail)).statusCode).toBe(200);
    const response = await register(adminEmail);
    expect(response.statusCode).toBe(200);
    admin = { 'x-workspace-owner': response.json().user.id, cookie: 'session=' + response.cookies.find((cookie) => cookie.name === 'session')!.value };
  });

  afterEach(async () => { await app.close(); });

  async function changeSettings(settings: Partial<typeof defaults>, revision = 0) {
    const response = await post(url, { settings: { ...defaults, ...settings }, revision }, admin);
    expect(response.statusCode).toBe(200);
    expect(response.json().revision).toBe(revision + 1);
  }

  const start = (language: 'zh' | 'en', headers: Record<string, string> = guest) =>
    post('/api/tests/start', { articleId: `${language}-beginner-1`, duration: 60 }, headers);

  async function finishPaused(id: string, target: string, headers: Record<string, string> = guest) {
    now += 2_000;
    expect((await post(`/api/tests/${id}/pause`, {}, headers)).statusCode).toBe(200);
    const finished = await post(`/api/tests/${id}/finish`, { typed: splitCharacters(target).slice(0, 4).join('') }, headers);
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({ eligible: true, score: { cpm: 120, wpm: 24 } });
  }

  it('enforces closed registration with an already-issued code and keeps existing account login working', async () => {
    const newEmail = 'reader@example.test';
    expect((await requestCode(newEmail)).statusCode).toBe(200);
    expect((await app.inject({ url, headers: admin })).headers['cache-control']).toBe('no-store');
    await changeSettings({ registrationEnabled: false });
    expect((await requestCode('other@example.test')).statusCode).toBe(403);
    expect(codes.has('other@example.test:register')).toBe(false);
    expect((await register(newEmail)).statusCode).toBe(403);
    expect((await requestCode(adminEmail, 'login')).statusCode).toBe(200);
    expect(codes.has(`${adminEmail}:login`)).toBe(true);
    expect((await post('/api/auth/login', { identifier: adminEmail, password })).statusCode).toBe(200);
  });

  it('leaves a valid code usable when registration closes while the password is being hashed', async () => {
    const email = 'reader@example.test';
    expect((await requestCode(email)).statusCode).toBe(200);
    const hash = argon2.hash.bind(argon2);
    const hashing = vi.spyOn(argon2, 'hash').mockImplementationOnce(async (value, options) => {
      await changeSettings({ registrationEnabled: false });
      return hash(value, options);
    });
    try {
      expect((await register(email)).statusCode).toBe(403);
      expect(hashing).toHaveBeenCalledOnce();
    } finally {
      hashing.mockRestore();
    }
    await changeSettings({}, 1);
    expect((await register(email)).statusCode).toBe(200);
  });

  it('blocks new guest sessions while allowing existing recovery and gives leaderboard publication its own switch', async () => {
    const clientId = randomUUID();
    const recoveryKey = randomBytes(32).toString('base64url');
    const practice = { articleId: 'zh-beginner-1', duration: 60, clientId, recoveryKey };
    const initial = await post('/api/tests/start', practice, guest);
    expect(initial.statusCode).toBe(200);
    const { target } = initial.json();
    await changeSettings({ guestPracticeEnabled: false });
    expect((await start('zh')).statusCode).toBe(403);

    now += 2_000;
    const recover = { ...practice, target, draftId: `draft-${clientId}`, elapsedMs: 2_000, mode: 'timed', strict: false };
    expect((await post('/api/tests/recover', { ...recover, clientId: randomUUID() }, guest)).statusCode).toBe(403);
    expect((await post('/api/tests/recover', recover, guest)).statusCode).toBe(200);
    const finished = await post(`/api/tests/${clientId}/finish`, { typed: splitCharacters(target)[0] }, guest);
    expect(finished.statusCode).toBe(200);
    await changeSettings({ guestPracticeEnabled: false, guestLeaderboardEnabled: false }, 1);
    expect((await post('/api/leaderboard', { attemptId: clientId, nickname: '云朵' }, guest)).statusCode).toBe(403);
    expect((await app.inject('/api/leaderboard?language=zh&difficulty=beginner&duration=60')).statusCode).toBe(200);
    const member = await start('zh', admin);
    expect(member.statusCode).toBe(200);
    const { id: memberId, target: memberTarget } = member.json();
    await finishPaused(memberId, memberTarget, admin);
    expect((await post('/api/leaderboard', { attemptId: memberId }, admin)).json()).toEqual({ status: 'review' });
    await changeSettings({ guestPracticeEnabled: false }, 2);
    expect((await post('/api/leaderboard', { attemptId: clientId, nickname: '云朵' }, guest)).json()).toEqual({ status: 'review' });
  });

  it('applies separate Chinese CPM and English WPM thresholds and audits them', async () => {
    await changeSettings({ reviewThresholdZh: 119, reviewThresholdEn: 24 });
    const chinese = await start('zh');
    expect(chinese.statusCode).toBe(200);
    const zh = chinese.json();
    await finishPaused(zh.id, zh.target);
    const english = await start('en');
    expect(english.statusCode).toBe(200);
    const en = english.json();
    await finishPaused(en.id, en.target);
    for (const id of [zh.id, en.id]) {
      expect((await post('/api/leaderboard', { attemptId: id, nickname: '云朵' }, guest)).json()).toEqual({ status: 'review' });
    }
    const review = (await app.inject({ url: '/api/admin/review', headers: admin })).json().entries;
    expect(review.find((entry: { id: string }) => entry.id === zh.id).reasons).toEqual(['high_speed', 'paused_session']);
    expect(review.find((entry: { id: string }) => entry.id === en.id).reasons).toEqual(['paused_session']);
    const audit = await app.inject({ url: '/api/admin/audit?targetType=setting', headers: admin });
    expect(audit.json().entries).toMatchObject([{ action: 'settings.site.update', targetId: 'site' }]);
  });
});
