// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../src/hooks/useWorkspace';
import {
  chunkWorkspaceItems, deleteWorkspaceValue, isWorkspaceDraftDeleted, mergeWorkspaceItems, newerWorkspaceItems, putWorkspaceValue, readWorkspace,
} from '../src/lib/workspace';
import type { SavedPractice, WorkspaceItem } from '../src/lib/models';
import { defaultBackground } from '../src/lib/background';

const favorite = (id: string, updatedAt = Date.now()): WorkspaceItem =>
  ({ kind: 'favorite', id, updatedAt, value: { articleId: id } });
const response = (items: WorkspaceItem[]) =>
  new Response(JSON.stringify({ items, serverTime: Date.now() }), { headers: { 'Content-Type': 'application/json' } });
const draft: SavedPractice = {
  id: 'draft-1', article: { id: 'private-1', title: '练习', text: '你好', language: 'zh', difficulty: 'beginner', custom: true },
  typed: '你', elapsedMs: 3000, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0,
  recordId: 'record-1', offline: true, ownerId: 'alice', savedAt: 3,
};

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reuses unchanged cloud images without downloading or uploading them on ordinary workspace edits', async () => {
  const background: WorkspaceItem = { kind: 'background', id: 'light', updatedAt: 1, value: defaultBackground('light', {
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=', name: 'cloud.png', width: 1, height: 1,
  }) };
  const version = 'a'.repeat(64);
  let remote = [background];
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'POST') remote = mergeWorkspaceItems(remote, JSON.parse(options.body as string).items);
    const cached = new Headers(options.headers).get('X-Workspace-Backgrounds') === version;
    return new Response(JSON.stringify({ items: cached ? remote.filter((item) => item.kind !== 'background') : remote, backgroundsVersion: version, backgroundsUnchanged: cached, serverTime: Date.now() }));
  });
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useWorkspace('background-cache'));
  await waitFor(() => expect(result.current.syncState).toBe('synced'));
  expect(result.current.backgrounds.light).toEqual(background.value);
  await act(async () => { await result.current.toggleFavorite('article'); await result.current.sync(); });
  expect(result.current.backgrounds.light).toEqual(background.value);
  expect(result.current.favorites).toEqual(['article']);
  expect(fetcher.mock.calls.some(([, options]) => new Headers(options.headers).get('X-Workspace-Backgrounds') === version)).toBe(true);
  const writes = fetcher.mock.calls.filter(([, options]) => options.method === 'POST');
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.flatMap(([, options]) => JSON.parse(options.body as string).items).some((item: WorkspaceItem) => item.kind === 'background')).toBe(false);
});

describe('local workspace', () => {
  it('retains tombstones, keeps newer edits and lets the incoming server item win ties', () => {
    const tombstone: WorkspaceItem = { kind: 'favorite', id: 'deleted', updatedAt: 5, deleted: true };
    expect(mergeWorkspaceItems([tombstone, favorite('edited', 8), favorite('tie', 3)], [
      favorite('deleted', 4), favorite('edited', 6), { kind: 'favorite', id: 'tie', updatedAt: 3, deleted: true },
    ])).toEqual([tombstone, favorite('edited', 8), { kind: 'favorite', id: 'tie', updatedAt: 3, deleted: true }]);
  });

  it('isolates persisted data across owners and serializes concurrent local edits', async () => {
    const articleId = 'zh-beginner-1';
    await Promise.all([
      putWorkspaceValue(null, 'favorite', articleId, { articleId }),
      putWorkspaceValue('alice', 'favorite', articleId, { articleId }),
      deleteWorkspaceValue('alice', 'favorite', articleId),
    ]);
    expect(await readWorkspace('alice')).toEqual([expect.objectContaining({ id: articleId, deleted: true })]);
    expect(await readWorkspace('bob')).toEqual([]);
    expect(await readWorkspace(null)).toEqual([expect.objectContaining({ value: { articleId } })]);
  });

  it('merges a draft deletion over newer live progress and still uploads an older local deletion', () => {
    const live: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 3, value: draft };
    const tombstone: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 2, deleted: true };
    expect(mergeWorkspaceItems([live], [tombstone])).toEqual([tombstone]);
    expect(mergeWorkspaceItems([tombstone], [live])).toEqual([tombstone]);
    expect(newerWorkspaceItems([tombstone], [live])).toEqual([tombstone]);
    expect(newerWorkspaceItems([live], [tombstone])).toEqual([]);
  });

  it('keeps the newer claim and progress even when an older draft has a later timestamp', () => {
    const latest: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 10, value: { ...draft, typed: '甲乙', claimVersion: 2, progressVersion: 4 } };
    const staleClaim: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 30, value: { ...draft, typed: '甲', claimVersion: 1, progressVersion: 50 } };
    const staleProgress: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 40, value: { ...draft, typed: '甲', claimVersion: 2, progressVersion: 3 } };
    expect(mergeWorkspaceItems([latest], [staleClaim])).toEqual([latest]);
    expect(mergeWorkspaceItems([latest], [staleProgress])).toEqual([latest]);
    expect(newerWorkspaceItems([staleClaim, staleProgress], [latest])).toEqual([]);
  });

  it('does not let an offline branch based on stale progress replace a newer draft', () => {
    const latest: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 10, value: { ...draft, typed: '甲乙', claimVersion: 1, progressVersion: 5 } };
    const stale: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 30, value: { ...draft, typed: '甲丙', claimVersion: 1, progressVersion: 7, recoveryMarker: 'a', recoveryBaseVersion: 4 } };
    const sameBranch: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 10, value: { ...draft, typed: '甲', claimVersion: 1, progressVersion: 5, recoveryMarker: 'a', recoveryBaseVersion: 4 } };
    expect(mergeWorkspaceItems([latest], [stale])).toEqual([latest]);
    expect(mergeWorkspaceItems([stale], [latest])).toEqual([latest]);
    expect(newerWorkspaceItems([stale], [latest])).toEqual([]);
    expect(mergeWorkspaceItems([sameBranch], [stale])).toEqual([stale]);
  });

  it('prefers the authoritative incoming cloud snapshot when both local branches diverged', () => {
    const local: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 30, value: { ...draft, typed: '甲乙X', claimVersion: 1, progressVersion: 15, recoveryMarker: 'b', recoveryBaseVersion: 11 } };
    const cloud: WorkspaceItem = { kind: 'draft', id: draft.id, updatedAt: 20, value: { ...draft, typed: '甲乙丙', claimVersion: 1, progressVersion: 13, recoveryMarker: 'a', recoveryBaseVersion: 12 } };
    expect(mergeWorkspaceItems([local], [cloud])).toEqual([cloud]);
    expect(newerWorkspaceItems([local], [cloud])).toEqual([]);
  });

  it('refuses to write a deleted draft ID but accepts a new draft ID', async () => {
    await deleteWorkspaceValue('alice', 'draft', draft.id);
    await expect(putWorkspaceValue('alice', 'draft', draft.id, draft)).rejects.toMatchObject({ name: 'DraftDeletedError', id: draft.id });
    const fresh = { ...draft, id: 'draft-2' };
    await putWorkspaceValue('alice', 'draft', fresh.id, fresh);
    expect((await readWorkspace('alice')).find((item) => item.id === fresh.id)?.value).toEqual(fresh);
    expect(isWorkspaceDraftDeleted('alice', draft.id)).toBe(true);
    expect(isWorkspaceDraftDeleted('bob', draft.id)).toBe(false);
  });

  it('preserves saved state when persistence fails', async () => {
    await putWorkspaceValue('alice', 'favorite', 'saved', { articleId: 'saved' });
    const error = new DOMException('Storage full', 'QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw error; });
    await expect(putWorkspaceValue('alice', 'favorite', 'unsaved', { articleId: 'unsaved' })).rejects.toThrow('Storage full');
    expect(await readWorkspace('alice')).toEqual([expect.objectContaining({ id: 'saved' })]);
  });

  it('chunks by both the serialized UTF-8 size and the item count', () => {
    const small = Array.from({ length: 110 }, (_, index) => favorite(String(index)));
    expect(chunkWorkspaceItems(small).map((chunk) => chunk.length)).toEqual([100, 10]);
    const large = Array.from({ length: 75 }, (_, index) => ({
      ...favorite(String(index)), value: { text: '字'.repeat(20_000) },
    }));
    const chunks = chunkWorkspaceItems(large);
    expect(chunks).toHaveLength(2);
    expect(chunks.flat()).toEqual(large);
    for (const items of chunks) expect(new TextEncoder().encode(JSON.stringify({ items })).byteLength).toBeLessThanOrEqual(3 * 1024 * 1024);
  });
});

describe('workspace sync', () => {
  it('uploads a local deletion committed while the initial server request is pending', async () => {
    let release!: (result: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockImplementation(async (_url, options) => response(JSON.parse(String(options?.body)).items));
    vi.stubGlobal('fetch', fetcher);
    const initial = favorite('same');
    await putWorkspaceValue('alice', 'favorite', 'same', { articleId: 'same' });
    const { result } = renderHook(() => useWorkspace('alice'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(() => result.current.remove('favorite', 'same'));
    await act(async () => { release(response([initial])); });
    await waitFor(() => expect(result.current.syncState).toBe('synced'));
    expect(result.current.favorites).toEqual([]);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).items).toEqual([expect.objectContaining({ id: 'same', deleted: true })]);
  });

  it('exposes deleted draft IDs from persisted tombstones without returning them as active drafts', async () => {
    await deleteWorkspaceValue(null, 'draft', 'deleted-draft');
    const { result } = renderHook(() => useWorkspace(null));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.deletedDraftIds).toEqual(['deleted-draft']);
    expect(result.current.drafts).toEqual([]);
  });

  it('hides the previous owner immediately and discards an old response after switching', async () => {
    let release!: (result: Response) => void;
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockImplementation(async () => response([]));
    vi.stubGlobal('fetch', fetcher);
    await putWorkspaceValue('alice', 'favorite', 'alice-local', { articleId: 'alice-local' });
    const { result, rerender } = renderHook(({ owner }) => useWorkspace(owner), { initialProps: { owner: 'alice' } });
    await waitFor(() => expect(result.current.favorites).toEqual(['alice-local']));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender({ owner: 'bob' });
    expect(result.current.favorites).toEqual([]);
    await act(async () => { release(response([favorite('alice-cloud')])); });
    await waitFor(() => expect(result.current.syncState).toBe('synced'));
    expect(result.current.favorites).toEqual([]);
    expect(await readWorkspace('bob')).toEqual([]);
    expect((await readWorkspace('alice')).map((item) => item.id)).toEqual(['alice-local']);
    expect(fetcher.mock.calls.every(([url]) => url === '/api/workspace')).toBe(true);
  });

  it('merges simultaneous preference changes against the latest saved settings', async () => {
    localStorage.setItem('cloudtyping.theme.v1', 'dark');
    const { result } = renderHook(() => useWorkspace(null));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { await Promise.all([
      result.current.updateSettings({ minutes: 12 }),
      result.current.updateSettings({ strict: true }),
    ]); });
    await waitFor(() => expect(result.current.settings).toMatchObject({ minutes: 12, strict: true, theme: 'dark' }));
  });

  it('keeps the local workspace usable on malformed responses and supports manual retry', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ serverTime: Date.now() })))
      .mockImplementation(async (_url, options) => response(options?.body ? JSON.parse(String(options.body)).items : []));
    vi.stubGlobal('fetch', fetcher);
    await putWorkspaceValue('alice', 'favorite', 'saved', { articleId: 'saved' });
    const { result } = renderHook(() => useWorkspace('alice'));
    await waitFor(() => expect(result.current.syncState).toBe('error'));
    expect(result.current.ready).toBe(true);
    expect(result.current.cloudLoaded).toBe(false);
    expect(result.current.favorites).toEqual(['saved']);
    await act(() => result.current.sync());
    expect(result.current.syncState).toBe('synced');
    expect(result.current.cloudLoaded).toBe(true);
    expect(result.current.favorites).toEqual(['saved']);
  });

  it('rejects malformed settings in a remote item without replacing usable local settings', async () => {
    const malformed = {
      kind: 'settings', id: 'preferences', updatedAt: Date.now(),
      value: { minutes: 5, theme: 'dark', lineHeight: 'invalid' },
    } satisfies WorkspaceItem;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => response([malformed])));
    const { result } = renderHook(() => useWorkspace('alice'));
    await waitFor(() => expect(result.current.syncState).toBe('error'));
    expect(result.current.settings).toMatchObject({ lineHeight: 1.6, theme: 'light' });
    expect(await readWorkspace('alice')).toEqual([]);
  });

  it('syncs valid changes alongside a rejected item and keeps the rejected item available locally', async () => {
    const serverItems: WorkspaceItem[] = [];
    const posts: WorkspaceItem[][] = [];
    let acceptsRejected = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (!options?.body) return response(serverItems);
      const { items } = JSON.parse(String(options.body)) as { items: WorkspaceItem[] };
      posts.push(items);
      if (!acceptsRejected && items.some((item) => item.id === 'rejected')) {
        return new Response(JSON.stringify({ error: '同步数据无效' }), { status: 400 });
      }
      serverItems.push(...items);
      return response(serverItems);
    }));
    await putWorkspaceValue('alice', 'favorite', 'saved', { articleId: 'saved' });
    await putWorkspaceValue('alice', 'favorite', 'rejected', { articleId: 'rejected' });
    const { result } = renderHook(() => useWorkspace('alice'));
    await waitFor(() => expect(result.current.syncState).toBe('error'));
    expect(result.current.favorites.sort()).toEqual(['rejected', 'saved']);
    expect(result.current.cloudLoaded).toBe(true);
    expect(serverItems.map((item) => item.id)).toEqual(['saved']);
    expect(posts.map((items) => items.length)).toEqual([2, 1, 1]);
    acceptsRejected = true;
    await act(() => result.current.sync());
    expect(result.current.syncState).toBe('synced');
    expect(serverItems.map((item) => item.id)).toEqual(['saved', 'rejected']);
  });

  it('does not quarantine or subdivide a batch after a temporary HTTP failure', async () => {
    const posts: WorkspaceItem[][] = [];
    let healthy = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      if (!options?.body) return response([]);
      const { items } = JSON.parse(String(options.body)) as { items: WorkspaceItem[] };
      posts.push(items);
      return healthy ? response(items) : new Response(JSON.stringify({ error: '服务暂不可用' }), { status: 503 });
    }));
    for (const id of ['first', 'second']) await putWorkspaceValue('alice', 'favorite', id, { articleId: id });
    const { result } = renderHook(() => useWorkspace('alice'));
    await waitFor(() => expect(result.current.syncState).toBe('error'));
    expect(posts.map((items) => items.length)).toEqual([2]);
    healthy = true;
    await act(() => result.current.sync());
    expect(result.current.syncState).toBe('synced');
    expect(posts.map((items) => items.length)).toEqual([2, 2]);
  });

  it('uploads unrelated items when an oversized record cannot fit in a single batch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) =>
      response(options?.body ? JSON.parse(String(options.body)).items : []));
    vi.stubGlobal('fetch', fetcher);
    await putWorkspaceValue('alice', 'record', 'oversized', {
      language: 'zh', difficulty: 'beginner', duration: 60, accuracy: 0, speed: 0, finishedAt: Date.now(),
      typed: '字'.repeat(1_050_000),
    });
    await putWorkspaceValue('alice', 'favorite', 'saved', { articleId: 'saved' });
    const { result } = renderHook(() => useWorkspace('alice'));
    await waitFor(() => expect(result.current.syncState).toBe('error'));
    expect(result.current.records).toHaveLength(1);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).items).toEqual([expect.objectContaining({ id: 'saved' })]);
  });
});

it('preserves local data when a workspace page fails and merges only after a complete retry', async () => {
  const owner = 'page-interruption';
  await putWorkspaceValue(owner, 'favorite', 'keep-local', { articleId: 'keep-local' });
  await putWorkspaceValue(owner, 'favorite', 'deleted-remotely', { articleId: 'deleted-remotely' });
  const local = await readWorkspace(owner);
  const deleted: WorkspaceItem = { kind: 'favorite', id: 'deleted-remotely', updatedAt: local.find((item) => item.id === 'deleted-remotely')!.updatedAt + 1, deleted: true };
  let fail = true;
  let remote: WorkspaceItem[] = [deleted];
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'POST') {
      remote = mergeWorkspaceItems(remote, JSON.parse(String(options.body)).items);
      return new Response(JSON.stringify({ acknowledged: true, serverTime: Date.now() }));
    }
    const cursor = new Headers(options.headers).get('X-Workspace-Cursor');
    if (cursor && fail) return new Response('{}', { status: 503 });
    if (cursor) return new Response(JSON.stringify({ items: [], serverTime: Date.now(), nextCursor: null }));
    return new Response(JSON.stringify({ items: remote, serverTime: Date.now(), nextCursor: 'page-two' }));
  });
  vi.stubGlobal('fetch', fetcher);
  const { result } = renderHook(() => useWorkspace(owner));
  await waitFor(() => expect(result.current.syncState).toBe('error'));
  expect(await readWorkspace(owner)).toEqual(local);
  expect(result.current.cloudLoaded).toBe(false);
  fail = false;
  await act(async () => { await result.current.sync(); });
  expect(result.current.syncState).toBe('synced');
  expect(result.current.favorites).toContain('keep-local');
  expect(result.current.favorites).not.toContain('deleted-remotely');
  expect((await readWorkspace(owner)).find((item) => item.id === 'deleted-remotely')).toMatchObject({ deleted: true });
});
