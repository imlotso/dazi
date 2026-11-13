export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
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
    if (!response.ok) throw new ApiError((data as { error?: string }).error || '操作未完成，请稍后重试', response.status);
    return data as T;
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener('abort', cancel);
  }
}

export type User = { id: string; username: string; email: string; isAdmin: boolean };
