import type Database from 'better-sqlite3';
import { z } from 'zod';
import { difficulties } from '../src/data/articles';
import type { WorkspaceItem, WorkspaceKind } from '../src/lib/models';
import { isBackgroundConfig, type BackgroundConfig } from '../src/lib/background';

export const syncBodyLimit = 4 * 1024 * 1024;
export const recoveryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const recoveryKeyPattern = /^[A-Za-z0-9_-]{43}$/;
const maxWorkspaceItems = 2000;
const maxWorkspaceBytes = 32 * 1024 * 1024;
const maxElapsedMs = 24 * 60 * 60_000;
const clockGraceMs = 5 * 60_000;
const id = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const timestamp = z.number().int().nonnegative();
const integer = (max: number) => z.number().int().min(0).max(max);
const duration = z.number().int().min(60).max(3600).multipleOf(60);
const language = z.enum(['zh', 'en']);
const difficulty = z.enum(difficulties);
const mode = z.enum(['timed', 'article']);
const source = z.object({
  name: z.string().min(1).max(300),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  license: z.enum(['public-domain', 'reusable']),
});
const snapshot = z.object({
  id, title: z.string().min(1).max(200), text: z.string().min(1).max(30_000),
  language, difficulty, custom: z.boolean(),
  author: z.string().max(300).optional(), theme: z.string().max(300).optional(), source: source.optional(),
});
const mistakes = z.array(z.object({
  position: integer(30_000), expected: z.string().max(200), actual: z.string().max(200),
})).max(500).optional();
const stats = {
  elapsedMs: z.number().min(0).max(maxElapsedMs),
  backspaces: integer(10_000_000),
  errors: integer(30_000),
  typed: z.string().max(30_000),
  offset: integer(30_000),
};
const schemas = {
  background: z.custom<BackgroundConfig>(isBackgroundConfig),
  favorite: z.object({ articleId: id }),
  article: snapshot.extend({ custom: z.literal(true), text: z.string().min(1).max(20_000) }),
  draft: z.object({
    id, article: snapshot, typed: stats.typed, elapsedMs: stats.elapsedMs, backspaces: stats.backspaces,
    duration, mode, strict: z.boolean(), offset: stats.offset, recordId: id,
    attemptId: id.optional(), offline: z.boolean(), ownerId: id.nullable().optional(), savedAt: timestamp, mistakes, suspicious: z.boolean().optional(),
    recoveryId: z.string().regex(recoveryIdPattern).optional(),
    recoveryKey: z.string().regex(recoveryKeyPattern).optional(),
    personalOnly: z.boolean().optional(),
    claimId: z.string().regex(recoveryIdPattern).optional(),
    claimVersion: integer(Number.MAX_SAFE_INTEGER).optional(),
    recoveryRequestId: z.string().regex(recoveryIdPattern).optional(),
    recoveryMarker: z.string().regex(recoveryIdPattern).optional(),
    recoveryBaseVersion: integer(Number.MAX_SAFE_INTEGER).optional(),
    progressVersion: integer(Number.MAX_SAFE_INTEGER).optional(),
  }),
  record: z.object({
    language, difficulty, duration, speed: z.number().min(0).max(18_000_000), accuracy: z.number().min(0).max(100),
    finishedAt: timestamp, status: z.string().max(40).optional(),
    elapsedMs: stats.elapsedMs.optional(), backspaces: stats.backspaces.optional(), errors: stats.errors.optional(),
    recordId: id.optional(), ownerId: id.nullable().optional(), localOnly: z.boolean().optional(),
    article: snapshot.optional(), typed: stats.typed.optional(), offset: stats.offset.optional(),
    total: integer(30_000).optional(), correct: integer(30_000).optional(), articleTotal: integer(30_000).optional(),
    mode: mode.optional(), strict: z.boolean().optional(), mistakes,
  }),
  settings: z.object({
    minutes: z.number().int().min(1).max(60), mode, strict: z.boolean(), autoPause: z.boolean(),
    fontSize: z.number().min(12).max(40), lineHeight: z.number().min(1).max(3),
    visibleLines: z.number().int().min(1).max(12), theme: z.enum(['light', 'dark']),
  }),
} satisfies Record<WorkspaceKind, z.ZodType>;
const item = z.object({
  kind: z.enum(['favorite', 'article', 'draft', 'record', 'settings', 'background']),
  id, updatedAt: timestamp, deleted: z.boolean().optional(), value: z.unknown().optional(),
});
const batch = z.array(item).max(100);

function stripDraftLease(value: unknown) {
  if (typeof value === 'object' && value !== null) {
    if ('claimId' in value) delete value.claimId;
    if ('recoveryRequestId' in value) delete value.recoveryRequestId;
  }
  return value;
}

export function validateWorkspaceItems(items: unknown, owner: string, now: number): WorkspaceItem[] | null {
  const parsed = batch.safeParse(items);
  if (!parsed.success) return null;
  const validated: WorkspaceItem[] = [];
  for (const { kind, id, updatedAt, deleted, value } of parsed.data) {
    if (updatedAt > now + clockGraceMs) return null;
    if (kind === 'background' && id !== 'light' && id !== 'dark') return null;
    if (deleted) {
      validated.push({ kind, id, updatedAt, deleted: true });
      continue;
    }
    const result = schemas[kind].safeParse(value);
    if (!result.success) return null;
    const data = result.data;
    if ('id' in data && data.id !== id) return null;
    if ('articleId' in data && data.articleId !== id) return null;
    if ('recordId' in data && kind === 'record' && data.recordId !== undefined && data.recordId !== id) return null;
    if (('savedAt' in data && data.savedAt > now + clockGraceMs) ||
      ('finishedAt' in data && data.finishedAt > now + clockGraceMs)) return null;
    if (kind === 'draft' || 'ownerId' in data) Object.assign(data, { ownerId: owner });
    validated.push({ kind, id, updatedAt, value: kind === 'draft' ? stripDraftLease(data) : data });
  }
  return validated;
}

export function createWorkspaceStore(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_items (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, item_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
      value TEXT, PRIMARY KEY(user_id, kind, item_id)
    );
  `);
  const read = db.prepare(`SELECT kind, item_id AS id, updated_at AS updatedAt, value
    FROM workspace_items WHERE user_id=? ORDER BY kind, item_id`);
  const limits = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(value AS BLOB))), 0) AS bytes FROM workspace_items WHERE user_id=?');
  const storedClaim = "COALESCE(json_extract(workspace_items.value, '$.claimVersion'), 0)";
  const incomingClaim = "COALESCE(json_extract(excluded.value, '$.claimVersion'), 0)";
  const storedProgress = "json_extract(workspace_items.value, '$.progressVersion')";
  const incomingProgress = "json_extract(excluded.value, '$.progressVersion')";
  const storedMarker = "json_extract(workspace_items.value, '$.recoveryMarker')";
  const incomingMarker = "json_extract(excluded.value, '$.recoveryMarker')";
  const storedRecoveryBase = "COALESCE(json_extract(workspace_items.value, '$.recoveryBaseVersion'), 0)";
  const incomingRecoveryBase = "COALESCE(json_extract(excluded.value, '$.recoveryBaseVersion'), 0)";
  const upsert = db.prepare(`INSERT INTO workspace_items(user_id, kind, item_id, updated_at, value)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, kind, item_id) DO UPDATE SET
    updated_at=excluded.updated_at, value=excluded.value
    WHERE CASE
      WHEN excluded.kind='draft' AND (excluded.value IS NULL) != (workspace_items.value IS NULL)
        THEN excluded.value IS NULL
      WHEN excluded.kind='draft' AND ${incomingClaim} != ${storedClaim}
        THEN ${incomingClaim} > ${storedClaim}
      WHEN excluded.kind='draft' AND ${incomingMarker} IS NOT NULL AND ${incomingMarker} IS NOT ${storedMarker}
        AND ${incomingRecoveryBase} < ${storedProgress}
        THEN FALSE
      WHEN excluded.kind='draft' AND ${storedMarker} IS NOT NULL AND ${storedMarker} IS NOT ${incomingMarker}
        AND ${storedRecoveryBase} < ${incomingProgress}
        THEN TRUE
      WHEN excluded.kind='draft' AND ${incomingProgress} != ${storedProgress}
        THEN ${incomingProgress} > ${storedProgress}
      ELSE excluded.updated_at > workspace_items.updated_at
    END`);
  const merge = db.transaction((owner: string, items: WorkspaceItem[]) => {
    for (const { kind, id, updatedAt, deleted, value } of items) {
      upsert.run(owner, kind, id, updatedAt, deleted ? null : JSON.stringify(value));
    }
    const { count, bytes } = limits.get(owner) as { count: number; bytes: number };
    if (count > maxWorkspaceItems || bytes > maxWorkspaceBytes) throw new WorkspaceLimitError();
  });
  const get = (owner: string): WorkspaceItem[] =>
    (read.all(owner) as Array<Omit<WorkspaceItem, 'value'> & { value: string | null }>).map(({ value, ...item }) => {
      if (value === null) return { ...item, deleted: true };
      const data: unknown = JSON.parse(value);
      return { ...item, value: item.kind === 'draft' ? stripDraftLease(data) : data };
    });
  return { get, merge };
}

export class WorkspaceLimitError extends Error {}
