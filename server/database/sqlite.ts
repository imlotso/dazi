import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import type { AsyncDatabase, AsyncStatement, AsyncTransaction } from './types.js';

type Context = { active: boolean };

/** Serialize all access while an awaited SQLite transaction owns the connection. */
export class AsyncSqlite implements AsyncDatabase {
  readonly dialect = 'sqlite' as const;
  private readonly context = new AsyncLocalStorage<Context>();
  private tail: Promise<void> = Promise.resolve();
  private savepoint = 0;
  constructor(private readonly raw: Database.Database) {}

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const context = this.context.getStore();
    if (context) {
      if (!context.active) throw new Error('SQLite transaction is no longer active');
      return operation();
    }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  prepare(sql: string): AsyncStatement {
    const statement = this.raw.prepare(sql);
    return {
      get: (...values) => this.exclusive(() => statement.get(...values)),
      all: (...values) => this.exclusive(() => statement.all(...values)),
      run: (...values) => this.exclusive(() => statement.run(...values)),
    };
  }
  exec(sql: string) { return this.exclusive(() => { this.raw.exec(sql); }); }
  pragma(sql: string) { return this.exclusive(() => this.raw.pragma(sql)); }
  transaction<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>): AsyncTransaction<Args, Result> {
    const execute = async (...args: Args): Promise<Result> => {
      const parent = this.context.getStore();
      if (parent) {
        if (!parent.active) throw new Error('SQLite transaction is no longer active');
        const name = `dazi_nested_${++this.savepoint}`;
        this.raw.exec(`SAVEPOINT ${name}`);
        try {
          const result = await operation(...args);
          this.raw.exec(`RELEASE SAVEPOINT ${name}`);
          return result as Result;
        } catch (error) {
          this.raw.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          this.raw.exec(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      }
      return this.exclusive<Result>(async () => {
        const context: Context = { active: true };
        this.raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await this.context.run(context, () => operation(...args));
          this.raw.exec('COMMIT');
          return result as Result;
        } catch (error) {
          this.raw.exec('ROLLBACK');
          throw error;
        } finally { context.active = false; }
      });
    };
    return Object.assign(execute, { immediate: execute });
  }
  close() { return this.exclusive(() => { this.raw.close(); }); }
}
