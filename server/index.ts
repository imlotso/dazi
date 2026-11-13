import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { createApp, type Mailer } from './app';

const production = process.env.NODE_ENV === 'production';
const databasePath = resolve(process.env.DATABASE_PATH || './data/dazi.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

const codeSecret = process.env.CODE_SECRET;
if (production && (!codeSecret || codeSecret.length < 32)) {
  throw new Error('CODE_SECRET must contain at least 32 characters in production');
}

let mailer: Mailer | undefined;
if (process.env.SMTP_HOST && process.env.SMTP_FROM) {
  const secure = process.env.SMTP_SECURE === 'true';
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
    secure,
    requireTLS: production && !secure,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
  });
  mailer = {
    async sendCode(email, code, purpose) {
      const label = purpose === 'register' ? '注册' : purpose === 'reset' ? '重设密码' : '登录';
      await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: `云打字练习 · ${label}验证码`, text: `你的${label}验证码是 ${code}，10 分钟内有效。请勿将验证码告诉他人。` });
    },
  };
} else if (!production && process.env.MAIL_DEV_MODE === 'console') {
  mailer = { async sendCode(email, code, purpose) { console.log(`[development mail] ${purpose} ${email}: ${code}`); } };
}

const app = await createApp({
  databasePath,
  secureCookies: production,
  codeSecret,
  adminEmail: process.env.ADMIN_EMAIL,
  staticRoot: production ? resolve('dist/client') : undefined,
  mailer,
});
const port = Number(process.env.PORT || 3001);
await app.listen({ port, host: process.env.HOST || '0.0.0.0' });
console.log(`Typing service listening on port ${port}`);
