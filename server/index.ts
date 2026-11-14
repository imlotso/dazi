import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp, type Mailer } from './app.js';
import type { SmtpConfiguration } from './smtp.js';

const production = process.env.NODE_ENV === 'production';
const databaseUrl = process.env.DATABASE_URL;
if (production && !databaseUrl && !process.env.DATABASE_PATH) {
  throw new Error('DATABASE_URL or an explicit DATABASE_PATH is required in production');
}
const databasePath = databaseUrl ? undefined : resolve(process.env.DATABASE_PATH || './data/dazi.sqlite');
if (databasePath) mkdirSync(dirname(databasePath), { recursive: true });

const codeSecret = process.env.CODE_SECRET;
if (production && (!codeSecret || codeSecret.length < 32)) {
  throw new Error('CODE_SECRET must contain at least 32 characters in production');
}

let mailer: Mailer | undefined;
let smtp: SmtpConfiguration | undefined;
if (process.env.SMTP_HOST && process.env.SMTP_FROM) {
  const secure = process.env.SMTP_SECURE === 'true';
  smtp = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
    security: secure ? 'tls' : production ? 'starttls' : 'opportunistic',
    from: process.env.SMTP_FROM,
    username: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
  };
} else if (!production && process.env.MAIL_DEV_MODE === 'console') {
  mailer = { async sendCode(email, code, purpose) { console.log(`[development mail] ${purpose} ${email}: ${code}`); } };
}

const app = await createApp({
  databasePath,
  databaseUrl,
  postgresSchema: process.env.DAZI_DATABASE_SCHEMA,
  secureCookies: production,
  codeSecret,
  adminEmail: process.env.ADMIN_EMAIL,
  staticRoot: production ? resolve('dist/client') : undefined,
  trustProxy: process.env.TRUST_PROXY === 'true',
  mailer,
  smtp,
});
const port = Number(process.env.PORT || 3001);
await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
console.log(`Typing service listening on port ${port}`);
