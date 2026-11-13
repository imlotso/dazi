import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('API client', () => {
  it('times out even if response headers arrive but the body stalls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    })));
    await expect(api('/api/test', { timeoutMs: 25 })).rejects.toThrow('暂时无法连接服务');
  }, 300);

  it('rejects a successful response that is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('not JSON'); } })));
    await expect(api('/api/test')).rejects.toThrow('服务返回的数据无法读取');
  });
});
