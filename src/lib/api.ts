export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly claimVersion?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; timeoutMs?: number; headers?: HeadersInit }): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timeout = setTimeout(cancel, options?.timeoutMs ?? 12_000);
  options?.signal?.addEventListener('abort', cancel, { once: true });
  if (options?.signal?.aborted) cancel();
  try {
    let response: Response;
    try {
      const headers = new Headers(options?.headers);
      if (options?.body !== undefined) headers.set('Content-Type', 'application/json');
      response = await fetch(path, {
        method: options?.method ?? 'GET',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: options?.body === undefined && !options?.headers ? undefined : headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new Error('暂时无法连接服务，请检查网络后重试');
    }
    let data: unknown;
    try { data = await response.json(); }
    catch (error) {
      if (options?.signal?.aborted) throw error;
      if (controller.signal.aborted) throw new Error('暂时无法连接服务，请检查网络后重试');
      throw new Error(response.ok ? '服务返回的数据无法读取' : '操作未完成，请稍后重试');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务返回的数据无法读取');
    if (!response.ok) {
      const failure = data as { error?: string; code?: string; claimVersion?: number; currentClaimVersion?: number };
      throw new ApiError(failure.error || '操作未完成，请稍后重试', response.status, failure.code, failure.currentClaimVersion ?? failure.claimVersion);
    }
    return data as T;
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener('abort', cancel);
  }
}

/** Collect a whole bounded list before the caller replaces any visible data. */
export async function apiPages<T>(path: string, field: 'articles' | 'entries', options?: { signal?: AbortSignal; headers?: HeadersInit }): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const headers = new Headers(options?.headers);
    headers.set('X-List-Paged', '1');
    if (cursor) headers.set('X-List-Cursor', cursor);
    const page = await api<Record<string, unknown>>(path, { signal: options?.signal, headers });
    if (!Array.isArray(page[field])) throw new Error('服务返回的数据无法读取');
    result.push(...page[field] as T[]);
    const next = page.nextCursor;
    if (next !== undefined && next !== null && (typeof next !== 'string' || !next || next.length > 2048)) throw new Error('服务返回的数据无法读取');
    cursor = typeof next === 'string' ? next : undefined;
    if (cursor && (seen.has(cursor) || seen.size >= 2000)) throw new Error('服务返回的数据无法读取');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}

export type User = { id: string; username: string; email: string; isAdmin: boolean };
