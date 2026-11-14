// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localHistory, readDraft, usePractice, type PracticeConfig } from '../src/hooks/usePractice';
import type { ArticleSnapshot, SavedPractice } from '../src/lib/models';

const article: ArticleSnapshot = { id: 'public', title: '练习', text: '甲乙丙丁', language: 'zh', difficulty: 'beginner', custom: false };
const config: PracticeConfig = { ...article, article, articleId: article.id, duration: 60, ownerId: null };
const response = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as Response;
let now: number;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('restores a timed-out online start and submits the same round after reconnecting', async () => {
  let online = false;
  let start: Record<string, unknown> | undefined;
  let recovery: Record<string, unknown> | undefined;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    requests.push(url);
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') { start = body; throw new Error('start response lost'); }
    if (url === '/api/tests/recover') {
      if (!online) throw new Error('offline');
      recovery = body;
      return response({ id: body.clientId, status: 'paused', elapsedMs: body.elapsedMs, remainingMs: 60000 - body.elapsedMs, claimVersion: Number(body.expectedClaimVersion ?? 0) + 1 });
    }
    if (url.endsWith('/resume')) return response({ remainingMs: 55000 });
    if (url.endsWith('/pause')) return response({ remainingMs: 55000 });
    if (url.endsWith('/finish')) return response({ attemptId: recovery?.clientId, status: 'review', eligible: true, elapsedMs: body.elapsedMs, score: { correct: 4, total: 4, accuracy: 100, cpm: 34.29, wpm: 6.86 } });
    throw new Error(`unexpected ${url}`);
  }));
  const first = renderHook(() => usePractice(config, null));
  act(() => first.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft()?.pendingStart).toBe(false));
  expect(start?.recoveryKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  now = 5000;
  await act(() => first.result.current.pause());
  expect(readDraft()?.typed).toBe('甲');
  first.unmount();
  const saved = readDraft()!;
  online = true;
  const second = renderHook(() => usePractice(config, saved));
  await waitFor(() => expect(['paused', 'restoring']).toContain(second.result.current.phase));
  await waitFor(() => expect(second.result.current.phase).toBe('paused'));
  now = 100000;
  await act(() => second.result.current.resume());
  expect(second.result.current.phase).toBe('running');
  expect(recovery).toMatchObject({ clientId: start?.clientId, recoveryKey: start?.recoveryKey, elapsedMs: 5000, target: article.text });
  now = 102000;
  await act(async () => { second.result.current.updateTyped(article.text); });
  await waitFor(() => expect(second.result.current.result?.eligible).toBe(true));
  expect(second.result.current.result).toMatchObject({ offline: false, status: 'review', elapsedMs: 7000 });
  expect(requests.some((url) => url.endsWith('/finish'))).toBe(true);
});

it('preserves the recovery credential when leaving before the start response', async () => {
  let start: Record<string, unknown> = {};
  let recovery: Record<string, unknown> = {};
  let resolveStart!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') { start = body; return new Promise<Response>((resolve) => { resolveStart = resolve; }); }
    if (url === '/api/tests/recover') { recovery = body; return Promise.resolve(response({ id: body.clientId, status: 'paused', elapsedMs: body.elapsedMs, remainingMs: 60000 - body.elapsedMs, claimVersion: Number(body.expectedClaimVersion ?? 0) + 1 })); }
    if (url.endsWith('/resume')) return Promise.resolve(response({ remainingMs: 58000 }));
    return Promise.resolve(response({ remainingMs: 58000 }));
  }));
  const first = renderHook(() => usePractice(config, null));
  act(() => first.result.current.updateTyped('甲'));
  now = 2000;
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const saved = readDraft()!;
  expect(saved).toMatchObject({ typed: '甲', recoveryId: start.clientId, recoveryKey: start.recoveryKey });
  first.unmount();
  const second = renderHook(() => usePractice(config, saved));
  await waitFor(() => expect(second.result.current.phase).toBe('paused'));
  await act(() => second.result.current.resume());
  expect(second.result.current.phase).toBe('running');
  expect(recovery).toMatchObject({ clientId: start.clientId, recoveryKey: start.recoveryKey, elapsedMs: 2000 });
  await act(async () => resolveStart(response({ id: start.clientId, target: article.text })));
});

it('restores an account-synced online draft without resetting its elapsed time or creating a new round', async () => {
  const recoveryId = '1d6d9e2b-1d61-41f7-817f-711fb3698850';
  const key = 'A'.repeat(43);
  let recovered: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/recover') { recovered = body; return response({ id: recoveryId, status: 'paused', elapsedMs: 9000, remainingMs: 51000, claimVersion: 1 }); }
    if (url.endsWith('/resume')) return response({ remainingMs: 51000 });
    return response({ remainingMs: 51000 });
  }));
  const saved: SavedPractice = { id: `draft-${recoveryId}`, article, typed: '甲乙', elapsedMs: 9000, backspaces: 2, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: recoveryId, recoveryId, recoveryKey: key, offline: true, ownerId: 'account-a', savedAt: Date.now() };
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a' }, null));
  await act(() => session.result.current.loadSaved(saved));
  await waitFor(() => expect(session.result.current.phase).toBe('paused'));
  expect(session.result.current).toMatchObject({ typed: '甲乙', elapsedMs: 9000, backspaces: 2, draftId: saved.id });
  await act(() => session.result.current.resume());
  expect(recovered).toMatchObject({ clientId: recoveryId, recoveryKey: key, elapsedMs: 9000 });
});

it('retains an offline-completed round and can retry its online result without duplicates', async () => {
  let online = false;
  let id = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') { id = body.clientId; throw new Error('offline'); }
    if (url === '/api/tests/recover') {
      if (!online) throw new Error('offline');
      return response({ id, status: 'paused', elapsedMs: body.elapsedMs, remainingMs: 60000 - body.elapsedMs, claimVersion: Number(body.expectedClaimVersion ?? 0) + 1 });
    }
    if (url.endsWith('/finish')) return response({ attemptId: id, status: 'review', eligible: true, elapsedMs: body.elapsedMs, score: { correct: 4, total: 4, accuracy: 100, cpm: 48, wpm: 9.6 } });
    return response({ remainingMs: 55000 });
  }));
  const session = renderHook(() => usePractice(config, null));
  act(() => session.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft()?.pendingStart).toBe(false));
  now = 5000;
  await act(async () => { session.result.current.updateTyped(article.text); });
  await waitFor(() => expect(session.result.current.phase).toBe('finished'));
  expect(session.result.current.result?.offline).toBe(true);
  expect(readDraft()?.completed).toBe(true);
  expect(localHistory()).toHaveLength(1);
  online = true;
  await act(() => session.result.current.retryOnline());
  expect(session.result.current.result).toMatchObject({ offline: false, eligible: true, status: 'review', attemptId: id });
  expect(localHistory()).toHaveLength(1);
  expect(localHistory()[0]).toMatchObject({ recordId: id, localOnly: false });
});

it('does not rewind a server-confirmed checkpoint when recovering a cloud draft', async () => {
  const id = '8ed28856-86a3-4d8b-8f6d-6ed5a5656576';
  const saved: SavedPractice = { id: `draft-${id}`, article, typed: '甲乙', elapsedMs: 9000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: id, recoveryId: id, recoveryKey: 'A'.repeat(43), offline: true, ownerId: 'account-a', savedAt: Date.now() };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/tests/recover'
    ? response({ id, status: 'paused', elapsedMs: 12000, remainingMs: 48000, claimVersion: 1 })
    : response({ remainingMs: 48000 })));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a' }, null));
  await act(() => session.result.current.loadSaved(saved));
  expect(session.result.current.phase).toBe('paused');
  expect(session.result.current.elapsedMs).toBe(12000);
  expect(readDraft('account-a')?.elapsedMs).toBe(12000);
});

it('keeps a private article local and never sends it for ranked recovery', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return response({}); }));
  const privateArticle = { ...article, custom: true, id: 'private' };
  const session = renderHook(() => usePractice({ ...config, ...privateArticle, article: privateArticle, articleId: privateArticle.id }, null));
  act(() => session.result.current.updateTyped('甲'));
  now = 5000;
  await act(() => session.result.current.pause());
  await act(() => session.result.current.resume());
  expect(calls).not.toContain('/api/tests/recover');
  expect(session.result.current.canRetryOnline).toBe(false);
});

it('does not attach a second tab’s personal copy to the original ranked challenge', async () => {
  const id = 'dba9206f-5f77-4825-9166-46f40265a772';
  const saved: SavedPractice = { id: `draft-${id}`, article, typed: '', elapsedMs: 2000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: id, recoveryId: id, recoveryKey: 'A'.repeat(43), offline: true, ownerId: null, savedAt: Date.now() };
  localStorage.setItem(`cloudtyping.practice.v2.${id}`, JSON.stringify({
    ...config, target: article.text, typed: '', version: 1, elapsedMs: 2000, backspaces: 0, suspicious: false,
    recordId: id, recoveryId: id, recoveryKey: saved.recoveryKey, revision: 1, offline: true,
    leaseOwner: 'other-tab', leaseAt: Date.now(),
  }));
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return response({}); }));
  const session = renderHook(() => usePractice(config, null));
  await act(() => session.result.current.loadSaved(saved));
  expect(session.result.current.phase).toBe('paused');
  await act(() => session.result.current.resume());
  expect(session.result.current.phase).toBe('running');
  expect(calls).not.toContain('/api/tests/recover');
  expect(readDraft()?.recordId).not.toBe(id);
});

it('chooses a newer synchronized snapshot over an older unleased local draft', async () => {
  const id = 'f293c337-519f-4d99-9a98-d504186c4acb';
  const saved: SavedPractice = { id: `draft-${id}`, article, typed: '甲乙丙', elapsedMs: 12000, backspaces: 3, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: id, recoveryId: id, offline: true, ownerId: 'account-a', savedAt: Date.now(), progressVersion: 8 };
  localStorage.setItem(`cloudtyping.practice.v2.${id}`, JSON.stringify({
    ...config, ownerId: 'account-a', target: article.text, typed: '甲', version: 1, elapsedMs: 2000, backspaces: 0,
    suspicious: false, recordId: id, recoveryId: id, progressVersion: 2, revision: 2, offline: true, leaseOwner: null, savedAt: Date.now() - 5000,
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    return url === '/api/tests/recover' ? response({ id: body.clientId, status: 'paused', elapsedMs: body.elapsedMs, remainingMs: 60000 - body.elapsedMs, claimVersion: Number(body.expectedClaimVersion ?? 0) + 1 }) : response({ remainingMs: 48000 });
  }));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a' }, null));
  await act(() => session.result.current.loadSaved(saved));
  expect(session.result.current).toMatchObject({ phase: 'paused', typed: '甲乙丙', elapsedMs: 12000, backspaces: 3 });
  expect(readDraft('account-a')?.typed).toBe('甲乙丙');
});

it('never recovers or finishes a completed local draft deleted on another device', async () => {
  const id = 'a8eb767a-95e9-4d4b-8ca7-a783e6391c1b';
  const draft = { ...config, target: article.text, typed: '甲乙丙丁', version: 1 as const, elapsedMs: 5000, backspaces: 0,
    suspicious: false, recordId: id, recoveryId: id, recoveryKey: 'A'.repeat(43), revision: 1, offline: true, completed: true };
  localStorage.setItem(`cloudtyping.practice.v2.${id}`, JSON.stringify(draft));
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return response({}); }));
  const session = renderHook(() => usePractice({ ...config, isDraftDeleted: (draftId) => draftId === `draft-${id}` }, null));
  await act(() => session.result.current.loadLegacy(readDraft()!));
  expect(calls).not.toContain('/api/tests/recover');
  expect(calls.some((url) => url.endsWith('/finish'))).toBe(false);
  expect(session.result.current.result?.offline).toBe(true);
});

it('keeps the same recovery request across a lost response and resume', async () => {
  let attempts = 0;
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') throw new Error('offline');
    if (url === '/api/tests/recover') {
      sent.push(body);
      if (++attempts === 1) throw new Error('response lost');
      return response({ id: body.clientId, status: 'paused', elapsedMs: body.elapsedMs, remainingMs: 60000 - body.elapsedMs, claimVersion: 2 });
    }
    return response({ remainingMs: 55000 });
  }));
  const session = renderHook(() => usePractice(config, null));
  act(() => session.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft()?.pendingStart).toBe(false));
  now = 5000;
  await act(() => session.result.current.pause());
  expect(readDraft()?.recoveryRequestId).toBe(sent[0].recoveryRequestId);
  await act(() => session.result.current.resume());
  expect(sent[1].recoveryRequestId).toBe(sent[0].recoveryRequestId);
  expect(readDraft()?.claimVersion).toBe(2);
});

it('detaches a stale device instead of claiming or submitting the other device’s score', async () => {
  let id = '';
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push(url);
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') { id = body.clientId; return response({ id, target: article.text, claimVersion: 1 }); }
    if (url.endsWith('/pause')) return response({ remainingMs: 55000 });
    if (url.endsWith('/resume')) return response({ error: '进度已在其他设备继续', code: 'PRACTICE_TAKEN' }, false, 409);
    throw new Error(`unexpected ${url}`);
  }));
  const session = renderHook(() => usePractice(config, null));
  act(() => session.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft()?.id).toBe(id));
  now = 5000;
  await act(() => session.result.current.pause());
  await act(() => session.result.current.resume());
  expect(session.result.current.phase).toBe('running');
  expect(readDraft()).toMatchObject({ personalOnly: true, typed: '甲' });
  expect(readDraft()?.recordId).not.toBe(id);
  expect(calls).not.toContain('/api/tests/recover');
});

it('uses the server’s final text and backspaces when the same round was finished elsewhere', async () => {
  const id = 'd1f91d81-0d4e-4dda-8bf0-d643347c18ab';
  const saved: SavedPractice = { id: `draft-${id}`, article, typed: '甲', elapsedMs: 2000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: id, recoveryId: id, offline: true, ownerId: 'account-a', savedAt: Date.now() };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/recover') return response({ id, status: 'review', claimVersion: Number(body.expectedClaimVersion ?? 0) + 1, typed: article.text, backspaces: 3,
      result: { attemptId: id, status: 'review', eligible: true, elapsedMs: 5000, score: { correct: 4, total: 4, accuracy: 100, cpm: 48, wpm: 9.6 } } });
    return response({});
  }));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a' }, null));
  await act(() => session.result.current.loadSaved(saved));
  expect(session.result.current.phase).toBe('finished');
  expect(session.result.current.typed).toBe(article.text);
  expect(session.result.current.result).toMatchObject({ backspaces: 3, score: { correct: 4, total: 4 } });
  expect(localHistory()[0]).toMatchObject({ typed: article.text, backspaces: 3, total: 4, correct: 4 });
  expect(session.result.current.result?.continuation).toBeUndefined();
  expect(readDraft('account-a')).toMatchObject({ completed: true, typed: article.text, backspaces: 3, claimVersion: 1 });
});

it('keeps the device claim and in-flight recovery request out of synchronized drafts', async () => {
  const drafts: SavedPractice[] = [];
  let resolveRecovery!: (value: Response) => void;
  let recovery: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/tests/start') return Promise.reject(new Error('offline'));
    if (url === '/api/tests/recover') {
      recovery = JSON.parse(String(options?.body));
      return new Promise<Response>((resolve) => { resolveRecovery = resolve; });
    }
    return Promise.resolve(response({}));
  }));
  const session = renderHook(() => usePractice({ ...config, onDraft: (draft) => drafts.push(draft) }, null));
  act(() => session.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft()?.pendingStart).toBe(false));
  now = 5000;
  let pending!: Promise<boolean>;
  act(() => { pending = session.result.current.pause(); });
  await waitFor(() => expect(resolveRecovery).toBeTypeOf('function'));
  expect(readDraft()?.recoveryRequestId).toBe(recovery.recoveryRequestId);
  expect(readDraft()?.claimId).toBe(recovery.claimId);
  expect(drafts.every((draft) => !draft.claimId && !draft.recoveryRequestId)).toBe(true);
  await act(async () => {
    resolveRecovery(response({ id: recovery.clientId, status: 'paused', elapsedMs: 5000, remainingMs: 55000, claimVersion: 2 }));
    await pending;
  });
  expect(drafts.at(-1)).toMatchObject({ claimVersion: 2, typed: '甲' });
  expect(drafts.at(-1)?.claimId).toBeUndefined();
  expect(drafts.at(-1)?.recoveryRequestId).toBeUndefined();
});

it('continues syncing account progress while the recovery endpoint is unavailable', async () => {
  const drafts: SavedPractice[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/tests/start' || url === '/api/tests/recover') throw new Error('temporarily unavailable');
    return response({});
  }));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a', onDraft: (draft) => drafts.push(draft) }, null));
  act(() => session.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft('account-a')?.pendingStart).toBe(false));
  now = 4000;
  await act(() => session.result.current.pause());
  await act(() => session.result.current.resume());
  now = 7000;
  act(() => session.result.current.updateTyped('甲乙丙'));
  await act(() => session.result.current.pause());
  expect(drafts.at(-1)).toMatchObject({ typed: '甲乙丙', offline: true });
  expect(drafts.at(-1)?.recoveryMarker).toMatch(/^[0-9a-f-]{36}$/);
  expect(drafts.at(-1)?.claimId).toBeUndefined();
  expect(drafts.at(-1)?.recoveryRequestId).toBeUndefined();
});

it('generates a new recovery marker when opening another device’s synced draft', async () => {
  const id = '4db224ca-56ab-4db6-b91b-c08842b44ab4';
  const otherMarker = 'bf8a1a21-922d-4d56-92ea-74cf53a84912';
  const saved: SavedPractice = { id: `draft-${id}`, article, typed: '甲', elapsedMs: 5000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: id, recoveryId: id, recoveryMarker: otherMarker, claimVersion: 1, progressVersion: 5, offline: true, ownerId: 'account-a', savedAt: Date.now() };
  let recovery: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/recover') { recovery = body; return response({ id, status: 'paused', elapsedMs: 5000, remainingMs: 55000, claimVersion: 2 }); }
    return response({ remainingMs: 55000 });
  }));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a' }, null));
  await act(() => session.result.current.loadSaved(saved));
  expect(recovery.recoveryMarker).toMatch(/^[0-9a-f-]{36}$/);
  expect(recovery.recoveryMarker).not.toBe(otherMarker);
});

it('does not increase the content version merely by preparing a recovery request', async () => {
  const id = '2d3aa594-26e3-4f81-9041-172a52972972';
  const saved: SavedPractice = { id: `draft-${id}`, article, typed: '甲', elapsedMs: 5000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0, recordId: id, recoveryId: id, claimVersion: 1, progressVersion: 4, offline: true, ownerId: 'account-a', savedAt: Date.now() };
  const drafts: SavedPractice[] = [];
  let resolveRecovery!: (value: Response) => void;
  let body: Record<string, unknown> = {};
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/tests/recover') { body = JSON.parse(String(options?.body)); return new Promise<Response>((resolve) => { resolveRecovery = resolve; }); }
    return Promise.resolve(response({}));
  }));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a', onDraft: (draft) => drafts.push(draft) }, null));
  let loading!: Promise<void>;
  act(() => { loading = session.result.current.loadSaved(saved); });
  await waitFor(() => expect(resolveRecovery).toBeTypeOf('function'));
  expect(body.expectedProgressVersion).toBe(4);
  expect(readDraft('account-a')?.progressVersion).toBe(4);
  expect(drafts.every((draft) => draft.progressVersion === 4)).toBe(true);
  await act(async () => { resolveRecovery(response({ id, status: 'paused', elapsedMs: 5000, remainingMs: 55000, claimVersion: 2 })); await loading; });
});

it('restores an eligible online result after refresh until it has been submitted', async () => {
  let id = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') { id = body.clientId; return response({ id, target: article.text, claimVersion: 1 }); }
    if (url === '/api/tests/recover') return response({ id, status: 'review', claimVersion: body.expectedClaimVersion + 1, typed: article.text, backspaces: 0,
      result: { attemptId: id, status: 'review', eligible: true, elapsedMs: 5000, score: { correct: 4, total: 4, accuracy: 100, cpm: 48, wpm: 9.6 } } });
    if (url.endsWith('/finish')) return response({ attemptId: id, status: 'review', eligible: true, elapsedMs: 5000, score: { correct: 4, total: 4, accuracy: 100, cpm: 48, wpm: 9.6 } });
    return response({ remainingMs: 55000 });
  }));
  const first = renderHook(() => usePractice(config, null));
  act(() => first.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft()?.id).toBe(id));
  now = 5000;
  await act(async () => { first.result.current.updateTyped(article.text); });
  await waitFor(() => expect(first.result.current.result?.eligible).toBe(true));
  expect(readDraft()?.completed).toBe(true);
  await act(() => first.result.current.recoverForRanking(id));
  expect(readDraft()).toMatchObject({ completed: true, claimVersion: 2 });
  expect(readDraft()?.recoveryRequestId).toBeUndefined();
  first.unmount();
  const saved = readDraft()!;
  const second = renderHook(() => usePractice(config, saved));
  await waitFor(() => expect(second.result.current.result?.eligible).toBe(true));
  expect(second.result.current.result?.attemptId).toBe(id);
  act(() => second.result.current.markRankSubmitted(id));
  expect(readDraft()).toBeNull();
  expect(localHistory()).toHaveLength(1);
});

it('reconnects a paused pending round on the browser online event', async () => {
  let online = false;
  const drafts: SavedPractice[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === '/api/tests/start') throw new Error('offline');
    if (url === '/api/tests/recover') {
      if (!online) throw new Error('offline');
      return response({ id: body.clientId, status: 'paused', elapsedMs: body.elapsedMs, remainingMs: 60000 - body.elapsedMs, claimVersion: body.expectedClaimVersion + 1 });
    }
    return response({});
  }));
  const session = renderHook(() => usePractice({ ...config, ownerId: 'account-a', onDraft: (draft) => drafts.push(draft) }, null));
  act(() => session.result.current.updateTyped('甲'));
  await waitFor(() => expect(readDraft('account-a')?.pendingStart).toBe(false));
  now = 4000;
  await act(() => session.result.current.pause());
  expect(readDraft('account-a')?.offline).toBe(true);
  online = true;
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(readDraft('account-a')?.offline).toBe(false));
  expect(session.result.current.phase).toBe('paused');
  expect(drafts.at(-1)).toMatchObject({ typed: '甲', claimVersion: 2, offline: false });
});
