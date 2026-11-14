import { existsSync, linkSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Client } from 'pg';
import { createApp } from '../app.js';
import { decodeEmail } from '../database/email.js';
import { assertPostgresTarget, type ExpectedTarget } from './migrate.js';
import { dataTables, schemaChecksum, schemaVersion } from './schema.js';

type Column = { name: string; type: string; pk: bigint };
type Row = Record<string, unknown>;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const integer = (column: Column) => /INT/i.test(column.type);
function normalized(row: Row, columns: Column[], table: string, postgres: boolean) {
  return columns.map((column) => {
    const raw = row[column.name];
    const value = postgres && table === 'challenges' && column.name === 'typed' && Buffer.isBuffer(raw) ? raw.toString('utf8')
      : postgres && (table === 'users' || table === 'email_codes') && column.name === 'email' && typeof raw === 'string' ? decodeEmail(raw) : raw;
    if (value === null) return null;
    if (value === undefined || Buffer.isBuffer(value) || typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Unsupported value in ${column.name}`);
    return integer(column) ? String(value) : value;
  });
}
function digest(rows: string[], ordered: boolean) {
  if (!ordered) rows.sort();
  return createHash('sha256').update(rows.join('')).digest('hex');
}
function rowDigest(row: Row, columns: Column[], table: string, postgres: boolean) {
  return createHash('sha256').update(JSON.stringify(normalized(row, columns, table, postgres))).digest('hex');
}

/** Export to a new file only, verifying a repeatable PostgreSQL snapshot before publication. */
export async function exportSqlite(client: Client, destination: string, target: ExpectedTarget) {
  if (!destination) throw new Error('An explicit SQLite destination is required');
  const output = resolve(destination);
  if (existsSync(output)) throw new Error('SQLite destination already exists');
  const temporary = join(dirname(output), `.dazi-export-${randomUUID()}.sqlite`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  closeSync(descriptor);
  let sqlite: Database.Database | undefined;
  let postgresTransaction = false;
  try {
    const app = await createApp({ databasePath: temporary });
    await app.close();
    sqlite = new Database(temporary);
    sqlite.defaultSafeIntegers(true);
    sqlite.pragma('foreign_keys = ON');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    postgresTransaction = true;
    await assertPostgresTarget(client, target);
    await client.query(`SET LOCAL search_path TO ${quote(target.schema)}, pg_catalog`);
    const version = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM dazi_schema_migrations ORDER BY version');
    if (version.rows.length !== 1 || version.rows[0].version !== schemaVersion || version.rows[0].checksum !== schemaChecksum) throw new Error('Unsupported PostgreSQL schema version');
    sqlite.exec('BEGIN IMMEDIATE');
    for (const table of [...dataTables].reverse()) sqlite.exec(`DELETE FROM ${quote(table)}`);
    const counts: Record<string, number> = {};
    for (const table of dataTables) {
      const columns = sqlite.pragma(`table_info(${quote(table)})`) as Column[];
      const pgColumns = await client.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', [target.schema, table]);
      if (columns.map(({ name }) => name).join('\0') !== pgColumns.rows.map(({ column_name }) => column_name).join('\0')) {
        throw new Error(`SQLite and PostgreSQL columns differ for ${table}`);
      }
      const primary = columns.filter(({ pk }) => pk > 0n).sort((a, b) => Number(a.pk - b.pk));
      if (!primary.length) throw new Error(`SQLite table ${table} has no primary key`);
      const names = columns.map(({ name }) => quote(name)).join(',');
      const pgOrder = primary.map((column) => quote(column.name) + (/TEXT/i.test(column.type) ? ' COLLATE "C"' : '')).join(',');
      const sqliteOrder = primary.map(({ name }) => quote(name)).join(',');
      const insert = sqlite.prepare(`INSERT INTO ${quote(table)} (${names}) VALUES (${columns.map(() => '?').join(',')})`);
      const sourceHashes: string[] = [];
      let count = 0;
      for (;;) {
        const page = await client.query<Row>(`SELECT ${names} FROM ${quote(table)} ORDER BY ${pgOrder} LIMIT 100 OFFSET $1`, [count]);
        for (const row of page.rows) {
          sourceHashes.push(rowDigest(row, columns, table, true));
          const values = columns.map((column) => {
            const raw = row[column.name];
            const value = table === 'challenges' && column.name === 'typed' && Buffer.isBuffer(raw) ? raw.toString('utf8')
              : (table === 'users' || table === 'email_codes') && column.name === 'email' && typeof raw === 'string' ? decodeEmail(raw) : raw;
            return value !== null && integer(column) ? BigInt(String(value)) : value;
          });
          insert.run(...values);
        }
        count += page.rows.length;
        if (page.rows.length < 100) break;
      }
      const targetHashes: string[] = [];
      for (const row of sqlite.prepare(`SELECT ${names} FROM ${quote(table)} ORDER BY ${sqliteOrder}`).iterate() as Iterable<Row>) {
        targetHashes.push(rowDigest(row, columns, table, false));
      }
      if (targetHashes.length !== count || digest(sourceHashes, table !== 'email_codes') !== digest(targetHashes, table !== 'email_codes')) {
        throw new Error(`Exported data did not verify for ${table}`);
      }
      counts[table] = count;
    }
    const sequence = await client.query<{ last_value: string; is_called: boolean }>('SELECT last_value,is_called FROM admin_audit_id_seq');
    sqlite.prepare("DELETE FROM sqlite_sequence WHERE name='admin_audit'").run();
    if (sequence.rows[0]?.is_called) sqlite.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('admin_audit',?)").run(BigInt(sequence.rows[0].last_value));
    const integrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || (sqlite.pragma('foreign_key_check') as unknown[]).length) {
      throw new Error('SQLite integrity or foreign-key validation failed');
    }
    sqlite.exec('COMMIT');
    await client.query('COMMIT');
    postgresTransaction = false;
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.pragma('journal_mode = DELETE');
    sqlite.close(); sqlite = undefined;
    try { linkSync(temporary, output); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('SQLite destination already exists');
      throw error;
    }
    return { counts };
  } catch (error) {
    if (sqlite?.inTransaction) sqlite.exec('ROLLBACK');
    if (postgresTransaction) { try { await client.query('ROLLBACK'); } catch { /* Connection was lost. */ } }
    throw error;
  } finally {
    sqlite?.close();
    for (const file of [temporary, temporary + '-wal', temporary + '-shm']) if (existsSync(file)) unlinkSync(file);
  }
}
