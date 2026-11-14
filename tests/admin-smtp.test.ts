import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { isPublicSmtpAddress } from '../server/smtp';

const { resolve4, resolve6 } = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
vi.mock('node:dns/promises', () => ({ Resolver: class {
  resolve4 = resolve4;
  resolve6 = resolve6;
} }));
beforeEach(() => {
  resolve4.mockReset().mockResolvedValue(['8.8.8.8']);
  resolve6.mockReset().mockResolvedValue([]);
});

const credentials = { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'dazi@example.test', username: 'dazi', password: 'smtp-password-123' };

async function runSmtpTest(test: (setup: { path: string; open: () => ReturnType<typeof createApp>; send: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn>; codes: Map<string, string> }) => Promise<void>) {
  const folder = mkdtempSync(join(tmpdir(), 'dazi-smtp-'));
  const path = join(folder, 'dazi.sqlite');
  const codes = new Map<string, string>();
  const send = vi.fn(async () => {});
  const verify = vi.fn(async () => {});
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  const open = async () => {
    const app = await createApp({
      databasePath: path, codeSecret: 'deploy-code-secret-needs-to-be-stable-and-strong', adminEmail: 'owner@example.test', secureCookies: false,
      mailer: { async sendCode(email, code) { codes.set(email, code); } },
      smtpDelivery: { sendCode: send, verify },
    });
    apps.push(app);
    return app;
  };
  try { await test({ path, open, send, verify, codes }); }
  finally {
    for (const app of apps) await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
}

async function register(app: Awaited<ReturnType<typeof createApp>>, codes: Map<string, string>, username: string) {
  const email = `${username}@example.test`;
  await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email, purpose: 'register' } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, email, password: 'typing-password-123', code: codes.get(email) } });
  expect(response.statusCode).toBe(200);
  return { cookie: `session=${response.cookies[0].value}`, 'x-workspace-owner': response.json().user.id };
}

const url = '/api/admin/smtp';

describe('administrator SMTP configuration', () => {
  it('persists encrypted credentials, applies edits at runtime, verifies connections and restores deployment mail', () => runSmtpTest(async ({ path, open, send, verify, codes }) => {
    const app = await open();
    const headers = await register(app, codes, 'owner');
    const reader = await register(app, codes, 'reader');
    const read = await app.inject({ url, headers });
    expect(read.json()).toMatchObject({ source: 'development', revision: 0 });
    expect((await app.inject({ url, headers: reader })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: url + '/verify', headers: reader, payload: { revision: 0 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers, payload: { revision: 0, ...credentials, port: 443 } })).statusCode).toBe(400);
    const draft = await app.inject({ method: 'POST', url: url + '/verify', headers, payload: { revision: 0, draft: credentials } });
    expect(draft.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledWith(credentials, 'admin');
    const saved = await app.inject({ method: 'POST', url, headers, payload: { revision: 0, ...credentials } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(credentials.password);
    expect(saved.json()).toMatchObject({ source: 'admin', revision: 1, passwordState: 'saved' });
    const db = new Database(path, { readonly: true });
    try {
      expect(JSON.stringify(db.prepare('SELECT * FROM smtp_settings').get())).not.toContain(credentials.password);
    } finally { db.close(); }
    const overwritten = await app.inject({ method: 'POST', url, headers, payload: { revision: 0, ...credentials } });
    expect(overwritten.statusCode).toBe(409);
    const changed = await app.inject({ method: 'POST', url, headers, payload: { revision: 1, ...credentials, from: 'new@example.test', password: undefined } });
    expect(changed.statusCode).toBe(200);
    const restarted = await open();
    const sent = await restarted.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'newuser@example.test', purpose: 'register' } });
    expect(sent.statusCode).toBe(200);
    expect(send).toHaveBeenCalledWith({ ...credentials, from: 'new@example.test' }, 'admin', 'newuser@example.test', expect.stringMatching(/^\d{6}$/), 'register');
    expect((await restarted.inject({ method: 'POST', url: url + '/reset', headers, payload: { revision: 2 } })).json()).toMatchObject({ source: 'development', revision: 3 });
    const audit = await restarted.inject({ url: '/api/admin/audit?targetType=setting', headers });
    expect(audit.json().entries.map((entry: { action: string }) => entry.action)).toEqual(['smtp.reset', 'smtp.update', 'smtp.update', 'smtp.verify']);
    expect(audit.body).not.toContain(credentials.password);
    expect((await restarted.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'fallback@example.test', purpose: 'register' } })).statusCode).toBe(200);
    expect(codes.has('fallback@example.test')).toBe(true);
  }));
});

it('blocks private destinations and prevents credential reuse across different SMTP servers', () => runSmtpTest(async ({ open, verify, codes }) => {
  const app = await open();
  const headers = await register(app, codes, 'owner');
  const post = (path: string, payload: object) => app.inject({ method: 'POST', url: path, headers, payload });
  for (const host of ['127.0.0.1', '169.254.169.254', '::1', 'https://smtp.example.test']) {
    expect((await post(url + '/verify', { revision: 0, draft: { ...credentials, host } })).statusCode).toBe(400);
  }
  expect(verify).not.toHaveBeenCalled();
  expect((await post(url, { revision: 0, ...credentials })).statusCode).toBe(200);
  expect((await post(url, { revision: 1, ...credentials, host: 'second.example.test', password: undefined })).statusCode).toBe(400);
  verify.mockRejectedValueOnce(Object.assign(new Error(`Sensitive failure ${credentials.password}`), { code: 'EAUTH' }));
  const failure = await post(url + '/verify', { revision: 1 });
  expect(failure.statusCode).toBe(502);
  expect(failure.json()).toEqual({ error: 'SMTP 身份验证失败' });
  expect(failure.body).not.toContain(credentials.password);
}));

it('filters IPv4, IPv6 and mapped private DNS results before a socket can open', () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '100.100.100.200', '192.168.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:a00:1::1', '2001:db8::1']) {
    expect(isPublicSmtpAddress(address), address).toBe(false);
  }
  expect(isPublicSmtpAddress('8.8.8.8')).toBe(true);
  expect(isPublicSmtpAddress('2606:4700:4700::1111')).toBe(true);
});

it('keeps working SMTP settings when a draft host resolves privately or has no DNS records', () => runSmtpTest(async ({ open, codes }) => {
  const app = await open();
  const headers = await register(app, codes, 'owner');
  const save = (revision: number, host: string) => app.inject({
    method: 'POST', url, headers, payload: { revision, ...credentials, host },
  });
  expect((await save(0, credentials.host)).statusCode).toBe(200);
  resolve6.mockResolvedValueOnce(['::ffff:127.0.0.1']);
  expect((await save(1, 'mixed.example.test')).json()).toEqual({ error: 'SMTP 主机须解析为公网地址' });
  resolve4.mockRejectedValueOnce(new Error('DNS lookup failed'));
  expect((await save(1, 'unknown.example.test')).json()).toEqual({ error: '无法解析 SMTP 主机' });
  expect((await app.inject({ url, headers })).json()).toMatchObject({ revision: 1, config: { host: credentials.host } });
}));

it('rechecks revision and access after DNS completes', () => runSmtpTest(async ({ path, open, codes }) => {
  const app = await open();
  const headers = await register(app, codes, 'owner');
  const save = (revision: number, host: string) => app.inject({
    method: 'POST', url, headers, payload: { revision, ...credentials, host },
  });
  let finishDns!: (addresses: string[]) => void;
  resolve4.mockImplementationOnce(() => new Promise<string[]>((resolve) => { finishDns = resolve; }));
  const slowSave = save(0, 'slow.example.test').then((response) => response);
  await vi.waitFor(() => expect(resolve4).toHaveBeenCalledWith('slow.example.test'));
  expect((await save(0, credentials.host)).statusCode).toBe(200);
  finishDns(['8.8.8.8']);
  expect((await slowSave).statusCode).toBe(409);

  resolve4.mockImplementationOnce(() => new Promise<string[]>((resolve) => { finishDns = resolve; }));
  const revokedSave = save(1, 'revoked.example.test').then((response) => response);
  await vi.waitFor(() => expect(resolve4).toHaveBeenCalledWith('revoked.example.test'));
  const db = new Database(path);
  try {
    db.prepare("UPDATE users SET auth_version=auth_version+1, role='user' WHERE id=?").run(headers['x-workspace-owner']);
  } finally { db.close(); }
  finishDns(['8.8.8.8']);
  expect((await revokedSave).statusCode).toBe(403);
  const persisted = new Database(path, { readonly: true });
  try { expect(persisted.prepare('SELECT revision FROM smtp_settings').get()).toEqual({ revision: 1 }); }
  finally { persisted.close(); }
}));
