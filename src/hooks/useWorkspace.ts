import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ReaderSettings, SyncState, WorkspaceItem, WorkspaceKind, WorkspaceValues } from '../lib/models';
import {
  cachedWorkspace, chunkWorkspaceItems, deleteWorkspaceValue, isWorkspaceItem, mergeRemoteWorkspace, mutateWorkspaceValue,
  newerWorkspaceItems, putWorkspaceValue, readWorkspace, subscribeWorkspace, workspaceItemKey, workspaceSettings,
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
type Response = { items: WorkspaceItem[]; serverTime: number };

async function workspaceRequest(owner: string, signal: AbortSignal, items?: WorkspaceItem[]): Promise<Response> {
  const data = await api<Response>(items === undefined ? '/api/workspace' : '/api/workspace/sync', {
    method: items === undefined ? 'GET' : 'POST',
    body: items === undefined ? undefined : { items },
    headers: { 'X-Workspace-Owner': owner },
    signal,
  });
  if (!Array.isArray(data.items) || data.items.length > 2000 || !data.items.every(isWorkspaceItem) ||
    !Number.isSafeInteger(data.serverTime) || data.serverTime <= 0) {
    throw new Error('同步数据无法读取');
  }
  return data;
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
          let cloud = await workspaceRequest(ownerId, signal);
          if (signal.aborted) return;
          const local = await mergeRemoteWorkspace(ownerId, cloud.items, cloud.serverTime, signal);
          publish({ cloudLoaded: true });
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
              cloud = await workspaceRequest(ownerId, signal, batch);
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
            if (!signal.aborted) await mergeRemoteWorkspace(ownerId, cloud.items, cloud.serverTime, signal);
          };
          const remaining = new Set(newerWorkspaceItems(local, cloud.items).map(workspaceItemKey));
          while (remaining.size && !signal.aborted) await upload(remaining);
          if (signal.aborted) return;
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
  const updateSettings = useCallback((patch: Partial<ReaderSettings>) =>
    mutateWorkspaceValue(ownerId, 'settings', 'preferences', (_saved, items) => ({ ...workspaceSettings(items), ...patch })), [ownerId]);
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
    cloudLoaded: visible?.cloudLoaded ?? false,
    syncState: visible?.syncState ?? (ownerId ? 'loading' : 'guest'),
    error: visible?.error ?? '',
    put, remove, updateSettings, toggleFavorite, sync,
  };
}
