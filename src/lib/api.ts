export async function api<T>(path: string, options?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options?.method ?? 'GET',
      credentials: 'same-origin',
      headers: options?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error('暂时无法连接服务，请检查网络后重试');
  }
  let data: { error?: string } = {};
  try { data = await response.json(); } catch { /* A server error may not be JSON. */ }
  if (!response.ok) throw new Error(data.error || '操作未完成，请稍后重试');
  return data as T;
}

export type User = { id: string; username: string; email: string; isAdmin: boolean };
