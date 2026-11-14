import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgresDatabase } from '../server/postgres/database';
import { migratePostgres } from '../server/postgres/migrate';
import { AsyncPostgres } from '../server/database/postgres';
import { createAsyncWorkspaceStore } from '../server/database/workspace';
import type { WorkspaceItem } from '../src/lib/models';

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

  it('binds existing statement syntax and returns safe integer values through the asynchronous adapter', async () => {
    const adapter = new AsyncPostgres(databases[0]);
    await adapter.prepare('INSERT INTO users(id,username,email,password_hash,created_at) VALUES (@id,@username,@email,@hash,@time)').run({
      id: 'u-test', username: 'Testing', email: 'testing@example.test', hash: 'hash', time: 1700000000000,
    });
    expect(await adapter.prepare('SELECT created_at AS createdAt FROM users WHERE id=?').get('u-test')).toEqual({ createdAt: 1700000000000 });
    await expect(adapter.transaction(async () => {
      await adapter.prepare('DELETE FROM users WHERE id=?').run('u-test');
      throw new Error('abort adapter');
    })()).rejects.toThrow('abort adapter');
    expect(await adapter.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
  });

  it('keeps a draft tombstone through concurrent workspace writes on separate instances', async () => {
    await setup.query("INSERT INTO users(id,username,email,password_hash,created_at) VALUES ('workspace-user','Workspace','workspace@example.test','hash',1)");
    const first = await createAsyncWorkspaceStore(new AsyncPostgres(databases[0]));
    const second = await createAsyncWorkspaceStore(new AsyncPostgres(databases[1]));
    const live: WorkspaceItem = { kind: 'draft', id: 'draft-1', updatedAt: 20, value: {
      id: 'draft-1', article: { id: 'a', title: 'a', text: 'a\0b', language: 'zh', difficulty: 'beginner', custom: true },
      typed: '', elapsedMs: 1, backspaces: 0, duration: 60, mode: 'timed', strict: false, offset: 0,
      recordId: 'record-1', offline: true, savedAt: 1, claimVersion: 2, progressVersion: 3,
    } };
    const deleted: WorkspaceItem = { kind: 'draft', id: 'draft-1', updatedAt: 1, deleted: true };
    await Promise.all([first.merge('workspace-user', [live]), second.merge('workspace-user', [deleted])]);
    expect(await first.get('workspace-user')).toEqual([deleted]);
    expect((await second.pagedSnapshot('workspace-user', undefined, undefined)).items).toEqual([deleted]);
  });
});

it('does not silently use a local database when PostgreSQL configuration is missing', () => {
  expect(() => new PostgresDatabase('', 'public')).toThrow(/database/i);
});
