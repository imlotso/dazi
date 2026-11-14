import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import { migratePostgres } from '../server/postgres/migrate';
import { postgresRateLimitStore } from '../server/postgres/rate-limit';

const url = process.env.DAZI_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('shared PostgreSQL rate limits', () => {
  let setup: pg.Client;
  let pools: pg.Pool[];
  let apps: ReturnType<typeof Fastify>[];
  let schema: string;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('This integration test requires disposable loopback PostgreSQL');
    setup = new pg.Client({ connectionString: url });
    await setup.connect();
    schema = 'dazi_rate_test_' + randomBytes(8).toString('hex');
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await migratePostgres(setup, { database: parsed.pathname.slice(1), schema });
    pools = [0, 1].map(() => new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }));
    apps = await Promise.all(pools.map(async (pool) => {
      const app = Fastify({ trustProxy: true });
      await app.register(rateLimit, { store: postgresRateLimitStore(pool, 'x'.repeat(32)), max: 100, timeWindow: '1 minute' });
      app.get('/code', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
      app.get('/login', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
      await app.ready();
      return app;
    }));
  });
  afterAll(async () => {
    await Promise.all(apps?.map((app) => app.close()) ?? []);
    await Promise.all(pools?.map((pool) => pool.end()) ?? []);
    if (setup) {
      await setup.query('SET search_path TO public');
      if (schema) await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
      await setup.end();
    }
  });

  it('shares each route limit across independent instances and keeps addresses private', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.123' };
    const results = await Promise.all([0, 1, 0, 1].map((index) => apps[index].inject({ url: '/code', headers })));
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 200, 200, 429]);
    expect((await apps[1].inject({ url: '/login', headers })).statusCode).toBe(200);
    expect((await apps[0].inject({ url: '/login', headers })).statusCode).toBe(429);
    expect((await apps[0].inject({ url: '/code', headers: { 'x-forwarded-for': '203.0.113.124' } })).statusCode).toBe(200);
    const stored = await setup.query('SELECT key FROM rate_limit_entries');
    expect(stored.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored.rows)).not.toContain('203.0.113.123');
  });
});
