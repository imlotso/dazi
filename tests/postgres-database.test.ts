import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../server/postgres/database';
import { migratePostgres } from '../server/postgres/migrate';

const url = process.env.DAZI_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgreSQL transactional data layer', () => {
  let setup: pg.Client;
  let databases: PostgresDatabase[];
  let schema: string;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('This integration test requires disposable loopback PostgreSQL');
    setup = new pg.Client({ connectionString: url });
    await setup.connect();
    schema = 'dazi_data_test_' + randomBytes(8).toString('hex');
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    databases = [0, 1].map(() => new PostgresDatabase(url!, schema));
    await expect(databases[0].verifySchema()).rejects.toThrow(/schema/i);
    await migratePostgres(setup, { database: parsed.pathname.slice(1), schema });
    await Promise.all(databases.map((database) => database.verifySchema()));
  });
  afterAll(async () => {
    await Promise.all(databases?.map((database) => database.close()) ?? []);
    if (setup) {
      await setup.query('SET search_path TO public');
      if (schema) await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
      await setup.end();
    }
  });

  it('serializes cross-instance read-modify-write transactions and rolls failures back', async () => {
    await setup.query(`INSERT INTO site_settings(id,settings,revision) VALUES (1,'{}',1)`);
    await Promise.all(Array.from({ length: 12 }, (_, index) => databases[index % 2].transaction(async (client) => {
      const current = await client.query('SELECT revision FROM site_settings WHERE id=1');
      const revision = Number(current.rows[0].revision);
      await client.query('UPDATE site_settings SET revision=$1 WHERE id=1', [revision + 1]);
    })));
    expect(Number((await setup.query('SELECT revision FROM site_settings')).rows[0].revision)).toBe(13);
    await expect(databases[0].transaction(async (client) => {
      await client.query('UPDATE site_settings SET revision=99 WHERE id=1');
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(Number((await setup.query('SELECT revision FROM site_settings')).rows[0].revision)).toBe(13);
  });

  it('recovers after a database connection is terminated while idle', async () => {
    const connection = await databases[0].pool.connect();
    const pid = Number((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    connection.release();
    const disconnected = new Promise<void>((resolve) => databases[0].pool.once('error', () => resolve()));
    await setup.query('SELECT pg_terminate_backend($1)', [pid]);
    await disconnected;
    await expect(databases[0].verifySchema()).resolves.toBeUndefined();
    expect(Number((await databases[0].pool.query('SELECT revision FROM site_settings WHERE id=1')).rows[0].revision)).toBe(13);
  });
});

it('does not silently use a local database when PostgreSQL configuration is missing', () => {
  expect(() => new PostgresDatabase('', 'public')).toThrow(/database/i);
});
