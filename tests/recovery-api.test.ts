import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { catalogSnapshotKey, type ArticleSnapshot } from '../src/lib/models';

type OwnerHeaders = Record<string, string>;

describe('practice recovery API', () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let now: number;
  let article: ArticleSnapshot;
  let codes: Map<string, string>;

  beforeEach(async () => {
    now = 1_800_000_000_000;
    codes = new Map();
    app = await createApp({
      databasePath: ':memory:',
      now: () => now,
      secureCookies: false,
      adminEmail: 'admin@example.com',
      mailer: { sendCode: async (email, code) => { codes.set(email, code); } },
    });
    const { articles } = (await app.inject('/api/articles')).json<{ articles: ArticleSnapshot[] }>();
    article = articles.find((item) => item.id === 'zh-beginner-1')!;
  });

  afterEach(async () => { await app.close(); });

  const practice = () => ({
    clientId: randomUUID(), recoveryKey: randomBytes(32).toString('base64url'),
    articleId: article.id, articleKey: catalogSnapshotKey(article), target: article.text,
    duration: 60, mode: 'timed', strict: false, elapsedMs: 9000,
  });
  const post = (url: string, headers: OwnerHeaders, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url, headers, payload });
  const recover = (headers: OwnerHeaders, payload: Record<string, unknown>) =>
    post('/api/tests/recover', headers, { draftId: `draft-${payload.clientId}`, ...payload });
  const guest = () => ({ 'x-workspace-owner': 'guest', cookie: 'guest=' + randomBytes(32).toString('base64url') });
  async function register(username: string) {
    const email = `${username}@example.com`;
    await post('/api/auth/code', {}, { email, purpose: 'register' });
    const response = await post('/api/auth/register', {}, { email, username, password: 'long-password-123', code: codes.get(email) });
    expect(response.statusCode).toBe(200);
    return {
      'x-workspace-owner': response.json().user.id,
      cookie: 'session=' + response.cookies.find((cookie) => cookie.name === 'session')!.value,
    };
  }

  it('establishes a persistent guest identity before practice starts', async () => {
    const me = await app.inject('/api/me');
    expect(me.json()).toEqual({ user: null });
    expect(me.cookies).toEqual([expect.objectContaining({ name: 'guest', httpOnly: true })]);
    const withCookie = await app.inject({ url: '/api/me', headers: { cookie: 'guest=' + me.cookies[0].value } });
    expect(withCookie.cookies).toEqual([]);
    const owner = await register('member');
    const member = await app.inject({ url: '/api/me', headers: owner });
    expect(member.json().user.id).toBe(owner['x-workspace-owner']);
    expect(member.cookies).toEqual([]);
  });

  it('creates a missing attempt once and ignores older recovery retries', async () => {
    const headers = guest();
    const attempt = practice();
    const initial = await recover(headers, attempt);
    expect(initial.statusCode).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toEqual({ id: attempt.clientId, status: 'paused', elapsedMs: 9000, remainingMs: 51_000 });
    expect((await recover(headers, attempt)).json()).toEqual(initial.json());
    expect((await recover(headers, { ...attempt, elapsedMs: 1000 })).json()).toEqual(initial.json());
    const resume = await post(`/api/tests/${attempt.clientId}/resume`, headers);
    expect(resume.json()).toEqual({ elapsedMs: 9000, remainingMs: 51_000 });
  });

  it('recovers an expired attempt through the last confirmed client checkpoint', async () => {
    const headers = guest();
    const attempt = practice();
    expect((await post('/api/tests/start', headers, attempt)).statusCode).toBe(200);
    now += 20_000;
    expect((await post(`/api/tests/${attempt.clientId}/checkpoint`, headers, {
      elapsedMs: 18_000, typed: article.text.slice(0, 5),
    })).statusCode).toBe(200);
    now += 48 * 60 * 60_000;
    const response = await recover(headers, attempt);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'paused', elapsedMs: 18_000, remainingMs: 42_000 });
  });

  it('ignores ordinary paused wall time when recovering a previously recovered round', async () => {
    const headers = guest();
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    const first = { ...attempt, ...recoveryClaim(0) };
    expect((await recover(headers, first)).json()).toMatchObject({ elapsedMs: 9000 });
    const claim = claimHeaders(headers, first.claimId, 1);
    await post(path + '/resume', claim);
    now += 35_000;
    await post(path + '/pause', claim);
    const next = { ...attempt, ...recoveryClaim(1), elapsedMs: 10_000 };
    expect((await recover(headers, next)).json()).toMatchObject({ elapsedMs: 10_000, remainingMs: 50_000 });
  });

  it('refuses to recover drafts already deleted from the authenticated workspace', async () => {
    const owner = await register('owner');
    const attempt = practice();
    const draftId = `draft-${attempt.clientId}`;
    const initial = { ...attempt, ...recoveryClaim(0), draftId };
    const path = `/api/tests/${attempt.clientId}`;
    await post('/api/tests/start', owner, { ...attempt, claimId: initial.claimId });
    const mismatch = await recover(owner, { ...attempt, ...recoveryClaim(1), draftId: 'draft-unrelated' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: 'DRAFT_MISMATCH' });
    expect((await recover(owner, { ...attempt, ...recoveryClaim(1), draftId: undefined })).statusCode).toBe(409);
    await post('/api/workspace/sync', owner, { items: [{ kind: 'draft', id: draftId, updatedAt: now, deleted: true }] });
    for (const supplied of [draftId, undefined, 'draft-unrelated']) {
      const rejected = await recover(owner, { ...attempt, ...recoveryClaim(1), draftId: supplied });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({ code: 'DRAFT_DELETED' });
    }
    const claim = claimHeaders(owner, initial.claimId, 1);
    now += 60_000;
    for (const action of ['checkpoint', 'pause', 'resume', 'finish']) {
      const reply = await post(`${path}/${action}`, claim, { typed: '我', elapsedMs: 60_000 });
      expect(reply.statusCode).toBe(409);
      expect(reply.json()).toMatchObject({ code: 'DRAFT_DELETED' });
    }
    const read = await app.inject({ url: path, headers: claim });
    expect(read.json()).toMatchObject({ code: 'DRAFT_DELETED' });
  });

  it('binds a fallback challenge to the original draft when its UUID changes', async () => {
    const owner = await register('owner');
    const attempt = practice();
    const draftId = `draft-${randomUUID()}`;
    const recovery = { ...attempt, ...recoveryClaim(1), draftId };
    expect((await recover(owner, recovery)).json()).toMatchObject({ claimVersion: 2 });
    await post('/api/workspace/sync', owner, { items: [{ kind: 'draft', id: draftId, updatedAt: now, deleted: true }] });
    const next = { ...attempt, ...recoveryClaim(2) };
    expect((await recover(owner, next)).json()).toMatchObject({ code: 'DRAFT_DELETED' });
  });

  it('keeps a same-claim stale draft from invalidating the current device', async () => {
    const owner = await register('owner');
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    const draftId = `draft-${attempt.clientId}`;
    const first = recoveryClaim(0);
    expect((await recover(owner, { ...attempt, ...first })).statusCode).toBe(200);
    const recoveryMarker = randomUUID();
    const value = {
      id: draftId, recordId: attempt.clientId, article, typed: '我', elapsedMs: 9000, backspaces: 0, duration: 60,
      mode: 'timed', strict: false, offset: 0, offline: false, savedAt: now, claimVersion: 1, progressVersion: 5, recoveryMarker,
    };
    const sync = (draft: Record<string, unknown>, updatedAt: number) =>
      post('/api/workspace/sync', owner, { items: [{ kind: 'draft', id: draftId, updatedAt, value: draft }] });
    expect((await sync(value, now)).statusCode).toBe(200);
    const otherMarker = randomUUID();
    const staleDraft = { ...value, recoveryMarker: otherMarker, recoveryBaseVersion: 4, progressVersion: 6, typed: '我与' };
    expect((await sync({ ...staleDraft, recoveryBaseVersion: -1 }, now + 1)).statusCode).toBe(400);
    expect((await sync(staleDraft, now + 2)).json().items[0].value).toMatchObject({ recoveryMarker, progressVersion: 5, typed: '我' });
    const moreInput = { ...value, recoveryBaseVersion: 4, progressVersion: 6, typed: '我与父' };
    expect((await sync(moreInput, now + 3)).json().items[0].value).toMatchObject({
      recoveryMarker, recoveryBaseVersion: 4, progressVersion: 6, typed: '我与父',
    });
    const conflict = await recover(owner, { ...attempt, ...recoveryClaim(1), expectedProgressVersion: 4 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'DRAFT_STALE' });
    expect((await recover(owner, { ...attempt, ...recoveryClaim(1), expectedProgressVersion: 4, recoveryMarker: otherMarker })).json())
      .toMatchObject({ code: 'DRAFT_STALE' });
    expect((await recover(owner, { ...attempt, ...recoveryClaim(1), expectedProgressVersion: 4, recoveryMarker: 'invalid' })).statusCode)
      .toBe(400);
    const claim = claimHeaders(owner, first.claimId, 1);
    expect((await app.inject({ url: path, headers: claim })).statusCode).toBe(200);
    expect((await recover(owner, { ...attempt, ...recoveryClaim(1), expectedProgressVersion: 4, recoveryMarker })).json()).toMatchObject({ claimVersion: 2 });
    expect((await recover(owner, { ...attempt, ...recoveryClaim(1), expectedProgressVersion: 4 })).json()).toMatchObject({ code: 'PRACTICE_TAKEN' });
  });

  it('moves an unfinished guest attempt only when the original caller can prove the recovery key', async () => {
    const original = guest();
    const replacement = guest();
    const attempt = practice();
    expect((await post('/api/tests/start', original, attempt)).statusCode).toBe(200);
    expect((await recover(replacement, { ...attempt, recoveryKey: undefined })).statusCode).toBe(404);
    expect((await recover(replacement, { ...attempt, recoveryKey: practice().recoveryKey })).statusCode).toBe(404);
    expect((await recover(replacement, attempt)).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/tests/${attempt.clientId}`, headers: original })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/tests/${attempt.clientId}`, headers: replacement })).json()).toMatchObject({ status: 'paused' });
  });

  it('keeps account attempts scoped to their initial owner and checks the workspace header', async () => {
    const owner = await register('owner');
    const other = await register('other');
    const attempt = practice();
    expect((await post('/api/tests/start', owner, attempt)).statusCode).toBe(200);
    expect((await recover(other, attempt)).statusCode).toBe(404);
    expect((await recover(guest(), attempt)).statusCode).toBe(404);
    expect((await recover({ cookie: owner.cookie }, attempt)).statusCode).toBe(404);
    expect((await recover({ ...other, 'x-workspace-owner': owner['x-workspace-owner'] }, attempt)).statusCode).toBe(404);
    expect((await recover(owner, attempt)).statusCode).toBe(200);
  });

  it('matches the original article and practice settings before recovering', async () => {
    const headers = guest();
    const attempt = practice();
    expect((await recover(headers, { ...attempt, articleId: 'private-local' })).statusCode).toBe(404);
    expect((await recover(headers, { ...attempt, target: 'different article' })).statusCode).toBe(404);
    expect((await recover(headers, { ...attempt, articleKey: 'outdated article' })).statusCode).toBe(404);
    expect((await post('/api/tests/start', headers, attempt)).statusCode).toBe(200);
    for (const overrides of [
      { articleId: 'zh-beginner-2' }, { target: 'different text' }, { duration: 120 },
      { strict: true }, { mode: 'article' }, { articleKey: 'different catalog snapshot' },
    ]) {
      expect((await recover(headers, { ...attempt, ...overrides })).statusCode).toBe(404);
    }
    expect((await recover(headers, attempt)).statusCode).toBe(200);
  });

  it('clamps reported time to the practice limit', async () => {
    const headers = guest();
    const timed = { ...practice(), elapsedMs: 70_000 };
    expect((await recover(headers, timed)).json()).toMatchObject({ elapsedMs: 60_000, remainingMs: 0 });
    const articleMode = { ...practice(), mode: 'article', elapsedMs: 90_000_000 };
    expect((await recover(headers, articleMode)).json()).toMatchObject({ elapsedMs: 86_400_000, remainingMs: 0 });
  });

  it('submits recovered scores for review and returns the settled result unchanged', async () => {
    const headers = guest();
    const admin = await register('admin');
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    expect((await recover(headers, attempt)).statusCode).toBe(200);
    const finish = await post(path + '/finish', headers, { typed: article.text.slice(0, 5), elapsedMs: 9000 });
    expect(finish.statusCode).toBe(200);
    expect(finish.json()).toMatchObject({ status: 'review', eligible: true, elapsedMs: 9000 });
    expect((await recover(headers, { ...attempt, elapsedMs: 45_000 })).json()).toEqual({
      id: attempt.clientId, status: 'review', result: finish.json(),
    });
    const publish = await post('/api/leaderboard', headers, { attemptId: attempt.clientId, nickname: '云朵' });
    expect(publish.json()).toEqual({ status: 'review' });
    expect((await recover(guest(), attempt)).json()).toMatchObject({ code: 'SCORE_FINALIZED' });
    const pending = await app.inject({ url: '/api/admin/review', headers: admin });
    expect(pending.json().entries).toEqual([expect.objectContaining({
      id: attempt.clientId, reasons: expect.arrayContaining(['recovered_session']),
    })]);
    expect(pending.body).not.toContain(attempt.recoveryKey);
    const leaderboard = await app.inject('/api/leaderboard?language=zh&difficulty=beginner&duration=60');
    expect(leaderboard.json().entries).toEqual([]);
  });

  it('moves an unpublished settled result to a verified replacement guest without rewriting it', async () => {
    const original = guest();
    const replacement = guest();
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    expect((await recover(original, attempt)).statusCode).toBe(200);
    const finish = await post(path + '/finish', original, { typed: article.text.slice(0, 5), elapsedMs: 9000 });
    expect(finish.statusCode).toBe(200);
    expect((await recover(replacement, { ...attempt, recoveryKey: practice().recoveryKey })).statusCode).toBe(404);
    expect((await recover(replacement, { ...attempt, target: 'different text' })).statusCode).toBe(404);
    const recovered = await recover(replacement, { ...attempt, elapsedMs: 45_000 });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ id: attempt.clientId, status: 'review', result: finish.json() });
    expect((await app.inject({ url: path, headers: original })).statusCode).toBe(404);
    expect((await post('/api/leaderboard', replacement, { attemptId: attempt.clientId, nickname: '云朵' })).json()).toEqual({ status: 'review' });
    expect((await recover(original, attempt)).json()).toMatchObject({ code: 'SCORE_FINALIZED' });
  });

  const claimHeaders = (headers: OwnerHeaders, claimId: string, version: number) => ({
    ...headers, 'x-practice-claim': `${claimId}:${version}`,
  });
  const recoveryClaim = (expectedClaimVersion: number) => ({
    claimId: randomUUID(), expectedClaimVersion, recoveryRequestId: randomUUID(),
  });

  it('lets exactly one device claim a version and fences all stale or unclaimed per-attempt requests', async () => {
    const owner = await register('owner');
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    const originalClaim = randomUUID();
    expect((await post('/api/tests/start', owner, { ...attempt, claimId: originalClaim })).json()).toMatchObject({ claimVersion: 1 });
    const assertTaken = (response: { statusCode: number; json(): unknown }) => {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'PRACTICE_TAKEN' });
    };
    const contenders = [recoveryClaim(1), recoveryClaim(1)];
    const responses = await Promise.all(contenders.map((claim) => recover(owner, { ...attempt, ...claim })));
    const winner = responses.findIndex((response) => response.statusCode === 200);
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(responses[winner].json()).toMatchObject({ claimVersion: 2, status: 'paused' });
    assertTaken(responses[1 - winner]);
    assertTaken(await recover(owner, attempt));
    const stale = claimHeaders(owner, originalClaim, 1);
    for (const subpath of ['finish', 'pause', 'resume', 'checkpoint']) assertTaken(await post(`${path}/${subpath}`, stale));
    assertTaken(await app.inject({ url: path, headers: stale }));
    assertTaken(await app.inject({ url: path, headers: owner }));
    const current = claimHeaders(owner, contenders[winner].claimId, 2);
    expect((await post(path + '/finish', current, { typed: article.text.slice(0, 5), elapsedMs: 9000 })).json()).toMatchObject({ status: 'review' });
    assertTaken(await app.inject({ url: path, headers: stale }));
    assertTaken(await post(path + '/finish', stale));
    assertTaken(await post('/api/leaderboard', stale, { attemptId: attempt.clientId }));
  });

  it('retries an unreceived guest cookie and recovery response with the same key and nonce', async () => {
    const headers = { 'x-workspace-owner': 'guest' };
    const attempt = { ...practice(), ...recoveryClaim(0) };
    const first = await recover(headers, attempt);
    const retry = await recover(headers, { ...attempt, elapsedMs: 10_000 });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(retry.cookies[0].name).toBe('guest');
    const claim = claimHeaders({ cookie: 'guest=' + retry.cookies[0].value }, attempt.claimId, 1);
    const path = `/api/tests/${attempt.clientId}`;
    expect((await post(path + '/resume', claim)).statusCode).toBe(200);
    const old = claimHeaders({ cookie: 'guest=' + first.cookies[0].value }, attempt.claimId, 1);
    expect((await app.inject({ url: path, headers: old })).statusCode).toBe(404);
  });

  it('retries a lost recovery response idempotently until the claim resumes', async () => {
    const headers = guest();
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    const recovery = { ...attempt, ...recoveryClaim(1) };
    const first = await recover(headers, recovery);
    expect(first.json()).toEqual({ id: attempt.clientId, status: 'paused', elapsedMs: 9000, remainingMs: 51_000, claimVersion: 2 });
    expect((await recover(headers, { ...recovery, elapsedMs: 10_000 })).json()).toEqual(first.json());
    const claim = claimHeaders(headers, recovery.claimId, 2);
    expect((await post(path + '/resume', claim)).statusCode).toBe(200);
    const assertTaken = async (payload: Record<string, unknown>) => {
      const result = await recover(headers, payload);
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ code: 'PRACTICE_TAKEN' });
    };
    const replay = await recover(headers, recovery);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'RECOVERY_ALREADY_USED', currentClaimVersion: 2 });
    await assertTaken({ ...recovery, expectedClaimVersion: 2 });
    expect((await app.inject({ url: path, headers: claim })).json()).toMatchObject({ status: 'active' });
    expect((await post(path + '/pause', claim)).statusCode).toBe(200);
    expect((await recover(headers, recovery)).json()).toMatchObject({ code: 'RECOVERY_ALREADY_USED', currentClaimVersion: 2 });
    expect((await recover(headers, { ...attempt, ...recoveryClaim(2) })).json()).toMatchObject({ claimVersion: 3 });
  });

  it('preserves expired settled results and opens a reviewed window for one submission', async () => {
    const owner = await register('owner');
    const admin = await register('admin');
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    const originalClaim = randomUUID();
    await post('/api/tests/start', owner, { ...attempt, claimId: originalClaim });
    const original = claimHeaders(owner, originalClaim, 1);
    for (const seconds of [15, 30, 45, 55]) {
      now += seconds === 55 ? 10_000 : 15_000;
      await post(path + '/checkpoint', original, { typed: article.text.slice(0, Math.floor(seconds / 2)) });
    }
    now += 5000;
    const typed = article.text.slice(0, 27);
    const finished = await post(path + '/finish', original, { typed, backspaces: 4 });
    expect(finished.json()).toMatchObject({ status: 'finished', eligible: true, elapsedMs: 60_000 });
    now += 20 * 60_000;
    const publish = (headers: OwnerHeaders) => post('/api/leaderboard', headers, { attemptId: attempt.clientId });
    const expired = await publish(original);
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ code: 'SCORE_EXPIRED' });
    const draftId = `draft-${attempt.clientId}`;
    await post('/api/workspace/sync', owner, { items: [{ kind: 'draft', id: draftId, updatedAt: now, deleted: true }] });
    const next = { ...attempt, ...recoveryClaim(1) };
    expect((await recover(owner, next)).json()).toMatchObject({ code: 'DRAFT_DELETED' });
    const recovered = await recover(owner, { ...next, draftId: undefined });
    expect(recovered.json()).toEqual({ id: attempt.clientId, status: 'finished', result: finished.json(), claimVersion: 2, typed, backspaces: 4 });
    expect((await recover(owner, { ...next, draftId: undefined })).json()).toEqual(recovered.json());
    const current = claimHeaders(owner, next.claimId, 2);
    expect((await publish(current)).json()).toEqual({ status: 'review' });
    expect((await publish(current)).json()).toEqual({ status: 'review' });
    const pending = await app.inject({ url: '/api/admin/review', headers: admin });
    expect(pending.json().entries).toEqual([expect.objectContaining({
      id: attempt.clientId, finishedAt: now - 20 * 60_000, reasons: ['recovered_session'],
    })]);
  });

  it('acknowledges an already submitted score without replacing its nickname or duplicating the entry', async () => {
    const headers = guest();
    const admin = await register('admin');
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    const initial = recoveryClaim(0);
    expect((await recover(headers, { ...attempt, ...initial })).statusCode).toBe(200);
    const claim = claimHeaders(headers, initial.claimId, 1);
    const finish = await post(path + '/finish', claim, { typed: article.text.slice(0, 5), elapsedMs: 9000 });
    expect(finish.json()).toMatchObject({ status: 'review' });
    const publish = (requestHeaders: OwnerHeaders, nickname: string) =>
      post('/api/leaderboard', requestHeaders, { attemptId: attempt.clientId, nickname });
    expect((await publish(claim, '云朵')).json()).toEqual({ status: 'review' });
    expect((await publish(claim, '更名')).json()).toEqual({ status: 'review' });
    const pending = await app.inject({ url: '/api/admin/review', headers: admin });
    expect(pending.json().entries).toEqual([expect.objectContaining({ id: attempt.clientId, nickname: '云朵' })]);
    const next = recoveryClaim(1);
    const recovered = await recover(headers, { ...attempt, ...next });
    expect(recovered.json()).toMatchObject({ claimVersion: 2, result: { ...finish.json(), submitted: true } });
    const current = claimHeaders(headers, next.claimId, 2);
    expect((await publish(claim, '更名')).json()).toMatchObject({ code: 'PRACTICE_TAKEN' });
    expect((await post(`/api/admin/review/${attempt.clientId}`, admin, { action: 'approve', reason: '通过审核' })).statusCode).toBe(200);
    expect((await publish(current, '再更名')).json()).toEqual({ status: 'ranked' });
    const ranking = await app.inject('/api/leaderboard?language=zh&difficulty=beginner&duration=60');
    expect(ranking.json().entries).toEqual([expect.objectContaining({ attemptId: attempt.clientId, nickname: '云朵' })]);
  });

  it('does not recreate an attempt after administrators reject or remove its score', async () => {
    const owner = await register('owner');
    const admin = await register('admin');
    const rejected = practice();
    const removed = practice();
    const responses = [
      { attempt: rejected, action: 'reject' },
      { attempt: removed, action: 'approve' },
    ];
    for (const { attempt, action } of responses) {
      const recovery = { ...attempt, ...recoveryClaim(0) };
      const paused = await recover(owner, recovery);
      expect(paused.json()).toMatchObject({ claimVersion: 1 });
      const claim = claimHeaders(owner, recovery.claimId, 1);
      expect((await post(`/api/tests/${attempt.clientId}/finish`, claim, { typed: article.text.slice(0, 5), elapsedMs: 9000 })).statusCode).toBe(200);
      expect((await post('/api/leaderboard', claim, { attemptId: attempt.clientId })).statusCode).toBe(200);
      expect((await post(`/api/admin/review/${attempt.clientId}`, admin, { action, reason: '测试审核' })).statusCode).toBe(200);
      if (action === 'approve') expect((await post(`/api/admin/remove/${attempt.clientId}`, admin, { reason: '测试下架' })).statusCode).toBe(200);
      const terminal = await recover(owner, { ...attempt, ...recoveryClaim(1) });
      expect(terminal.statusCode).toBe(409);
      expect(terminal.json()).toMatchObject({ code: 'SCORE_FINALIZED' });
      expect(terminal.headers['cache-control']).toBe('no-store');
      const retry = await post('/api/leaderboard', claim, { attemptId: attempt.clientId });
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({ code: 'SCORE_FINALIZED' });
      expect((await recover(guest(), { ...attempt, ...recoveryClaim(1) })).statusCode).toBe(404);
    }
  });

  it('synchronizes the recovery credentials in an account draft', async () => {
    const owner = await register('owner');
    const attempt = practice();
    const draft = {
      id: 'local-draft', recordId: 'local-record', article, typed: '', elapsedMs: 9000, backspaces: 0, duration: 60,
      mode: 'timed', strict: false, offset: 0, offline: true, savedAt: now,
      recoveryId: attempt.clientId, recoveryKey: attempt.recoveryKey, personalOnly: true,
      claimId: randomUUID(), claimVersion: 2, recoveryRequestId: randomUUID(), progressVersion: 5, recoveryMarker: randomUUID(),
    };
    const sync = (value: Record<string, unknown>) =>
      post('/api/workspace/sync', owner, { items: [{ kind: 'draft', id: draft.id, updatedAt: now, value }] });
    expect((await sync({ ...draft, recoveryId: 'invalid' })).statusCode).toBe(400);
    expect((await sync({ ...draft, recoveryKey: 'invalid' })).statusCode).toBe(400);
    expect((await sync({ ...draft, personalOnly: 'invalid' })).statusCode).toBe(400);
    expect((await sync({ ...draft, claimId: 'invalid' })).statusCode).toBe(400);
    expect((await sync({ ...draft, claimVersion: -1 })).statusCode).toBe(400);
    expect((await sync({ ...draft, recoveryRequestId: 'invalid' })).statusCode).toBe(400);
    expect((await sync({ ...draft, progressVersion: 1.5 })).statusCode).toBe(400);
    expect((await sync({ ...draft, recoveryMarker: 'invalid' })).statusCode).toBe(400);
    expect((await sync(draft)).statusCode).toBe(200);
    const workspace = await app.inject({ url: '/api/workspace', headers: owner });
    const [item] = workspace.json().items;
    expect(item).toMatchObject({ kind: 'draft', value: {
      claimVersion: 2, progressVersion: 5, recoveryMarker: draft.recoveryMarker, recoveryId: attempt.clientId, recoveryKey: attempt.recoveryKey,
    } });
    expect(item.value).not.toHaveProperty('claimId');
    expect(item.value).not.toHaveProperty('recoveryRequestId');
  });

  it('merges drafts by claim and progress before device clocks, with deletion taking priority', async () => {
    const owner = await register('owner');
    const attempt = practice();
    const draft = {
      id: `draft-${attempt.clientId}`, recordId: attempt.clientId, article, typed: '', elapsedMs: 9000, backspaces: 0, duration: 60,
      mode: 'timed', strict: false, offset: 0, offline: false, savedAt: now,
    };
    const sync = async (age: number, value: Record<string, unknown> | null) => {
      const response = await post('/api/workspace/sync', owner, { items: [{
        kind: 'draft', id: draft.id, updatedAt: now + age, ...value ? { value: { ...draft, ...value } } : { deleted: true },
      }] });
      expect(response.statusCode).toBe(200);
      return response.json().items[0];
    };
    await sync(100, { claimVersion: 1, progressVersion: 10, typed: '我' });
    expect((await sync(50, { claimVersion: 2, progressVersion: 1, typed: '我与' })).value.typed).toBe('我与');
    expect((await sync(200, { claimVersion: 1, progressVersion: 20, typed: '我' })).value.typed).toBe('我与');
    expect((await sync(25, { claimVersion: 2, progressVersion: 4, typed: '我与父' })).value.typed).toBe('我与父');
    expect((await sync(250, { claimVersion: 2, progressVersion: 3, typed: '我' })).value.typed).toBe('我与父');
    expect((await sync(300, { claimVersion: 2, progressVersion: 4, typed: '我与父亲' })).value.typed).toBe('我与父亲');
    const storedMarker = randomUUID();
    const otherMarker = randomUUID();
    expect((await sync(301, { claimVersion: 3, progressVersion: 15, recoveryMarker: storedMarker, recoveryBaseVersion: 11, typed: '旧' })).value.typed).toBe('旧');
    // Both markers are based on progress older than the competing snapshot.
    expect((await sync(302, { claimVersion: 3, progressVersion: 16, recoveryMarker: otherMarker, recoveryBaseVersion: 10, typed: '争' })).value.typed).toBe('旧');
    // An unmarked snapshot supersedes speculative input based on older progress.
    expect((await sync(200, { claimVersion: 3, progressVersion: 12, typed: '实' })).value.typed).toBe('实');
    expect((await sync(303, { claimVersion: 3, progressVersion: 15, recoveryMarker: storedMarker, recoveryBaseVersion: 11, typed: '旧' })).value.typed).toBe('实');
    expect(await sync(1, null)).toMatchObject({ deleted: true });
    expect(await sync(400, { claimVersion: 3, progressVersion: 30, typed: '我' })).toMatchObject({ deleted: true });
  });

  it('reports an ineligible score without an expiration code', async () => {
    const headers = guest();
    const attempt = practice();
    const path = `/api/tests/${attempt.clientId}`;
    await recover(headers, attempt);
    await post(path + '/finish', headers, { typed: '', elapsedMs: 9000 });
    now += 20 * 60_000;
    const published = await post('/api/leaderboard', headers, { attemptId: attempt.clientId, nickname: '云朵' });
    expect(published.statusCode).toBe(400);
    expect(published.json()).not.toHaveProperty('code');
  });
});
