import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { SMTPServer } from 'smtp-server';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';

describe('local SMTP transport', () => {
  it.each(['starttls', 'tls'] as const)('connects with verified %s, sends a code, and verifies without sending another message', async (security) => {
    const folder = mkdtempSync(join(tmpdir(), 'dazi-smtp-transport-'));
    const keyPath = join(folder, 'key.pem'); const certPath = join(folder, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    const key = readFileSync(keyPath); const cert = readFileSync(certPath);
    const previousCAs = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...previousCAs, cert.toString('utf8')]);
    const messages: string[] = [];
    const server = new SMTPServer({ key, cert, secure: security === 'tls', authOptional: true,
      onData(stream, _session, callback) {
        let data = '';
        stream.on('data', (chunk) => { data += String(chunk); });
        stream.on('end', () => { messages.push(data); callback(); });
      },
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.server.address() as { port: number }).port;
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      app = await createApp({ databasePath: ':memory:', codeSecret: 'x'.repeat(32), adminEmail: 'owner@example.test',
        smtp: { host: '127.0.0.1', port, security, from: 'sender@example.test', username: '', password: '' } });
      const sent = await app.inject({ method: 'POST', url: '/api/auth/code', payload: { email: 'owner@example.test', purpose: 'register' } });
      expect(sent.statusCode).toBe(200);
      expect(messages).toHaveLength(1);
      const body = Buffer.from(messages[0].split(/\r?\n\r?\n/).slice(1).join(''), 'base64').toString('utf8');
      const code = body.match(/验证码是 (\d{6})/)?.[1];
      expect(code).toMatch(/^\d{6}$/);
      const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
        email: 'owner@example.test', username: 'owner', password: 'long-password-123', code,
      } });
      expect(registration.statusCode).toBe(200);
      const cookie = registration.cookies[0].name + '=' + registration.cookies[0].value;
      const checked = await app.inject({ method: 'POST', url: '/api/admin/smtp/verify', headers: { cookie }, payload: { revision: 0 } });
      expect(checked.statusCode).toBe(200);
      expect(messages).toHaveLength(1);
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      tls.setDefaultCACertificates(previousCAs);
      rmSync(folder, { recursive: true, force: true });
    }
  }, 20_000);
});
