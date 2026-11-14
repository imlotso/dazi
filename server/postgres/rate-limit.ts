import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';

type Options = {
  routeInfo?: { method?: string | string[]; url?: string; path?: string; prefix?: string };
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
};
type Callback = (error: Error | null, result?: { current: number; ttl: number }) => void;
type Queryable = Pick<Pool, 'query'>;

export async function cleanupRateLimits(connection: Queryable, schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
  const table = `"${schema}".rate_limit_entries`;
  await connection.query(`WITH expired AS (SELECT key FROM ${table} WHERE expires_at<statement_timestamp() ORDER BY expires_at LIMIT 500)
    DELETE FROM ${table} WHERE key IN (SELECT key FROM expired) AND expires_at<statement_timestamp()`);
}

/** A single atomic PostgreSQL counter shared by independently running Functions. */
export function postgresRateLimitStore(pool: Pool, secret: string, schema = 'public') {
  if (secret.length < 32) throw new Error('Rate limit secret must contain at least 32 characters');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid PostgreSQL schema name');
  const table = `"${schema}".rate_limit_entries`;
  let operations = 0;
  return class PostgresRateLimitStore {
    private readonly scope: string;
    constructor(input: unknown = {}) {
      const options = input as Options;
      if (options.continueExceeding || options.exponentialBackoff) throw new Error('Unsupported rate-limit policy');
      const route = options.routeInfo;
      const methods = Array.isArray(route?.method) ? [...route.method].sort().join(',') : route?.method ?? '';
      this.scope = route ? `${methods}:${route.url ?? route.path ?? ''}` : 'global';
    }
    child(options: unknown) { return new PostgresRateLimitStore(options); }
    private key(value: string) { return createHmac('sha256', secret).update(this.scope).update('\0').update(value).digest('hex'); }
    incr(value: string, callback: Callback, timeWindow: number) {
      if (!Number.isSafeInteger(timeWindow) || timeWindow <= 0) return callback(new Error('Invalid rate-limit window'));
      void pool.query<{ current: string; ttl: string }>(`
        INSERT INTO ${table}(key,count,expires_at)
        VALUES ($1,1,statement_timestamp()+$2::bigint*interval '1 millisecond')
        ON CONFLICT(key) DO UPDATE SET
          count=CASE WHEN rate_limit_entries.expires_at<=statement_timestamp() THEN 1 ELSE LEAST(rate_limit_entries.count+1,9007199254740991) END,
          expires_at=CASE WHEN rate_limit_entries.expires_at<=statement_timestamp()
            THEN statement_timestamp()+$2::bigint*interval '1 millisecond' ELSE rate_limit_entries.expires_at END
        RETURNING count::text AS current,
          GREATEST(0,CEIL(EXTRACT(EPOCH FROM expires_at-statement_timestamp())*1000))::text AS ttl`, [this.key(value), timeWindow])
        .then(async ({ rows }) => {
          const row = rows[0];
          if (++operations % 100 === 0) {
            await cleanupRateLimits(pool, schema).catch(() => {});
          }
          callback(null, { current: Number(row.current), ttl: Number(row.ttl) });
        }, () => callback(new Error('Rate limiting unavailable')));
    }
    read(value: string, callback: Callback) {
      void pool.query<{ current: string; ttl: string }>(`SELECT count::text AS current,
        GREATEST(0,CEIL(EXTRACT(EPOCH FROM expires_at-statement_timestamp())*1000))::text AS ttl
        FROM ${table} WHERE key=$1 AND expires_at>statement_timestamp()`, [this.key(value)])
        .then(({ rows }) => callback(null, rows[0] ? { current: Number(rows[0].current), ttl: Number(rows[0].ttl) } : { current: 0, ttl: 0 }),
          () => callback(new Error('Rate limiting unavailable')));
    }
  };
}
