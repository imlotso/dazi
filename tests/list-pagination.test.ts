import { afterEach, expect, it, vi } from 'vitest';
import { apiPages } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

it('returns all list pages and discards a partial response after interruption', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    const cursor = new Headers(options.headers).get('X-List-Cursor');
    if (cursor && fail) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify(cursor ? { entries: ['second'], nextCursor: null } : { entries: ['first'], nextCursor: 'next' }));
  }));
  await expect(apiPages<string>('/api/history', 'entries')).rejects.toThrow();
  fail = false;
  await expect(apiPages<string>('/api/history', 'entries')).resolves.toEqual(['first', 'second']);
});
