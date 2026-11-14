import { createHash } from 'node:crypto';

export class ListCursorError extends Error {}
export class ListChangedError extends Error {}
export class ListItemTooLargeError extends Error {}

/** Keep every response below the Function payload limit, and reject mixed snapshots. */
export function listPage<T>(items: T[], cursor: string | undefined) {
  const version = createHash('sha256').update(JSON.stringify(items)).digest('hex');
  let offset = 0;
  if (cursor !== undefined) {
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || !/^[a-f0-9]{64}$/.test(parsed[0]) ||
        !Number.isSafeInteger(parsed[1]) || parsed[1] < 0 || parsed[1] >= items.length) throw new Error();
      if (parsed[0] !== version) throw new ListChangedError();
      offset = parsed[1];
    } catch (error) {
      if (error instanceof ListChangedError) throw error;
      throw new ListCursorError();
    }
  }
  const page: T[] = [];
  let bytes = 4096;
  for (let i = offset; i < items.length; i++) {
    const size = Buffer.byteLength(JSON.stringify(items[i])) + 1;
    if (bytes + size > 2 * 1024 * 1024) {
      if (!page.length) throw new ListItemTooLargeError();
      break;
    }
    bytes += size;
    page.push(items[i]);
  }
  const next = offset + page.length;
  return { items: page, nextCursor: next < items.length ? Buffer.from(JSON.stringify([version, next])).toString('base64url') : null };
}
