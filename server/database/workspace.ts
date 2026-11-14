import { createHash } from 'node:crypto';
import type { WorkspaceItem } from '../../src/lib/models.js';
import { newerWorkspaceItems } from '../../src/lib/workspace.js';
import { WorkspaceChangedError, WorkspaceCursorError, WorkspaceLimitError, WorkspacePageSizeError } from '../workspace.js';
import type { AsyncDatabase } from './types.js';

const maxWorkspaceItems = 2000;
const maxWorkspaceBytes = 32 * 1024 * 1024;
const maxPageBytes = 2 * 1024 * 1024;
const kinds = ['article', 'background', 'draft', 'favorite', 'record', 'settings'];
type Stored = Omit<WorkspaceItem, 'value'> & { value: string | null };

function decode(row: Stored): WorkspaceItem {
  const { value, ...item } = row;
  if (value === null) return { ...item, deleted: true };
  const data: unknown = JSON.parse(value);
  if (item.kind === 'draft' && data && typeof data === 'object') {
    if ('claimId' in data) delete data.claimId;
    if ('recoveryRequestId' in data) delete data.recoveryRequestId;
  }
  return { ...item, value: data };
}

export async function createAsyncWorkspaceStore(db: AsyncDatabase) {
  if (db.dialect === 'sqlite') await db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_items (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, item_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
      value TEXT, PRIMARY KEY(user_id,kind,item_id)
    );
    CREATE TABLE IF NOT EXISTS workspace_revisions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0
    );
  `);
  const select = 'SELECT kind,item_id AS id,updated_at AS updatedAt,value FROM workspace_items';
  const getRows = db.prepare(`${select} WHERE user_id=? ORDER BY kind,item_id`);
  const getOne = db.prepare(`${select} WHERE user_id=? AND kind=? AND item_id=?`);
  const getBackgrounds = db.prepare(`${select} WHERE user_id=? AND kind='background' ORDER BY kind,item_id`);
  const collation = db.dialect === 'postgres' ? ' COLLATE "C"' : '';
  const getPage = db.prepare(`${select} WHERE user_id=? AND (?=0 OR kind!='background')
    AND (kind${collation}>? OR (kind${collation}=? AND item_id${collation}>?)) ORDER BY kind${collation},item_id${collation} LIMIT 101`);
  const limits = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${db.dialect === 'postgres' ? 'octet_length(value)' : 'length(CAST(value AS BLOB))'}),0) AS bytes FROM workspace_items WHERE user_id=?`);
  const upsert = db.prepare(`INSERT INTO workspace_items(user_id,kind,item_id,updated_at,value) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id,kind,item_id) DO UPDATE SET updated_at=excluded.updated_at,value=excluded.value`);
  const readRevision = db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=?');
  const bumpRevision = db.prepare(`INSERT INTO workspace_revisions(user_id,revision) VALUES (?,1)
    ON CONFLICT(user_id) DO UPDATE SET revision=workspace_revisions.revision+1`);

  const merge = db.transaction(async (owner: string, items: WorkspaceItem[]) => {
    let changed = false;
    for (const item of items) {
      const row = await getOne.get(owner, item.kind, item.id) as Stored | undefined;
      if (row && !newerWorkspaceItems([item], [decode(row)]).length) continue;
      await upsert.run(owner, item.kind, item.id, item.updatedAt, item.deleted ? null : JSON.stringify(item.value));
      changed = true;
    }
    const { count, bytes } = await limits.get(owner) as { count: number; bytes: number };
    if (count > maxWorkspaceItems || bytes > maxWorkspaceBytes) throw new WorkspaceLimitError();
    if (changed) await bumpRevision.run(owner);
  });
  const get = async (owner: string) => (await getRows.all(owner) as Stored[]).map(decode);
  const backgroundState = async (owner: string, known: string | undefined) => {
    const backgrounds = (await getBackgrounds.all(owner) as Stored[]).map(decode);
    const backgroundsVersion = createHash('sha256').update(owner).update(JSON.stringify(backgrounds)).digest('hex');
    return { backgroundsVersion, backgroundsUnchanged: known === backgroundsVersion };
  };
  const pagedSnapshot = db.transaction(async (owner: string, cursor: string | undefined, known: string | undefined) => {
    const { backgroundsVersion, backgroundsUnchanged } = await backgroundState(owner, known);
    const revision = (await readRevision.get(owner) as { revision: number } | undefined)?.revision ?? 0;
    let kind = '';
    let id = '';
    if (cursor !== undefined) {
      try {
        if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 3 || !Number.isSafeInteger(parsed[0]) ||
          typeof parsed[1] !== 'string' || !kinds.includes(parsed[1]) ||
          typeof parsed[2] !== 'string' || !parsed[2] || parsed[2].length > 200) throw new Error();
        if (parsed[0] !== revision) throw new WorkspaceChangedError();
        [, kind, id] = parsed;
      } catch (error) {
        if (error instanceof WorkspaceChangedError) throw error;
        throw new WorkspaceCursorError();
      }
    }
    const candidates = (await getPage.all(owner, Number(backgroundsUnchanged), kind, kind, id) as Stored[]).map(decode);
    const items: WorkspaceItem[] = [];
    let bytes = 4096;
    for (const candidate of candidates) {
      const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
      if (bytes + size > maxPageBytes || items.length >= 100) {
        if (!items.length) throw new WorkspacePageSizeError();
        break;
      }
      bytes += size;
      items.push(candidate);
    }
    const last = items.at(-1);
    const nextCursor = last && items.length < candidates.length
      ? Buffer.from(JSON.stringify([revision, last.kind, last.id])).toString('base64url') : null;
    return { items, nextCursor, backgroundsVersion, backgroundsUnchanged };
  });
  return { merge, get, pagedSnapshot, backgroundState };
}
