import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import pg from 'pg';
import { createApp } from '../server/app';
import { migratePostgres } from '../server/postgres/migrate';
import { importSqlite } from '../server/postgres/import-sqlite';

const url = process.env.DAZI_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// This test creates and removes only its uniquely named schema in an explicitly
// supplied disposable database; it never connects to an implicit default.
suite('PostgreSQL migration and SQLite import', () => {
  let client: pg.Client;
  let schema: string;
  let directory: string;
  let path: string;
  let target: { database: string; schema: string };
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('This integration test requires a disposable loopback PostgreSQL database');
    client = new pg.Client({ connectionString: url });
    await client.connect();
    schema = 'dazi_test_' + randomBytes(8).toString('hex');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    target = { database: parsed.pathname.slice(1), schema };
    directory = mkdtempSync(join(tmpdir(), 'dazi-pg-import-'));
    path = join(directory, 'source.sqlite');
    const app = await createApp({ databasePath: path, codeSecret: 'x'.repeat(32) });
    await app.close();
    const sqlite = new Database(path);
    sqlite.pragma('foreign_keys = ON');
    sqlite.prepare(`INSERT INTO users(id,username,email,password_hash,created_at,role,auth_version)
      VALUES ('u1','Alice','alice@example.test','argon2-hash',1700000000000,'admin',3)`).run();
    sqlite.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('session-hash','u1',1800000000000)`).run();
    sqlite.prepare(`INSERT INTO workspace_items(user_id,kind,item_id,updated_at,value) VALUES ('u1','draft','draft-1',1700000000001,NULL)`).run();
    sqlite.prepare(`INSERT INTO smtp_settings(id,revision,config,updated_at) VALUES (1,4,?,1700000000002)`).run(JSON.stringify({ host: 'smtp.example.test', secret: 'encrypted-ciphertext' }));
    sqlite.prepare(`INSERT INTO site_settings(id,settings,revision) VALUES (1,?,5)`).run(JSON.stringify({ registrationEnabled: false }));
    const audit = sqlite.prepare(`INSERT INTO admin_audit(id,actor_id,actor_name,action,target_type,target_id,target_label,reason,created_at)
      VALUES (?, 'u1', 'Alice', 'settings.site.update', 'setting', 'site', 'site', NULL, 1700000000003)`);
    audit.run(42); audit.run(99);
    sqlite.prepare('DELETE FROM admin_audit WHERE id=99').run();
    // The current production SQLite predates the new paging revision table.
    sqlite.exec('DROP TABLE workspace_revisions');
    sqlite.close();
  });
  afterAll(async () => {
    if (client) {
      await client.query('SET search_path TO public');
      if (schema) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('checks the intended target, migrates explicitly, copies all tables and preserves the audit sequence', async () => {
    await expect(migratePostgres(client, { ...target, database: 'wrong-database' })).rejects.toThrow(/target/i);
    await migratePostgres(client, target);
    await migratePostgres(client, target);
    const sqlite = new Database(path);
    sqlite.prepare('UPDATE smtp_settings SET config=? WHERE id=1').run('unsupported\0value');
    sqlite.close();
    await expect(importSqlite(client, path, target)).rejects.toThrow(/unsupported value/i);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count).toBe(0);
    const repaired = new Database(path);
    repaired.prepare('UPDATE smtp_settings SET config=? WHERE id=1').run(JSON.stringify({ host: 'smtp.example.test', secret: 'encrypted-ciphertext' }));
    repaired.close();
    const result = await importSqlite(client, path, target);
    expect(result.counts.users).toBe(1);
    expect(result.counts.public_articles).toBeGreaterThanOrEqual(40);
    expect(result.counts.workspace_items).toBe(1);
    expect(result.counts.workspace_revisions).toBe(0);
    expect((await client.query('SELECT username,password_hash,role,auth_version::int AS auth_version FROM users')).rows).toEqual([
      { username: 'Alice', password_hash: 'argon2-hash', role: 'admin', auth_version: 3 },
    ]);
    expect((await client.query('SELECT value FROM workspace_items')).rows).toEqual([{ value: null }]);
    expect((await client.query('SELECT config FROM smtp_settings')).rows[0].config).toContain('encrypted-ciphertext');
    expect((await client.query('SELECT revision::int AS revision FROM site_settings')).rows[0].revision).toBe(5);
    const inserted = await client.query(`INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,target_label,created_at)
      VALUES ('u1','Alice','test','setting','site','site',1700000000004) RETURNING id`);
    expect(Number(inserted.rows[0].id)).toBe(100);
    await expect(importSqlite(client, path, target)).rejects.toThrow(/not empty/i);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count).toBe(1);
    await expect(client.query(`INSERT INTO users(id,username,email,password_hash,created_at) VALUES ('u2','aLiCe','other@example.test','hash',1)`)).rejects.toThrow();
  });
});
