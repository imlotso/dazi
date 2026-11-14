import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { PostgresDatabase } from '../postgres/database.js';
import { compilePostgresSql } from '../postgres/sql.js';
import { decodeEmail } from './email.js';
import type { AsyncDatabase, AsyncStatement, AsyncTransaction } from './types.js';

type Context = { client: pg.PoolClient; active: boolean };

/** An async statement interface over PostgreSQL with transaction-local clients. */
export class AsyncPostgres implements AsyncDatabase {
  readonly dialect = 'postgres' as const;
  private readonly context = new AsyncLocalStorage<Context>();
  private savepoint = 0;
  constructor(readonly database: PostgresDatabase) {}
  private async query(sql: string, args: unknown[]) {
    const context = this.context.getStore();
    if (context && !context.active) throw new Error('PostgreSQL transaction is no longer active');
    const compiled = compilePostgresSql(sql, args);
    const result = context ? await context.client.query(compiled.text, compiled.values)
      : await this.database.read((client) => client.query(compiled.text, compiled.values));
    for (const field of result.fields) {
      if (field.name === 'email') {
        for (const row of result.rows) if (typeof row[field.name] === 'string') row[field.name] = decodeEmail(row[field.name]);
      }
      if (field.dataTypeID === 17 && field.name === 'typed') {
        for (const row of result.rows) if (Buffer.isBuffer(row[field.name])) row[field.name] = row[field.name].toString('utf8');
      }
      if (field.dataTypeID !== 20) continue;
      for (const row of result.rows) {
        if (row[field.name] === null) continue;
        const value = Number(row[field.name]);
        if (!Number.isSafeInteger(value)) throw new Error('PostgreSQL integer exceeds the supported range');
        row[field.name] = value;
      }
    }
    return result;
  }
  prepare(sql: string): AsyncStatement {
    return {
      get: async (...values) => (await this.query(sql, values)).rows[0],
      all: async (...values) => (await this.query(sql, values)).rows,
      run: async (...values) => {
        const context = this.context.getStore();
        const result = context ? await this.query(sql, values) : await this.transaction(async () => this.query(sql, values))();
        return { changes: result.rowCount ?? 0 };
      },
    };
  }
  async exec(sql: string) { await this.query(sql, []); }
  async pragma(_sql: string): Promise<never> { throw new Error('SQLite pragma is unavailable in PostgreSQL'); }
  transaction<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>): AsyncTransaction<Args, Result> {
    const execute = async (...args: Args): Promise<Result> => {
      const parent = this.context.getStore();
      if (parent) {
        if (!parent.active) throw new Error('PostgreSQL transaction is no longer active');
        const name = `dazi_nested_${++this.savepoint}`;
        await parent.client.query(`SAVEPOINT ${name}`);
        try {
          const result = await operation(...args);
          await parent.client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await parent.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await parent.client.query(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      }
      return this.database.transaction(async (client) => {
        const context = { client, active: true };
        try { return await this.context.run(context, () => operation(...args)); }
        finally { context.active = false; }
      });
    };
    return Object.assign(execute, { immediate: execute });
  }
  close() { return this.database.close(); }
}
