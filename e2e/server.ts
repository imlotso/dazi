import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app';

// Test-only server: real app and SQLite, with an in-memory mailbox instead of external SMTP.
const directory = mkdtempSync(join(tmpdir(), 'dazi-e2e-'));
const mailbox = new Map<string, string>();
const app = await createApp({
  databasePath: join(directory, 'test.sqlite'),
  staticRoot: resolve('dist/client'),
  secureCookies: true,
  codeSecret: 'ci-only-secret-not-used-outside-tests',
  adminEmail: 'admin@example.test',
  mailer: { async sendCode(email, code, purpose) { mailbox.set(`${email}:${purpose}`, code); } },
});

app.get('/__e2e__/email-code', async (request, reply) => {
  const { email, purpose } = request.query as { email?: string; purpose?: string };
  const code = mailbox.get(`${email}:${purpose}`);
  return code ? { code } : reply.code(404).send({ error: 'No test email received' });
});

const cleanup = async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGTERM', () => { void cleanup(); });
process.once('SIGINT', () => { void cleanup(); });
await app.listen({ host: '127.0.0.1', port: Number(process.env.E2E_PORT || 4178) });
