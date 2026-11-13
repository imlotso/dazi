import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app';

describe('typing API', () => {
  let app: FastifyInstance;
  let now: number;
  let sent: Array<{ email: string; code: string; purpose: string }>;

  beforeEach(async () => {
    now = 1_800_000_000_000;
    sent = [];
    app = await createApp({
      databasePath: ':memory:',
      now: () => now,
      secureCookies: false,
      mailer: { sendCode: async (email, code, purpose) => { sent.push({ email, code, purpose }); } },
    });
  });

  afterEach(async () => { await app.close(); });

  it('requires a verified email and supports a username/password session', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'alice@example.com', purpose: 'register' } })).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', email: 'alice@example.com', password: 'a-long-password', code: sent[0].code } });
    expect(registration.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'alice', password: 'a-long-password' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe('alice');
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'alice', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
  });

  it('rejects finishing a timed challenge early and ranks an accepted guest score', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const payload = { typed: challenge.target.slice(0, 10), suspicious: false };
    expect((await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload })).statusCode).toBe(400);
    now += 60_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().score.correct).toBe(10);
    expect((await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id, nickname: '小云' } })).statusCode).toBe(200);
    const rankings = await app.inject({ method: 'GET', url: '/api/leaderboard?language=zh&difficulty=beginner&duration=60' });
    expect(rankings.json().entries[0]).toMatchObject({ nickname: '小云', speed: 10 });
    const duplicate = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload });
    expect(duplicate.statusCode).toBe(409);
  });
});
