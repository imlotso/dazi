export type SqlValues = unknown[];
export type AsyncStatement = {
  get(...values: SqlValues): Promise<any>;
  all(...values: SqlValues): Promise<any[]>;
  run(...values: SqlValues): Promise<{ changes: number }>;
};
export type AsyncTransaction<Args extends unknown[], Result> = ((...args: Args) => Promise<Result>) & {
  immediate(...args: Args): Promise<Result>;
};
export interface AsyncDatabase {
  readonly dialect: 'sqlite' | 'postgres';
  prepare(sql: string): AsyncStatement;
  exec(sql: string): Promise<void>;
  pragma(sql: string): Promise<unknown>;
  transaction<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>): AsyncTransaction<Args, Result>;
  close(): Promise<void>;
}
