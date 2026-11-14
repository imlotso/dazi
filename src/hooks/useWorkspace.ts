import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ReaderSettings, SyncState, WorkspaceItem, WorkspaceKind, WorkspaceValues } from '../lib/models';
import {
  cachedWorkspace, chunkWorkspaceItems, deleteWorkspaceValue, isWorkspaceItem, mergeRemoteWorkspace, mergeWorkspaceItems, mutateWorkspaceValue,
  newerWorkspaceItems, putWorkspaceValue, readWorkspace, subscribeWorkspace, workspaceItemKey, workspaceSettings, workspaceValue,
} from '../lib/workspace';

const pollMs = 30_000;
const debounceMs = 1000;
const emptyItems: WorkspaceItem[] = [];

type View = {
  ownerId: string | null;
  ready: boolean;
  cloudLoaded: boolean;
  items: WorkspaceItem[];
  syncState: SyncState;
  error: string;
};
type Response = { items: WorkspaceItem[]; serverTime: number; backgroundsVersion?: string; backgroundsUnchanged?: boolean; nextCursor?: string | null; acknowledged?: boolean };
type KnownBackgrounds = { version: string; items: WorkspaceItem[] };

async function workspaceRequest(owner: string, signal: AbortSignal, items?: WorkspaceItem[], known?: KnownBackgrounds): Promise<Response> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const seenItems = new Set<string>();
  const collected: WorkspaceItem[] = [];
  let first: Response | undefined;
  do {
    const headers: Record<string, string> = {
      'X-Workspace-Owner': owner, 'X-Workspace-Backgrounds': known?.version ?? 'initial', 'X-Workspace-Paged': '1',
    };
    if (cursor) headers['X-Workspace-Cursor'] = cursor;
    const data = await api<Response>(items === undefined ? '/api/workspace' : '/api/workspace/sync', {
      method: items === undefined ? 'GET' : 'POST', body: items === undefined ? undefined : { items }, headers, signal,
    });
    if (!Number.isSafeInteger(data.serverTime) || data.serverTime <= 0) throw new Error('同步数据无法读取');
    if (data.acknowledged === true && items !== undefined) return { items: [], serverTime: data.serverTime, acknowledged: true };
    if (!Array.isArray(data.items) || data.items.length > 2000 || !data.items.every(isWorkspaceItem)) throw new Error('同步数据无法读取');
    if (data.backgroundsVersion !== undefined && (typeof data.backgroundsVersion !== 'string' || !/^[a-f0-9]{64}$/.test(data.backgroundsVersion))) throw new Error('同步数据无法读取');
    if (first && (data.backgroundsVersion !== first.backgroundsVersion || data.backgroundsUnchanged !== first.backgroundsUnchanged)) throw new Error('同步数据已变更，请重试');
    first ??= data;
    for (const item of data.items) {
      const key = workspaceItemKey(item);
      if (seenItems.has(key)) throw new Error('同步数据无法读取');
      seenItems.add(key);
      collected.push(item);
    }
    if (collected.length > 2000 || (data.nextCursor !== undefined && data.nextCursor !== null &&
      (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 2048))) throw new Error('同步数据无法读取');
    cursor = data.nextCursor ?? undefined;
    if (cursor && (items !== undefined || seenCursors.has(cursor) || seenCursors.size >= 2000)) throw new Error('同步数据无法读取');
    if (cursor) seenCursors.add(cursor);
    first.serverTime = Math.max(first.serverTime, data.serverTime);
  } while (cursor);
  if (!first) throw new Error('同步数据无法读取');
  if (first.backgroundsUnchanged) {
    if (!known || first.backgroundsVersion !== known.version || collected.some((item) => item.kind === 'background')) throw new Error('同步数据无法读取');
    collected.push(...known.items);
  }
  return { ...first, items: collected, nextCursor: null };
}

export function useWorkspace(ownerId: string | null, enabled = true) {
  const [view, setView] = useState<View>(() => ({
    ownerId, ready: false, cloudLoaded: false, items: emptyItems, syncState: ownerId ? 'loading' : 'guest', error: '',
  }));
  const lifecycle = useRef<{ ownerId: string | null; sync: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    const cached = cachedWorkspace(ownerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;
    let lastStartedAt = -Infinity;
    let pendingWrite = false;
    let knownBackgrounds: KnownBackgrounds | undefined;
    const requestWorkspace = async (items?: WorkspaceItem[]) => {
      const response = await workspaceRequest(ownerId!, signal, items, knownBackgrounds);
      if (!signal.aborted && !response.acknowledged) knownBackgrounds = response.backgroundsVersion
        ? { version: response.backgroundsVersion, items: response.items.filter((item) => item.kind === 'background') }
        : undefined;
      return response;
    };
    setView({ ownerId, ready: !!cached, cloudLoaded: false, items: cached ?? emptyItems, syncState: ownerId ? 'loading' : 'guest', error: '' });

    const publish = (patch: Partial<View>) => {
      if (!signal.aborted) setView((current) => current.ownerId === ownerId ? { ...current, ...patch } : current);
    };
    const failed = (error: unknown) => publish({
      syncState: 'error',
      error: error instanceof Error ? error.message : '同步失败',
    });
    const refresh = async () => {
      try {
        const items = await readWorkspace(ownerId);
        publish({ items, ready: true });
      } catch (error) {
        publish({ ready: true });
        failed(error);
      }
    };
    const schedule = () => {
      if (!ownerId || signal.aborted) return;
      pendingWrite = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!running) void sync();
      }, debounceMs);
    };
    const quarantined = new Map<string, number>();
    const sync = (retry = false) => {
      if (!ownerId || signal.aborted) return Promise.resolve();
      if (running) return running;
      if (retry) quarantined.clear();
      lastStartedAt = performance.now();
      pendingWrite = false;
      clearTimeout(timer);
      publish({ syncState: 'syncing', error: '' });
      running = (async () => {
        try {
          let cloud = await requestWorkspace();
          if (signal.aborted) return;
          const local = await mergeRemoteWorkspace(ownerId, cloud.items, cloud.serverTime, signal);
          publish({ cloudLoaded: true });
          let refreshAfterUpload = false;
          const upload = async (remaining: Set<string>): Promise<void> => {
            if (signal.aborted) return;
            // A local edit or deletion can land while another chunk is in flight.
            const latest = await readWorkspace(ownerId);
            if (signal.aborted) return;
            const pending = newerWorkspaceItems(latest, cloud.items).filter((item) => {
              const key = workspaceItemKey(item);
              return remaining.has(key) && quarantined.get(key) !== item.updatedAt;
            });
            const [batch] = chunkWorkspaceItems(pending, (item) => {
              const key = workspaceItemKey(item);
              quarantined.set(key, item.updatedAt);
              remaining.delete(key);
            });
            if (!batch) { remaining.clear(); return; }
            for (const item of batch) remaining.delete(workspaceItemKey(item));
            try {
              const response = await requestWorkspace(batch);
              if (response.acknowledged) {
                // The server may have a newer value, so this is temporary until the
                // final complete read, not an authoritative local merge.
                cloud = { ...cloud, items: mergeWorkspaceItems(cloud.items, batch) };
                refreshAfterUpload = true;
              } else cloud = response;
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 400) throw error;
              if (batch.length === 1) {
                const item = batch[0];
                quarantined.set(workspaceItemKey(item), item.updatedAt);
                return;
              }
              const midpoint = Math.floor(batch.length / 2);
              for (const half of [batch.slice(0, midpoint), batch.slice(midpoint)]) {
                const keys = new Set(half.map(workspaceItemKey));
                while (keys.size && !signal.aborted) await upload(keys);
              }
              return;
            }
            if (!signal.aborted && !refreshAfterUpload) await mergeRemoteWorkspace(ownerId, cloud.items, cloud.serverTime, signal);
          };
          const remaining = new Set(newerWorkspaceItems(local, cloud.items).map(workspaceItemKey));
          while (remaining.size && !signal.aborted) await upload(remaining);
          if (signal.aborted) return;
          if (refreshAfterUpload) {
            cloud = await requestWorkspace();
            if (signal.aborted) return;
            await mergeRemoteWorkspace(ownerId, cloud.items, cloud.serverTime, signal);
          }
          const latest = await readWorkspace(ownerId);
          const rejected = newerWorkspaceItems(latest, cloud.items).filter((item) =>
            quarantined.get(workspaceItemKey(item)) === item.updatedAt);
          if (rejected.length) {
            failed(new Error(`${rejected.length} 项资料无法同步，已保存在本机`));
          } else {
            publish({ syncState: 'synced', error: '' });
          }
        } catch (error) {
          failed(error);
        } finally {
          running = undefined;
          if (pendingWrite) schedule();
        }
      })();
      return running;
    };
    const unsubscribe = subscribeWorkspace(ownerId, (local, items) => {
      if (items) publish({ items, ready: true });
      else void refresh();
      if (local) schedule();
    });
    lifecycle.current = { ownerId, sync: () => sync(true) };
    void refresh().then(() => sync());
    const poll = () => {
      if (performance.now() - lastStartedAt >= pollMs) void sync();
    };
    const interval = ownerId ? setInterval(poll, pollMs) : undefined;
    if (ownerId) window.addEventListener('focus', poll);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(interval);
      unsubscribe();
      window.removeEventListener('focus', poll);
      lifecycle.current = null;
    };
  }, [enabled, ownerId]);

  const put = useCallback(<K extends WorkspaceKind>(kind: K, id: string, value: WorkspaceValues[K]) =>
    putWorkspaceValue(ownerId, kind, id, value), [ownerId]);
  const remove = useCallback((kind: WorkspaceKind, id: string) =>
    deleteWorkspaceValue(ownerId, kind, id), [ownerId]);
  const settingsAvailable = !ownerId || (view.ownerId === ownerId && (view.cloudLoaded || workspaceValue(view.items, 'settings', 'preferences') !== undefined));
  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    if (!settingsAvailable) return Promise.reject(new Error('账号设置尚未读取'));
    return mutateWorkspaceValue(ownerId, 'settings', 'preferences', (_saved, items) => ({ ...workspaceSettings(items), ...patch }));
  }, [ownerId, settingsAvailable]);
  const toggleFavorite = useCallback((id: string) =>
    mutateWorkspaceValue(ownerId, 'favorite', id, (old) => old ? undefined : { articleId: id }), [ownerId]);
  const sync = useCallback(() =>
    enabled && lifecycle.current?.ownerId === ownerId ? lifecycle.current.sync() : Promise.resolve(), [enabled, ownerId]);

  const visible = enabled && view.ownerId === ownerId ? view : undefined;
  const items = visible?.items ?? emptyItems;
  const values = useMemo(() => {
    const active = items.filter((item) => !item.deleted);
    const get = <K extends WorkspaceKind>(kind: K) => active.filter((item) => item.kind === kind).map((item) => item.value as WorkspaceValues[K]);
    return {
      settings: workspaceSettings(items),
      hasSavedSettings: workspaceValue(items, 'settings', 'preferences') !== undefined,
      backgrounds: { light: workspaceValue(items, 'background', 'light'), dark: workspaceValue(items, 'background', 'dark') },
      favorites: get('favorite').map((favorite) => favorite.articleId),
      privateArticles: get('article'),
      drafts: get('draft').sort((a, b) => b.savedAt - a.savedAt),
      deletedDraftIds: items.filter((item) => item.kind === 'draft' && item.deleted).map((item) => item.id) as readonly string[],
      records: get('record').sort((a, b) => b.finishedAt - a.finishedAt),
    };
  }, [items, ownerId, visible?.ready]);

  return {
    ...values,
    ready: visible?.ready ?? false,
    settingsReady: !!visible?.ready && (!ownerId || visible.cloudLoaded || values.hasSavedSettings),
    cloudLoaded: visible?.cloudLoaded ?? false,
    syncState: visible?.syncState ?? (ownerId ? 'loading' : 'guest'),
    error: visible?.error ?? '',
    put, remove, updateSettings, toggleFavorite, sync,
  };
}
