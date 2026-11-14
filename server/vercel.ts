import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachDatabasePool } from '@vercel/functions';
import { createApp } from './app.js';
import type { SmtpConfiguration } from './smtp.js';

/** Create one Fastify instance per warm Function, retrying failed cold starts. */
export function createVercelHandler(env: NodeJS.ProcessEnv = process.env) {
  let pending: Promise<Awaited<ReturnType<typeof createApp>>> | undefined;
  async function app() {
    if (!pending) {
      pending = (async () => {
        const databaseUrl = env.DATABASE_URL;
        const codeSecret = env.CODE_SECRET;
        if (!databaseUrl || !codeSecret || codeSecret.length < 32) throw new Error('Database and stable CODE_SECRET are required');
        let smtp: SmtpConfiguration | undefined;
        if (env.SMTP_HOST && env.SMTP_FROM) {
          const secure = env.SMTP_SECURE === 'true';
          const port = Number(env.SMTP_PORT || (secure ? 465 : 587));
          if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 25) throw new Error('SMTP port is unavailable');
          smtp = { host: env.SMTP_HOST, port, security: secure ? 'tls' : 'starttls', from: env.SMTP_FROM,
            username: env.SMTP_USER || '', password: env.SMTP_PASSWORD || '' };
        }
        const instance = await createApp({ databaseUrl, postgresSchema: env.DAZI_DATABASE_SCHEMA || 'public', codeSecret,
          adminEmail: env.ADMIN_EMAIL, secureCookies: true, trustProxy: true, smtp, onDatabasePool: attachDatabasePool });
        try { await instance.ready(); } catch (error) { await instance.close(); throw error; }
        return instance;
      })().catch((error) => { pending = undefined; throw error; });
    }
    return pending;
  }
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const rewritten = url.searchParams.get('__dazi_path');
      if (rewritten !== null) {
        if (!/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(rewritten)) {
          response.writeHead(400).end();
          return;
        }
        url.searchParams.delete('__dazi_path');
        if (url.searchParams.get('path') === rewritten) url.searchParams.delete('path');
        if (url.pathname === '/api/handler') url.pathname = '/api/' + rewritten;
        request.url = url.pathname + url.search;
      }
      (await app()).server.emit('request', request, response);
    }
    catch {
      if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: '服务暂时不可用，请稍后重试' }));
    }
  };
  return Object.assign(handle, { async close() { if (pending) await (await pending).close(); pending = undefined; } });
}
