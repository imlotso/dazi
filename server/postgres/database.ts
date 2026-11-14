import pg from 'pg';
import { schemaChecksum, schemaVersion } from './schema.js';

/** Pool and transaction primitives for the future PostgreSQL application store. */
export class PostgresDatabase {
  readonly pool: pg.Pool;
  constructor(connectionString: string, readonly schema = 'public') {
    if (!connectionString) throw new Error('PostgreSQL database URL is required');
    try {
      const parsed = new URL(connectionString);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) throw new Error();
    } catch { throw new Error('Invalid PostgreSQL connection configuration'); }
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
    this.pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 10_000 });
    // A suspended database can close an idle connection. pg removes that
    // connection; do not leak connection information through logs or crash.
    this.pool.on('error', () => {});
  }

  async verifySchema() {
    try {
      await this.read(async (client) => {
        const current = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
        const result = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM dazi_schema_migrations ORDER BY version');
        if (current.rows[0]?.schema !== this.schema || result.rows.length !== 1 || result.rows[0].version !== schemaVersion || result.rows[0].checksum !== schemaChecksum) throw new Error();
      });
    } catch {
      throw new Error('PostgreSQL schema is missing, unavailable, or incompatible; run the explicit migration');
    }
  }

  async read<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken ? new Error('PostgreSQL connection lost') : undefined); }
  }

  async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO "${this.schema}", pg_catalog`);
      // SQLite BEGIN IMMEDIATE serializes writers. Keep that invariant until
      // all individual multi-row operations have proven finer-grained locks.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', ['dazi.application.writer', this.schema]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken ? new Error('PostgreSQL connection lost') : undefined); }
  }

  async close() { await this.pool.end(); }
}
