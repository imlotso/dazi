import { defaultSettings, type ReaderSettings, type WorkspaceItem, type WorkspaceKind, type WorkspaceValues } from './models';
import { themeStorageKey } from './theme';

const databaseName = 'cloudtyping-workspace';
const itemStore = 'items';
const storagePrefix = 'cloudtyping.workspace.v1.';
const maxChunkBytes = 3 * 1024 * 1024;
const maxChunkItems = 100;
const queues = new Map<string, Promise<unknown>>();
const clocks = new Map<string, { serverTime: number; observedAt: number }>();
const caches = new Map<string, WorkspaceItem[]>();
const listeners = new Set<(owner: string, local: boolean, items?: WorkspaceItem[]) => void>();
let database: Promise<IDBDatabase | null> | undefined;
let channel: BroadcastChannel | undefined;

const scope = (ownerId: string | null) => ownerId === null ? 'guest' : 'user:' + ownerId;
export const workspaceItemKey = ({ kind, id }: Pick<WorkspaceItem, 'kind' | 'id'>) => kind + ':' + id;
const keyOf = workspaceItemKey;

const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const isLanguage = (value: unknown) => value === 'zh' || value === 'en';
const isDifficulty = (value: unknown) => ['beginner', 'intermediate', 'advanced'].includes(value as string);
const isMode = (value: unknown) => value === 'timed' || value === 'article';
const isTheme = (value: unknown) => value === 'light' || value === 'dark';
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isArticle = (value: unknown) => isObject(value) && typeof value.id === 'string' &&
  typeof value.title === 'string' && typeof value.text === 'string' &&
  isLanguage(value.language) && isDifficulty(value.difficulty) && typeof value.custom === 'boolean';

export function isWorkspaceItem(value: unknown): value is WorkspaceItem {
  if (!isObject(value)) return false;
  const { kind, id, updatedAt, deleted, value: payload } = value;
  if (!['favorite', 'article', 'draft', 'record', 'settings'].includes(kind as string) ||
    typeof id !== 'string' || !id || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0 ||
    (deleted !== undefined && typeof deleted !== 'boolean')) return false;
  if (deleted) return true;
  if (!isObject(payload)) return false;
  switch (kind) {
    case 'favorite': return payload.articleId === id;
    case 'article': return payload.id === id && payload.custom === true && isArticle(payload);
    case 'draft': return payload.id === id && isArticle(payload.article) &&
      typeof payload.typed === 'string' && typeof payload.recordId === 'string' &&
      typeof payload.offline === 'boolean' && typeof payload.strict === 'boolean' && isMode(payload.mode) &&
      [payload.duration, payload.elapsedMs, payload.offset, payload.backspaces, payload.savedAt].every(isNumber);
    case 'record': return isLanguage(payload.language) && isDifficulty(payload.difficulty) &&
      [payload.speed, payload.accuracy, payload.duration, payload.finishedAt].every(isNumber) &&
      (payload.article === undefined || isArticle(payload.article)) &&
      (payload.typed === undefined || typeof payload.typed === 'string');
    case 'settings': return Number.isInteger(payload.minutes) && isTheme(payload.theme) && isMode(payload.mode) &&
      typeof payload.autoPause === 'boolean' && typeof payload.strict === 'boolean' &&
      [payload.fontSize, payload.lineHeight, payload.visibleLines].every(isNumber);
    default: return false;
  }
}

function replacesItem(previous: WorkspaceItem | undefined, incoming: WorkspaceItem, includeTies: boolean) {
  if (!previous) return true;
  if (incoming.kind === 'draft' && !!incoming.deleted !== !!previous.deleted) return !!incoming.deleted;
  return incoming.updatedAt > previous.updatedAt || (includeTies && incoming.updatedAt === previous.updatedAt);
}

export function mergeWorkspaceItems(local: WorkspaceItem[], incoming: WorkspaceItem[]): WorkspaceItem[] {
  const merged = new Map(local.map((item) => [keyOf(item), item]));
  for (const item of incoming) {
    const key = keyOf(item);
    const previous = merged.get(key);
    if (replacesItem(previous, item, true)) merged.set(key, item);
  }
  return [...merged.values()];
}

export function newerWorkspaceItems(local: WorkspaceItem[], remote: WorkspaceItem[]): WorkspaceItem[] {
  const server = new Map(remote.map((item) => [keyOf(item), item]));
  return local.filter((item) => replacesItem(server.get(keyOf(item)), item, false));
}

export function chunkWorkspaceItems(
  items: WorkspaceItem[], onOversized?: (item: WorkspaceItem) => void,
): WorkspaceItem[][] {
  const encoder = new TextEncoder();
  const envelopeBytes = encoder.encode(JSON.stringify({ items: [] })).byteLength;
  const chunks: WorkspaceItem[][] = [];
  let chunk: WorkspaceItem[] = [];
  let bytes = envelopeBytes;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).byteLength;
    if (size + envelopeBytes > maxChunkBytes) {
      if (!onOversized) throw new Error('同步项目超过大小限制');
      onOversized(item);
      continue;
    }
    if (chunk.length === maxChunkItems || bytes + size + (chunk.length ? 1 : 0) > maxChunkBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = envelopeBytes;
    }
    bytes += size + (chunk.length ? 1 : 0);
    chunk.push(item);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

type StoredItem = WorkspaceItem & { owner: string };
type Edit = (items: WorkspaceItem[]) => WorkspaceItem[];

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  database ??= new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(databaseName, 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      request.result.createObjectStore(itemStore, { keyPath: ['owner', 'kind', 'id'] }).createIndex('owner', 'owner');
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  return database;
}

function readFallback(owner: string): WorkspaceItem[] {
  const raw = localStorage.getItem(storagePrefix + owner);
  if (!raw) return [];
  const result: unknown = JSON.parse(raw);
  if (!Array.isArray(result) || !result.every(isWorkspaceItem)) throw new Error('本地练习资料无法读取');
  return result;
}

async function access(owner: string, edit?: Edit): Promise<WorkspaceItem[]> {
  const db = await openDatabase();
  if (!db) {
    const current = readFallback(owner);
    if (!edit) return current;
    const next = edit(current);
    if (next !== current) localStorage.setItem(storagePrefix + owner, JSON.stringify(next));
    return next;
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(itemStore, edit ? 'readwrite' : 'readonly');
    const store = transaction.objectStore(itemStore);
    const request = store.index('owner').getAll(owner);
    let next: WorkspaceItem[];
    let editError: unknown;
    transaction.oncomplete = () => resolve(next);
    transaction.onabort = () => reject(editError ?? transaction.error ?? new Error('本地练习资料保存失败'));
    request.onsuccess = () => {
      const current = (request.result as StoredItem[]).map(({ owner: _owner, ...item }) => item);
      try {
        next = edit?.(current) ?? current;
        if (!edit || next === current) return;
        const previous = new Map(current.map((item) => [keyOf(item), item]));
        for (const item of next) {
          if (previous.get(keyOf(item)) !== item) store.put({ ...item, owner });
        }
      } catch (error) {
        editError = error;
        transaction.abort();
      }
    };
  });
}

function serialized<T>(owner: string, operation: () => Promise<T>): Promise<T> {
  const pending = (queues.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(owner, pending);
  const remove = () => { if (queues.get(owner) === pending) queues.delete(owner); };
  void pending.then(remove, remove);
  return pending;
}

function broadcastChannel() {
  if (typeof indexedDB === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  if (!channel) {
    try {
      channel = new BroadcastChannel(databaseName);
      channel.onmessage = ({ data }) => {
        if (typeof data?.owner === 'string' && typeof data.local === 'boolean') {
          caches.delete(data.owner);
          for (const listener of listeners) listener(data.owner, data.local);
        }
      };
    } catch { /* The current tab still receives updates. */ }
  }
  return channel;
}

export function subscribeWorkspace(ownerId: string | null, listener: (local: boolean, items?: WorkspaceItem[]) => void) {
  const owner = scope(ownerId);
  const notify = (changedOwner: string, local: boolean, items?: WorkspaceItem[]) => {
    if (owner === changedOwner) listener(local, items);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === storagePrefix + owner || event.key === null) {
      caches.delete(owner);
      listener(true);
    }
  };
  listeners.add(notify);
  broadcastChannel();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(notify);
    window.removeEventListener('storage', onStorage);
    if (!listeners.size) { channel?.close(); channel = undefined; }
  };
}

export function readWorkspace(ownerId: string | null): Promise<WorkspaceItem[]> {
  const owner = scope(ownerId);
  return serialized(owner, async () => {
    const items = await access(owner);
    if (typeof indexedDB !== 'undefined') caches.set(owner, items);
    return items;
  });
}

export function cachedWorkspace(ownerId: string | null): WorkspaceItem[] | undefined {
  return typeof indexedDB === 'undefined' ? undefined : caches.get(scope(ownerId));
}

export function isWorkspaceDraftDeleted(ownerId: string | null, id: string): boolean {
  try {
    const items = cachedWorkspace(ownerId) ?? readFallback(scope(ownerId));
    return items.some((item) => item.kind === 'draft' && item.id === id && item.deleted);
  } catch { return false; }
}

export class DraftDeletedError extends Error {
  constructor(public readonly id: string) {
    super('此草稿已删除');
    this.name = 'DraftDeletedError';
  }
}

function editWorkspace(ownerId: string | null, edit: Edit, local: boolean): Promise<WorkspaceItem[]> {
  const owner = scope(ownerId);
  return serialized(owner, async () => {
    let changed = false;
    const items = await access(owner, (current) => {
      // Preserve the latest committed read for callers recovering from a rejected write.
      if (typeof indexedDB !== 'undefined') caches.set(owner, current);
      const next = edit(current);
      changed = next !== current;
      return next;
    });
    if (typeof indexedDB !== 'undefined') caches.set(owner, items);
    if (changed) {
      for (const listener of listeners) listener(owner, local, items);
      const broadcaster = broadcastChannel();
      broadcaster?.postMessage({ owner, local });
      if (!listeners.size) { broadcaster?.close(); channel = undefined; }
    }
    return items;
  });
}

function estimatedServerTime(ownerId: string | null) {
  const clock = clocks.get(scope(ownerId));
  return clock ? clock.serverTime + Math.round(performance.now() - clock.observedAt) : Date.now();
}

export function mergeRemoteWorkspace(ownerId: string, items: WorkspaceItem[], serverTime: number, signal: AbortSignal) {
  return editWorkspace(ownerId, (current) => {
    if (signal.aborted) return current;
    clocks.set(scope(ownerId), { serverTime, observedAt: performance.now() });
    const safeTime = estimatedServerTime(ownerId) + 4 * 60_000;
    const normalized = current.map((item) => {
      const value = item.value as { finishedAt?: number; savedAt?: number } | undefined;
      if (item.updatedAt <= safeTime && (value?.finishedAt ?? 0) <= safeTime && (value?.savedAt ?? 0) <= safeTime) return item;
      return {
        ...item, updatedAt: Math.min(item.updatedAt, safeTime), ...(value && { value: {
          ...value,
          ...(value.finishedAt !== undefined && { finishedAt: Math.min(value.finishedAt, safeTime) }),
          ...(value.savedAt !== undefined && { savedAt: Math.min(value.savedAt, safeTime) }),
        } }),
      };
    });
    const merged = mergeWorkspaceItems(normalized, items);
    // Server responses can include the entire workspace for every chunk. Avoid
    // rewriting records that already match the stored copy.
    const previous = new Map(current.map((item) => [keyOf(item), item]));
    const next = merged.map((item) => {
      const stored = previous.get(keyOf(item));
      return stored && stored.updatedAt === item.updatedAt &&
        !!stored.deleted === !!item.deleted && JSON.stringify(stored.value) === JSON.stringify(item.value) ? stored : item;
    });
    return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
  }, false);
}

export function workspaceValue<K extends WorkspaceKind>(items: WorkspaceItem[], kind: K, id: string): WorkspaceValues[K] | undefined {
  const item = items.find((entry) => entry.kind === kind && entry.id === id);
  return !item?.deleted ? item?.value as WorkspaceValues[K] | undefined : undefined;
}

export function workspaceSettings(items: WorkspaceItem[]): ReaderSettings {
  const saved = workspaceValue(items, 'settings', 'preferences');
  if (saved) return { ...defaultSettings, ...saved };
  try {
    const theme = localStorage.getItem(themeStorageKey);
    if (theme === 'light' || theme === 'dark') return { ...defaultSettings, theme };
  } catch { /* Default settings remain available. */ }
  return defaultSettings;
}

export function mutateWorkspaceValue<K extends WorkspaceKind>(
  ownerId: string | null, kind: K, id: string,
  update: (value: WorkspaceValues[K] | undefined, items: WorkspaceItem[]) => WorkspaceValues[K] | undefined,
): Promise<void> {
  return editWorkspace(ownerId, (items) => {
    const old = items.find((item) => item.kind === kind && item.id === id);
    const value = update(old?.deleted ? undefined : old?.value as WorkspaceValues[K] | undefined, items);
    if (kind === 'draft' && old?.deleted) {
      if (value !== undefined) throw new DraftDeletedError(id);
      return items;
    }
    const updatedAt = Math.max(estimatedServerTime(ownerId), (old?.updatedAt ?? -1) + 1);
    const item: WorkspaceItem = value === undefined
      ? { kind, id, updatedAt, deleted: true }
      : { kind, id, updatedAt, value };
    return mergeWorkspaceItems(items, [item]);
  }, true).then(() => {});
}

export function putWorkspaceValue<K extends WorkspaceKind>(ownerId: string | null, kind: K, id: string, value: WorkspaceValues[K]) {
  return mutateWorkspaceValue(ownerId, kind, id, () => value);
}

export function deleteWorkspaceValue(ownerId: string | null, kind: WorkspaceKind, id: string) {
  return mutateWorkspaceValue(ownerId, kind, id, () => undefined);
}
