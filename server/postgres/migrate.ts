import type { Client } from 'pg';
import { schemaChecksum, schemaSql, schemaVersion } from './schema.js';

export type ExpectedTarget = { database: string; schema: string };

export async function assertPostgresTarget(client: Client, expected: ExpectedTarget) {
  if (!expected.database || !expected.schema) throw new Error('Explicit PostgreSQL target database and schema are required');
  const result = await client.query<{ database: string; schema: string }>('SELECT current_database() AS database, current_schema() AS schema');
  if (result.rows[0]?.database !== expected.database || result.rows[0]?.schema !== expected.schema) {
    throw new Error('PostgreSQL target does not match the explicitly selected database and schema');
  }
}

/** Run explicitly; normal application startup must never call this function. */
export async function migratePostgres(client: Client, target: ExpectedTarget) {
  await client.query('BEGIN');
  try {
    await assertPostgresTarget(client, target);
    await client.query(`SET LOCAL search_path TO "${target.schema.replaceAll('"', '""')}", pg_catalog`);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', ['dazi.schema.migration', target.schema]);
    const tables = await client.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=current_schema()');
    const names = tables.rows.map((row) => row.tablename);
    if (!names.includes('dazi_schema_migrations')) {
      if (names.length) throw new Error('PostgreSQL target schema is not empty');
      await client.query('CREATE TABLE dazi_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      await client.query(schemaSql);
      await client.query('INSERT INTO dazi_schema_migrations(version,checksum) VALUES ($1,$2)', [schemaVersion, schemaChecksum]);
    } else {
      const versions = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM dazi_schema_migrations ORDER BY version');
      if (versions.rows.length !== 1 || versions.rows[0].version !== schemaVersion || versions.rows[0].checksum !== schemaChecksum) throw new Error('Unsupported PostgreSQL schema version');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
