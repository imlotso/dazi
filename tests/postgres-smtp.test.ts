import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createApp } from '../server/app';
import { migratePostgres } from '../server/postgres/migrate';

const dns = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock('node:dns/promises', () => ({ Resolver: class { resolve4 = dns.resolve4; resolve6 = dns.resolve6; } }));
const url = process.env.DAZI_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('PostgreSQL administrator SMTP settings', () => {
  let setup: pg.Client;
  let schema: string;
  let apps: Awaited<ReturnType<typeof createApp>>[] = [];
  const codes = new Map<string, string>();
  const verify = vi.fn(async () => {});
  const sendCode = vi.fn(async () => {});
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('This integration test requires disposable loopback PostgreSQL');
    dns.resolve4.mockResolvedValue(['8.8.8.8']); dns.resolve6.mockResolvedValue([]);
    setup = new pg.Client({ connectionString: url }); await setup.connect();
    schema = 'dazi_smtp_test_' + randomBytes(8).toString('hex');
    await setup.query(`CREATE SCHEMA "${schema}"`); await setup.query(`SET search_path TO "${schema}"`);
    await migratePostgres(setup, { database: parsed.pathname.slice(1), schema });
    apps = await Promise.all([0, 1].map(() => createApp({ databaseUrl: url, postgresSchema: schema,
      codeSecret: 'x'.repeat(32), adminEmail: 'admin@example.test', secureCookies: false,
      mailer: { async sendCode(email, code) { codes.set(email, code); } }, smtpDelivery: { verify, sendCode },
    })));
  });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    if (setup) { await setup.query('SET search_path TO public'); if (schema) await setup.query(`DROP SCHEMA "${schema}" CASCADE`); await setup.end(); }
  });
  it('serializes revisions and preserves encrypted credentials across instances', async () => {
    await apps[0].inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'admin@example.test', purpose: 'register' } });
    const registered = await apps[0].inject({ method: 'POST', url: '/api/auth/register', payload: {
      email: 'admin@example.test', username: 'admin', password: 'long-password-123', code: codes.get('admin@example.test'),
    } });
    expect(registered.statusCode).toBe(200);
    const cookie = registered.cookies[0].name + '=' + registered.cookies[0].value;
    const settings = { revision: 0, host: 'smtp.example.test', port: 587, security: 'starttls', from: 'sender@example.test',
      username: 'smtp-user', password: 'smtp-test-password' };
    const writes = await Promise.all(apps.map((app) => app.inject({ method: 'POST', url: '/api/admin/smtp', headers: { cookie }, payload: settings })));
    expect(writes.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(writes[0].body + writes[1].body).not.toContain(settings.password);
    const stored = (await setup.query('SELECT config FROM smtp_settings')).rows[0].config;
    expect(stored).not.toContain(settings.password);
    const result = await apps[1].inject({ method: 'POST', url: '/api/admin/smtp/verify', headers: { cookie }, payload: { revision: 1 } });
    expect(result.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ password: settings.password, port: 587 }), 'admin');
    const audit = await apps[0].inject({ url: '/api/admin/audit?targetType=setting', headers: { cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).not.toContain(settings.password);
    let startupError: unknown;
    try { const wrong = await createApp({ databaseUrl: url, postgresSchema: schema, codeSecret: 'wrong'.repeat(8) }); await wrong.close(); }
    catch (error) { startupError = error; }
    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toMatch(/密码无法解密/);
  });
});
