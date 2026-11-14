import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import argon2 from 'argon2';
import Database from 'better-sqlite3';
import pg from 'pg';
import { createApp } from '../server/app';
import { migratePostgres } from '../server/postgres/migrate';
import { importSqlite } from '../server/postgres/import-sqlite';
import { exportSqlite } from '../server/postgres/export-sqlite';
import { encodeEmail } from '../server/database/email';

const url = process.env.DAZI_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// This test creates and removes only its uniquely named schema in an explicitly
// supplied disposable database; it never connects to an implicit default.
suite('PostgreSQL migration and SQLite import', () => {
  let client: pg.Client;
  let schema: string;
  let directory: string;
  let path: string;
  let historicalCode: string;
  let smtpConfig: string;
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
    let now = 1_800_000_000_000;
    let verification = '';
    const app = await createApp({ databasePath: path, codeSecret: 'x'.repeat(32), now: () => now,
      mailer: { async sendCode(_email, code) { verification = code; } } });
    const historicalEmail = 'nul\0mail@example.test';
    expect((await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: historicalEmail, purpose: 'register' } })).statusCode).toBe(200);
    const account = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      email: historicalEmail, username: 'nullmail', password: 'long-password-123', code: verification,
    } });
    expect(account.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: historicalEmail, purpose: 'login' } })).statusCode).toBe(200);
    historicalCode = verification;
    const start = await app.inject({ method: 'POST', url: '/api/tests/start', payload: { articleId: 'zh-beginner-1', duration: 60 } });
    expect(start.statusCode).toBe(200);
    const guestCookie = start.cookies[0].name + '=' + start.cookies[0].value;
    now += 60_000;
    const finish = await app.inject({ method: 'POST', url: `/api/tests/${start.json().id}/finish`, headers: { cookie: guestCookie }, payload: { typed: '\0' } });
    expect(finish.statusCode).toBe(200);
    await app.close();
    const sqlite = new Database(path);
    sqlite.pragma('foreign_keys = ON');
    sqlite.prepare(`INSERT INTO users(id,username,email,password_hash,created_at,role,auth_version)
      VALUES ('u1','Alice','alice@example.test','argon2-hash',1700000000000,'admin',3)`).run();
    sqlite.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('session-hash','u1',1800000000000)`).run();
    sqlite.prepare(`INSERT INTO email_codes(email,purpose,code_hash,created_at,expires_at) VALUES ('zzz@example.test','login','hash',1,2)`).run();
    sqlite.prepare(`INSERT INTO workspace_items(user_id,kind,item_id,updated_at,value) VALUES ('u1','draft','draft-1',1700000000001,NULL)`).run();
    const key = createHmac('sha256', 'x'.repeat(32)).update('dazi.smtp.credentials.v1').digest();
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('smtp-fixture-password', 'utf8'), cipher.final()]);
    const secret = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    smtpConfig = JSON.stringify({ host: 'smtp.example.test', port: 587, security: 'starttls', from: 'from@example.test', username: 'smtp-user', secret });
    sqlite.prepare(`INSERT INTO smtp_settings(id,revision,config,updated_at) VALUES (1,4,?,1700000000002)`).run(smtpConfig);
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
    repaired.prepare('UPDATE smtp_settings SET config=? WHERE id=1').run(smtpConfig);
    repaired.close();
    const result = await importSqlite(client, path, target);
    expect(result.counts.users).toBe(2);
    expect(result.counts.public_articles).toBeGreaterThanOrEqual(40);
    expect(result.counts.workspace_items).toBe(1);
    expect(result.counts.challenges).toBe(1);
    expect((await client.query("SELECT encode(typed,'hex') AS typed FROM challenges")).rows[0].typed).toBe('00');
    expect(result.counts.workspace_revisions).toBe(0);
    const equivalentEmail = await client.query('SELECT dazi_email_key($1)=dazi_email_key($2) AS equal',
      [encodeEmail('nul\0mail@example.test'), encodeEmail('NUL\0fail@example.test')]);
    expect(equivalentEmail.rows[0].equal).toBe(true);
    expect((await client.query("SELECT username,password_hash,role,auth_version::int AS auth_version FROM users WHERE id='u1'")).rows).toEqual([
      { username: 'Alice', password_hash: 'argon2-hash', role: 'admin', auth_version: 3 },
    ]);
    expect((await client.query('SELECT value FROM workspace_items')).rows).toEqual([{ value: null }]);
    expect((await client.query('SELECT config FROM smtp_settings')).rows[0].config).toBe(smtpConfig);
    expect((await client.query('SELECT revision::int AS revision FROM site_settings')).rows[0].revision).toBe(5);
    const importedApp = await createApp({ databaseUrl: url, postgresSchema: schema, codeSecret: 'x'.repeat(32), now: () => 1_800_000_000_000 });
    try {
      const passwordLogin = await importedApp.inject({ method: 'POST', url: '/api/auth/login',
        payload: { identifier: 'nul\0mail@example.test', password: 'long-password-123' } });
      expect(passwordLogin.statusCode).toBe(200);
      expect(passwordLogin.json().user.email).toBe('nul\0mail@example.test');
      const codeLogin = await importedApp.inject({ method: 'POST', url: '/api/auth/login-code',
        payload: { email: 'nul\0mail@example.test', code: historicalCode } });
      expect(codeLogin.statusCode).toBe(200);
    } finally { await importedApp.close(); }
    const inserted = await client.query(`INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,target_label,created_at)
      VALUES ('u1','Alice','test','setting','site','site',1700000000004) RETURNING id`);
    expect(Number(inserted.rows[0].id)).toBe(100);
    const rollbackPath = join(directory, 'rollback.sqlite');
    const exported = await exportSqlite(client, rollbackPath, target);
    expect(exported.counts.users).toBe(2);
    const restored = new Database(rollbackPath);
    expect((restored.prepare("SELECT typed FROM challenges WHERE typed IS NOT NULL").get() as { typed: string }).typed).toBe('\0');
    expect((restored.prepare("SELECT email FROM users WHERE username='nullmail'").get() as { email: string }).email).toBe('nul\0mail@example.test');
    const nextAudit = restored.prepare("INSERT INTO admin_audit(actor_id,actor_name,action,target_type,target_id,target_label,created_at) VALUES ('u1','Alice','test','setting','site','site',1)").run();
    expect(Number(nextAudit.lastInsertRowid)).toBe(101);
    restored.close();
    await expect(exportSqlite(client, rollbackPath, target)).rejects.toThrow(/exists/i);
    await expect(importSqlite(client, path, target)).rejects.toThrow(/not empty/i);
    expect((await client.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count).toBe(2);
    await expect(client.query(`INSERT INTO users(id,username,email,password_hash,created_at) VALUES ('u2','aLiCe','other@example.test','hash',1)`)).rejects.toThrow();
  });
  it('bootstraps exactly one administrator through stdin without logging the password', async () => {
    const isolatedSchema = 'dazi_bootstrap_' + randomBytes(8).toString('hex');
    await client.query(`CREATE SCHEMA "${isolatedSchema}"`);
    await client.query(`SET search_path TO "${isolatedSchema}"`);
    try {
      const isolated = { ...target, schema: isolatedSchema };
      await migratePostgres(client, isolated);
      const host = new URL(url!).hostname;
      const env = { ...process.env, DATABASE_URL: url!, DAZI_DATABASE_HOST: host, DAZI_DATABASE_NAME: target.database,
        DAZI_DATABASE_SCHEMA: isolatedSchema, DAZI_CONFIRM_TARGET: `${host}/${target.database}/${isolatedSchema}`,
        ADMIN_USERNAME: 'first_admin', ADMIN_EMAIL: 'first@example.test' };
      const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/postgres-database.ts', 'bootstrap'],
        { env, input: 'a-private-test-password\n', encoding: 'utf8' });
      const first = run();
      expect(first.status).toBe(0);
      expect(first.stdout + first.stderr).not.toContain('a-private-test-password');
      const row = (await client.query('SELECT password_hash,role FROM users')).rows[0];
      expect(row.role).toBe('admin');
      expect(await argon2.verify(row.password_hash, 'a-private-test-password')).toBe(true);
      expect((await client.query('SELECT action FROM admin_audit')).rows).toEqual([{ action: 'user.bootstrap' }]);
      expect(run().status).not.toBe(0);
      expect((await client.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count).toBe(1);
    } finally {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`DROP SCHEMA "${isolatedSchema}" CASCADE`);
    }
  }, 20_000);
});
