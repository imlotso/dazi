import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app';
import { articles } from '../src/data/articles';
import { splitCharacters } from '../src/lib/scoring';

describe('typing API', () => {
  let app: FastifyInstance;
  let now: number;
  let sent: Array<{ email: string; code: string; purpose: string }>;
  let temporary: string | undefined;

  beforeEach(async () => {
    now = 1_800_000_000_000;
    sent = [];
    temporary = undefined;
    app = await createApp({
      databasePath: ':memory:',
      now: () => now,
      secureCookies: false,
      mailer: { sendCode: async (email, code, purpose) => { sent.push({ email, code, purpose }); } },
    });
  });

  afterEach(async () => { await app.close(); if (temporary) rmSync(temporary, { recursive: true, force: true }); });

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

  it('supports email/password and a single-use email login code', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'alice@example.com', purpose: 'register' } });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', email: 'alice@example.com', password: 'a-long-password', code: sent[0].code } });
    const passwordLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'ALICE@example.com', password: 'a-long-password' } });
    expect(passwordLogin.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'alice@example.com', purpose: 'login' } });
    const payload = { email: 'alice@example.com', code: sent[1].code };
    const codeLogin = await app.inject({ method: 'POST', url: '/api/auth/login-code', payload });
    expect(codeLogin.statusCode).toBe(200);
    expect(codeLogin.json().user.username).toBe('alice');
    expect((await app.inject({ method: 'POST', url: '/api/auth/login-code', payload })).statusCode).toBe(401);
  });

  it('does not accept an expired email verification code', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'late@example.com', purpose: 'register' } });
    now += 10 * 60_000 + 1;
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'late_user', email: 'late@example.com', password: 'a-long-password', code: sent[0].code } });
    expect(registration.statusCode).toBe(400);
  });

  it('accepts every whole-minute duration in range and returns only the selected passage', async () => {
    const article = articles.find((item) => item.id === 'zh-beginner-2')!;
    for (const duration of [60, 300, 420, 3600]) {
      const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: article.id, duration } });
      expect(start.statusCode).toBe(200);
      expect(start.json()).toMatchObject({ target: article.content, duration });
      const rankings = await app.inject({ method: 'GET', url: `/api/leaderboard?language=zh&difficulty=beginner&duration=${duration}` });
      expect(rankings.statusCode).toBe(200);
    }
    for (const duration of [30, 59, 61, 3601, 3660]) {
      const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: article.id, duration } });
      expect(start.statusCode).toBe(400);
      const rankings = await app.inject({ method: 'GET', url: `/api/leaderboard?language=zh&difficulty=beginner&duration=${duration}` });
      expect(rankings.statusCode).toBe(400);
    }
  });

  it('accepts a client-generated UUID without allowing duplicate challenge identities', async () => {
    const clientId = '7b224e39-1a5f-43a9-89aa-23bcdfe8142b';
    const payload = { articleId: 'zh-beginner-1', duration: 60, clientId };
    const first = await app.inject({ method: 'POST', url: '/api/tests/start', payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().id).toBe(clientId);
    const duplicate = await app.inject({ method: 'POST', url: '/api/tests/start', payload });
    expect(duplicate.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/tests/start', payload: { ...payload, clientId: 'unsafe-id' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/tests/${clientId}` })).statusCode).toBe(404);
  });

  it('freezes persisted active time while paused and excludes the gap from speed and review', async () => {
    await app.close();
    temporary = mkdtempSync(join(tmpdir(), 'typing-pause-'));
    const databasePath = join(temporary, 'test.sqlite');
    const openApp = () => createApp({ databasePath, now: () => now, secureCookies: false, adminEmail: 'admin@example.com', mailer: { sendCode: async (email, code, purpose) => { sent.push({ email, code, purpose }); } } });
    app = await openApp();
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'admin@example.com', purpose: 'register' } });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'admin', email: 'admin@example.com', password: 'a-long-password', code: sent[0].code } });
    const cookie = registration.headers['set-cookie'] as string;
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', headers: { cookie }, payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    now += 10_000;
    const firstCheckpoint = await app.inject({ method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 4) } });
    expect(firstCheckpoint.statusCode).toBe(200);
    const pause = await app.inject({ method: 'POST', url: `${url}/pause`, headers: { cookie } });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toEqual({ elapsedMs: 10_000, remainingMs: 50_000 });
    await app.close();
    now += 120_000;
    app = await openApp();

    expect((await app.inject({ method: 'GET', url, headers: { cookie } })).json()).toEqual({ status: 'paused', elapsedMs: 10_000, remainingMs: 50_000, duration: 60 });
    expect((await app.inject({ method: 'POST', url: `${url}/pause`, headers: { cookie } })).json()).toEqual({ elapsedMs: 10_000, remainingMs: 50_000 });
    expect((await app.inject({ method: 'POST', url: `${url}/resume`, headers: { cookie } })).json()).toEqual({ elapsedMs: 10_000, remainingMs: 50_000 });
    now += 5_000;
    expect((await app.inject({ method: 'GET', url, headers: { cookie } })).json()).toMatchObject({ status: 'active', elapsedMs: 15_000, remainingMs: 45_000 });
    for (const [seconds, length] of [[15, 6], [30, 12], [45, 18], [55, 22]]) {
      if (seconds !== 15) now += seconds === 55 ? 10_000 : 15_000;
      const checkpoint = await app.inject({ method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length) } });
      expect(checkpoint.statusCode).toBe(200);
    }
    now += 5_000;
    const typed = '🧪' + challenge.target.slice(1, 25);
    const finish = await app.inject({ method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed, backspaces: 3 } });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ elapsedMs: 60_000, status: 'review', eligible: true, score: { correct: 24, total: 25, cpm: 24 } });
    const publish = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id } });
    expect(publish.json()).toEqual({ status: 'review' });
    const review = await app.inject({ method: 'GET', url: '/api/admin/review', headers: { cookie } });
    expect(review.json().entries[0].reasons).toEqual(['paused_session']);
    const history = await app.inject({ method: 'GET', url: '/api/history', headers: { cookie } });
    expect(history.json().entries[0]).toMatchObject({ recordId: challenge.id, elapsedMs: 60_000, backspaces: 3, errors: 1 });
  });

  it('only allows the owner to recover or change the challenge state', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const url = `/api/tests/${start.json().id}`;
    const other = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = other.headers['set-cookie'] as string;
    for (const [method, endpoint] of [['GET', url], ['POST', `${url}/pause`], ['POST', `${url}/resume`]] as const) {
      expect((await app.inject({ method, url: endpoint, headers: { cookie } })).statusCode).toBe(404);
    }
  });

  it('scores an early completion with errors by the actual duration and rejects incomplete early attempts', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 300 } });
    expect(start.statusCode).toBe(200);
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}/finish`;
    const chars = splitCharacters(challenge.target);
    const typed = '🧪' + chars.slice(1).join('');
    const submit = (input: string) => app.inject({ method: 'POST', url, headers: { cookie }, payload: { typed: input, early: true } });
    now += 999;
    expect((await submit(typed)).statusCode).toBe(400);
    now += 29_001;
    expect((await submit(typed.slice(0, -1))).statusCode).toBe(400);
    const result = await submit(typed);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ elapsedMs: 30_000, score: { total: chars.length, correct: chars.length - 1, cpm: (chars.length - 1) * 2 } });
  });

  it('scores the client’s 20 seconds of active typing when the server observed 24 seconds', async () => {
    await app.close();
    app = await createApp({
      databasePath: ':memory:', now: () => now, secureCookies: false, adminEmail: 'timer@example.com',
      mailer: { sendCode: async (email, code, purpose) => { sent.push({ email, code, purpose }); } },
    });
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'timer@example.com', purpose: 'register' } });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'timer', email: 'timer@example.com', password: 'a-long-password', code: sent[0].code } });
    const adminCookie = registration.headers['set-cookie'] as string;
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 300 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}/finish`;
    const chars = splitCharacters(challenge.target);
    const submit = (elapsedMs: number | null) => app.inject({
      method: 'POST', url, headers: { cookie }, payload: { typed: chars.join(''), early: true, elapsedMs },
    });

    now += 24_000;
    for (const invalidElapsed of [null, 999, 25_001, 300_001]) {
      expect((await submit(invalidElapsed)).statusCode).toBe(400);
    }
    const finish = await submit(20_000);
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ elapsedMs: 20_000, status: 'review', score: { cpm: chars.length * 3 } });
    const publish = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id, nickname: '计时测试' } });
    expect(publish.json()).toEqual({ status: 'review' });
    const review = await app.inject({ method: 'GET', url: '/api/admin/review', headers: { cookie: adminCookie } });
    expect(review.json().entries[0].reasons).toContain('timing_discrepancy');
  });

  it('keeps multiple network delays around pauses from expiring an on-time completion', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    // The browser types for 10 seconds in each cycle. Network transit adds 4 seconds on each side.
    for (let index = 0; index < 4; index++) {
      now += 18_000;
      const pause = await app.inject({ method: 'POST', url: `${url}/pause`, headers: { cookie } });
      expect(pause.statusCode).toBe(200);
      now += 120_000;
      const resume = await app.inject({ method: 'POST', url: `${url}/resume`, headers: { cookie } });
      expect(resume.statusCode).toBe(200);
    }
    now += 24_000;
    const finish = await app.inject({ method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 10), elapsedMs: 60_000 } });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ elapsedMs: 60_000, status: 'review', score: { correct: 10, cpm: 10 } });
  });

  it('rejects a finish time earlier than the latest accepted client checkpoint', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    for (const elapsedMs of [10_000, 20_000, 30_000, 40_000]) {
      now += 10_000;
      const checkpoint = await app.inject({ method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 5), elapsedMs } });
      expect(checkpoint.statusCode).toBe(200);
    }
    const submit = (elapsedMs: number) => app.inject({ method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed: challenge.target, elapsedMs, early: true } });
    expect((await submit(39_000)).statusCode).toBe(400);
    expect((await submit(40_000)).statusCode).toBe(200);
  });

  it('rejects invalid, backwards or premature checkpoint times without advancing the accepted checkpoint', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}/checkpoint`;
    const submit = (elapsedMs: number | null) => app.inject({ method: 'POST', url, headers: { cookie }, payload: { typed: '', elapsedMs } });
    now += 10_000;
    for (const elapsedMs of [null, -1, 11_001, 60_001]) expect((await submit(elapsedMs)).statusCode).toBe(400);
    expect((await submit(10_000)).statusCode).toBe(200);
    now += 5_000;
    expect((await submit(9999)).statusCode).toBe(400);
    expect((await submit(16_000)).statusCode).toBe(200);
  });

  it('holds a client-timed finish for review when a later checkpoint omitted its client time', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    for (const [length, elapsedMs] of [[20, 10_000], [40, 20_000], [60, 30_000], [135, undefined]] as const) {
      now += 10_000;
      const checkpoint = await app.inject({
        method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length), elapsedMs },
      });
      expect(checkpoint.statusCode).toBe(200);
    }
    const finish = await app.inject({
      method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed: challenge.target, elapsedMs: 39_000, early: true },
    });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ status: 'review', elapsedMs: 39_000 });
  });

  it('rejects more checkpoint progress at the same client time and reviews progress gained too fast', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    const checkpoint = (length: number, elapsedMs: number) => app.inject({
      method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length), elapsedMs },
    });
    for (const [length, elapsedMs] of [[20, 10_000], [40, 20_000], [60, 30_000]]) {
      now += 10_000;
      expect((await checkpoint(length, elapsedMs)).statusCode).toBe(200);
    }
    now += 10_000;
    expect((await checkpoint(135, 30_000)).statusCode).toBe(400);
    expect((await checkpoint(135, 31_000)).statusCode).toBe(200);
    const finish = await app.inject({
      method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed: challenge.target, elapsedMs: 39_000, early: true },
    });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ status: 'review', elapsedMs: 39_000 });
  });

  it('reviews a finish when the last checkpoint is stale on the client clock', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    for (const [advance, length, elapsedMs] of [[15_000, 30, 10_000], [15_000, 60, 20_000], [15_000, 90, 30_000], [10_000, 138, 35_000]]) {
      now += advance;
      const checkpoint = await app.inject({
        method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length), elapsedMs },
      });
      expect(checkpoint.statusCode).toBe(200);
    }
    now += 5_000;
    const finish = await app.inject({
      method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed: challenge.target, elapsedMs: 59_000, early: true },
    });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ status: 'review', elapsedMs: 59_000 });
  });

  it.each([['finished', false], ['review', true]] as const)('lets only the owner recover a %s result', async (status, suspicious) => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'en-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const url = `/api/tests/${challenge.id}`;
    const startedAt = now;
    for (const [elapsed, length] of [[15_000, 5], [15_000, 10], [15_000, 15], [10_000, 20]]) {
      now += elapsed;
      await app.inject({ method: 'POST', url: `${url}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length), elapsedMs: now - startedAt - 1500 } });
    }
    now += 5_000;
    const finish = await app.inject({ method: 'POST', url: `${url}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 25) + '?', elapsedMs: 60_000, suspicious } });
    expect(finish.statusCode).toBe(200);
    const expected = { attemptId: challenge.id, status, eligible: true, elapsedMs: 60_000, score: { correct: 25, total: 26, accuracy: 96.15, cpm: 25, wpm: 5 } };
    expect(finish.json()).toEqual(expected);

    now += 15_000;
    const recovered = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(recovered.json()).toEqual({ status, duration: 60, elapsedMs: 60_000, remainingMs: 0, result: expected });
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('migrates older active challenges without losing their original elapsed time', async () => {
    await app.close();
    temporary = mkdtempSync(join(tmpdir(), 'typing-migration-'));
    const databasePath = join(temporary, 'test.sqlite');
    const db = new Database(databasePath);
    db.exec(`CREATE TABLE challenges (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, language TEXT NOT NULL, difficulty TEXT NOT NULL,
      duration INTEGER NOT NULL, target TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active', correct INTEGER, total INTEGER, accuracy REAL, speed REAL,
      published INTEGER NOT NULL DEFAULT 0, nickname TEXT
    )`);
    const token = 'a'.repeat(43);
    db.prepare('INSERT INTO challenges(id,owner,language,difficulty,duration,target,started_at) VALUES (?,?,?,?,?,?,?)')
      .run('old-id', 'g:' + createHash('sha256').update(token).digest('hex'), 'zh', 'beginner', 120, '你好', now - 12_345);
    db.close();
    app = await createApp({ databasePath, now: () => now, secureCookies: false });
    const recovered = await app.inject({ method: 'GET', url: '/api/tests/old-id', headers: { cookie: `guest=${token}` } });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ status: 'active', elapsedMs: 12_345, remainingMs: 107_655, duration: 120 });
  });

  it('rejects finishing a timed challenge early and ranks an accepted guest score', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    const payload = { typed: challenge.target.slice(0, 10), suspicious: false };
    expect((await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload })).statusCode).toBe(400);
    for (const [length, elapsed] of [[2, 15_000], [4, 15_000], [6, 15_000], [8, 10_000]]) {
      now += elapsed;
      expect((await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length) } })).statusCode).toBe(200);
    }
    now += 5_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().score.correct).toBe(10);
    expect((await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id, nickname: '小云' } })).statusCode).toBe(200);
    const rankings = await app.inject({ method: 'GET', url: '/api/leaderboard?language=zh&difficulty=beginner&duration=60' });
    expect(rankings.json().entries[0]).toMatchObject({ nickname: '小云', speed: 10 });
    const duplicate = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: '' } });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual(finish.json());
    const duplicatePublish = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id, nickname: '另一个昵称' } });
    expect(duplicatePublish.statusCode).toBe(409);
  });

  it('holds a score for review when a transcript arrives without live activity', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'en-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    now += 60_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 600) } });
    expect(finish.json().status).toBe('review');
    const submission = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id, nickname: 'Tester' } });
    expect(submission.json().status).toBe('review');
    const ranking = await app.inject({ method: 'GET', url: '/api/leaderboard?language=en&difficulty=beginner&duration=60' });
    expect(ranking.json().entries).toEqual([]);
  });

  it('holds exceptional speeds for review even if checkpoints show steady progress', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'en-advanced-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    for (const [length, elapsed] of [[333, 20_000], [666, 20_000], [917, 15_000]]) {
      now += elapsed;
      await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length) } });
    }
    now += 5_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 1000) } });
    expect(finish.json().score.wpm).toBe(200);
    expect(finish.json().status).toBe('review');
  });

  it('does not count the network grace period as typing time', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'en-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    for (let i = 0; i < 2; i++) {
      now += 5_000;
      await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: '' } });
    }
    now += 69_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 449) } });
    expect(finish.json().status).toBe('review');
  });

  it('reviews a large final jump even when an earlier checkpoint is recent', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'en-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    now += 5_000;
    await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: '' } });
    now += 45_000;
    await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 110) } });
    now += 29_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 449) } });
    expect(finish.json().score.wpm).toBe(89.8);
    expect(finish.json().status).toBe('review');
  });

  it('does not flag an ordinary result when a progress update arrives after the server deadline', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    now += 7_000;
    for (const length of [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33]) {
      now += 5_000;
      expect((await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length) } })).statusCode).toBe(200);
    }
    now += 5_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 36) } });
    expect(finish.json().score.cpm).toBe(36);
    expect(finish.json().status).toBe('finished');
  });

  it('can retry score publication if the database write fails', async () => {
    await app.close();
    temporary = mkdtempSync(join(tmpdir(), 'typing-test-'));
    const databasePath = join(temporary, 'test.sqlite');
    app = await createApp({ databasePath, now: () => now, secureCookies: false });
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const cookie = start.headers['set-cookie'] as string;
    const challenge = start.json();
    for (const [length, elapsed] of [[2, 15_000], [4, 15_000], [6, 15_000], [8, 10_000]]) {
      now += elapsed;
      await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length) } });
    }
    now += 5_000;
    await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 10) } });
    const db = new Database(databasePath);
    db.exec("CREATE TRIGGER fail_score BEFORE INSERT ON scores BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const payload = { attemptId: challenge.id, nickname: '小云' };
    const first = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload });
    expect(first.statusCode).toBe(500);
    db.exec('DROP TRIGGER fail_score');
    db.close();
    const retry = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe('ranked');
  });

  it('shows an administrator why a score needs review', async () => {
    await app.close();
    app = await createApp({ databasePath: ':memory:', now: () => now, secureCookies: false, adminEmail: 'admin@example.com', mailer: { sendCode: async (email, code, purpose) => { sent.push({ email, code, purpose }); } } });
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'admin@example.com', purpose: 'register' } });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'admin', email: 'admin@example.com', password: 'a-long-password', code: sent[0].code } });
    const cookie = registration.headers['set-cookie'] as string;
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', headers: { cookie }, payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const challenge = start.json();
    now += 60_000;
    await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 5) } });
    await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id } });
    const review = await app.inject({ method: 'GET', url: '/api/admin/review', headers: { cookie } });
    expect(review.json().entries[0]).toMatchObject({ checkpoints: 0, reasons: expect.arrayContaining(['missing_activity']) });
    expect((await app.inject({ method: 'GET', url: '/api/admin/review' })).statusCode).toBe(403);
  });

  it('prevents concurrent code requests from sending multiple emails to the same address', async () => {
    await app.close();
    let release!: () => void;
    let markStarted!: () => void;
    let markSecondStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let sends = 0;
    app = await createApp({ databasePath: ':memory:', now: () => now, secureCookies: false, mailer: { sendCode: async () => { sends++; markStarted(); if (sends === 2) markSecondStarted(); await waiting; } } });
    const payload = { email: 'parallel@example.com', purpose: 'register' };
    const first = app.inject({ method: 'POST', url: '/api/auth/code', payload }).then((response) => response);
    await started;
    const second = app.inject({ method: 'POST', url: '/api/auth/code', payload }).then((response) => response);
    await Promise.race([second.then(() => undefined), secondStarted]);
    release();
    expect((await second).statusCode).toBe(429);
    expect((await first).statusCode).toBe(200);
    expect(sends).toBe(1);
  });

  it('can rank an account whose valid username is longer than a guest nickname', async () => {
    const username = 'long_username_12345';
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'long@example.com', purpose: 'register' } });
    const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, email: 'long@example.com', password: 'a-long-password', code: sent[0].code } });
    const cookie = registration.headers['set-cookie'] as string;
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', headers: { cookie }, payload: { articleId: 'zh-beginner-1', duration: 60 } });
    const challenge = start.json();
    for (const [length, elapsed] of [[2, 15_000], [4, 15_000], [6, 15_000], [8, 10_000]]) {
      now += elapsed;
      await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/checkpoint`, headers: { cookie }, payload: { typed: challenge.target.slice(0, length) } });
    }
    now += 5_000;
    await app.inject({ method: 'POST', url: `/api/tests/${challenge.id}/finish`, headers: { cookie }, payload: { typed: challenge.target.slice(0, 10) } });
    const submission = await app.inject({ method: 'POST', url: '/api/leaderboard', headers: { cookie }, payload: { attemptId: challenge.id } });
    expect(submission.statusCode).toBe(200);
    expect(submission.json().status).toBe('ranked');
  });

  it('uses client addresses for rate limits when behind the configured trusted proxy', async () => {
    await app.close();
    app = await createApp({ databasePath: ':memory:', now: () => now, secureCookies: false, trustProxy: true, mailer: { sendCode: async () => {} } });
    for (let index = 0; index < 8; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/code', headers: { 'x-forwarded-for': '203.0.113.1' }, payload: { email: `one${index}@example.com`, purpose: 'register' } });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/code', headers: { 'x-forwarded-for': '203.0.113.1' }, payload: { email: 'limited@example.com', purpose: 'register' } });
    expect(limited.statusCode).toBe(429);
    const other = await app.inject({ method: 'POST', url: '/api/auth/code', headers: { 'x-forwarded-for': '203.0.113.2' }, payload: { email: 'other@example.com', purpose: 'register' } });
    expect(other.statusCode).toBe(200);
  });

  it('does not issue a session from an old password after a concurrent reset', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'reset@example.com', purpose: 'register' } });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'reset_user', email: 'reset@example.com', password: 'old-password-123', code: sent[0].code } });
    await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'reset@example.com', purpose: 'reset' } });
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const originalVerify = argon2.verify;
    const spy = vi.spyOn(argon2, 'verify').mockImplementation(async (...args) => { markStarted(); await waiting; return originalVerify(...args); });
    try {
      const login = app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'reset_user', password: 'old-password-123' } }).then((response) => response);
      await started;
      const reset = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { email: 'reset@example.com', password: 'new-password-456', code: sent[1].code } });
      expect(reset.statusCode).toBe(200);
      release();
      expect((await login).statusCode).toBe(401);
    } finally { release(); spy.mockRestore(); }
  });
});
