import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';

const script = fileURLToPath(new URL('../scripts/bootstrap-admin.mjs', import.meta.url));
const username = 'room_owner';
const email = 'room.owner@example.test';
const password = '  offline password 123  ';

describe('offline admin bootstrap', () => {
  let directory: string;
  let databasePath: string;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  const env = (extra?: NodeJS.ProcessEnv) => ({
    ...process.env, DATABASE_PATH: databasePath, ADMIN_USERNAME: username, ADMIN_EMAIL: email, ...extra,
  });
  const run = (input = password + '\n', extra?: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [script], { env: env(extra), input, encoding: 'utf8' });
  const runAsync = (extra?: NodeJS.ProcessEnv) => new Promise<number>((resolve) => {
    const processHandle = execFile(process.execPath, [script], { env: env(extra) }, (error) => {
      resolve(Number(error?.code ?? 0));
    });
    processHandle.stdin!.end(password + '\n');
  });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dazi-admin-bootstrap-'));
    databasePath = join(directory, 'app.sqlite');
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates the first admin without mail and supports login on the running service', async () => {
    app = await createApp({ databasePath, secureCookies: false });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(password);
    const session = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: username, password } });
    expect(session.statusCode).toBe(200);
    expect(session.json().user).toMatchObject({ email, username, isAdmin: true });
    const headers = { cookie: 'session=' + session.cookies[0].value };
    expect((await app.inject({ url: '/api/admin/overview', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/admin/audit', headers })).json().entries[0])
      .toMatchObject({ action: 'user.bootstrap', targetLabel: username, actorName: username });
    const db = new Database(databasePath);
    try {
      expect(db.prepare('SELECT password_hash FROM users').pluck().get()).toMatch(/^\$argon2id\$/);
    } finally { db.close(); }
    expect(run(undefined, { ADMIN_USERNAME: 'second_admin', ADMIN_EMAIL: 'another@example.test' }).status).toBe(1);
  });

  it('refuses uninitialized databases, malformed credentials and existing accounts', async () => {
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('先启动');
    expect(existsSync(databasePath)).toBe(false);
    app = await createApp({ databasePath });
    expect(run('short\n').status).toBe(1);
    expect(run('multiple lines\nsecond line\n').status).toBe(1);
    expect(run(undefined, { ADMIN_EMAIL: 'not-an-address' }).status).toBe(1);
    expect(run(undefined, { ADMIN_USERNAME: 'invalid user' }).status).toBe(1);
    const db = new Database(databasePath);
    try {
      db.prepare('INSERT INTO users (id,username,email,password_hash,created_at) VALUES (?,?,?,?,?)')
        .run('old-id', username, 'existing@example.test', 'old-hash', Date.now());
      const conflict = run();
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('已存在');
      expect(db.prepare('SELECT password_hash,role FROM users').all()).toEqual([{ password_hash: 'old-hash', role: 'user' }]);
    } finally { db.close(); }
  });

  it('allows only one bootstrap when two commands run concurrently', async () => {
    app = await createApp({ databasePath });
    const outcomes = await Promise.all([runAsync(), runAsync({ ADMIN_USERNAME: 'second_admin', ADMIN_EMAIL: 'other@example.test' })]);
    expect(outcomes.sort()).toEqual([0, 1]);
    const db = new Database(databasePath);
    try {
      expect(db.prepare("SELECT count(*) FROM users WHERE role='admin'").pluck().get()).toBe(1);
      expect(db.prepare("SELECT count(*) FROM admin_audit WHERE action='user.bootstrap'").pluck().get()).toBe(1);
    } finally { db.close(); }
  });
});
