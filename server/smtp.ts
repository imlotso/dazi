import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { AsyncDatabase } from './database/types.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { AdminActor, createAdminAudit } from './admin.js';

type SmtpSource = 'admin' | 'deployment';
export type SmtpConfiguration = {
  host: string; port: number; security: 'tls' | 'starttls' | 'opportunistic';
  from: string; username: string; password: string;
};
export type Mailer = { sendCode(email: string, code: string, purpose: string): Promise<void> };
export type SmtpDelivery = {
  verify(config: SmtpConfiguration, source: SmtpSource): Promise<void>;
  sendCode(config: SmtpConfiguration, source: SmtpSource, ...message: Parameters<Mailer['sendCode']>): Promise<void>;
};

const hostPattern = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const adminPorts = [25, 465, 587, 2525];
const safeText = /^[^\p{Cc}\p{Cf}]*$/u;
const fields = {
  host: z.string().trim().max(253).regex(hostPattern).transform((host) => host.toLowerCase()),
  port: z.number().int().refine((port) => adminPorts.includes(port)),
  security: z.enum(['tls', 'starttls']),
  from: z.email().max(254),
  username: z.string().trim().max(254).regex(safeText),
  password: z.string().min(1).max(1024).regex(safeText).optional(),
};
const revisionField = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const saveInput = z.strictObject({ revision: revisionField, ...fields });
const verifyInput = z.strictObject({ revision: revisionField, draft: z.strictObject(fields).optional() });
const resetInput = z.strictObject({ revision: revisionField });
type RevisionInput = z.infer<typeof resetInput>;
type Draft = z.infer<typeof verifyInput>['draft'];
type StoredSmtp = Omit<SmtpConfiguration, 'password'> & { secret: string | null };

class SmtpError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const blockedV4 = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blockedV4.addSubnet(ip, bits);
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blockedV6.addSubnet(ip, bits, 'ipv6');
}

export function isPublicSmtpAddress(address: string) {
  switch (isIP(address)) {
    case 4: return !blockedV4.check(address);
    case 6: return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
    default: return false;
  }
}

async function resolvePublicSmtpHost(host: string) {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  // Resolve both families before opening a socket. Passing the selected address to
  // Nodemailer prevents a second hostname lookup from changing the destination.
  const records = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const addresses = records.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (!addresses.length) throw new SmtpError('无法解析 SMTP 主机');
  if (!addresses.every(isPublicSmtpAddress)) throw new SmtpError('SMTP 主机须解析为公网地址');
  return addresses[0];
}

async function createSmtpTransport(config: SmtpConfiguration, source: SmtpSource) {
  const host = source === 'admin' ? await resolvePublicSmtpHost(config.host) : config.host;
  return nodemailer.createTransport({
    host, port: config.port, secure: config.security === 'tls', requireTLS: config.security === 'starttls',
    tls: { ...(source === 'admin' && { servername: config.host }), rejectUnauthorized: true },
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    forceAuth: source === 'admin' && Boolean(config.username),
    connectionTimeout: 8_000, greetingTimeout: 5_000, socketTimeout: 10_000, dnsTimeout: 3_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

const defaultDelivery: SmtpDelivery = {
  async verify(config, source) { await (await createSmtpTransport(config, source)).verify(); },
  async sendCode(config, source, email, code, purpose) {
    const label = purpose === 'register' ? '注册' : purpose === 'reset' ? '重设密码' : '登录';
    await (await createSmtpTransport(config, source)).sendMail({
      from: config.from, to: email, subject: `云打字练习 · ${label}验证码`,
      text: `你的${label}验证码是 ${code}，10 分钟内有效。请勿将验证码告诉他人。`,
    });
  },
};

function verifyFailure(error: unknown) {
  if (error instanceof SmtpError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  if (code === 'EAUTH') return 'SMTP 身份验证失败';
  if (code === 'ETLS' || code === 'ESOCKET') return 'SMTP 连接或 TLS 验证失败';
  if (code === 'ETIMEDOUT') return 'SMTP 连接超时';
  if (code === 'EDNS') return '无法解析 SMTP 主机';
  return 'SMTP 验证失败，请检查主机、端口和加密方式';
}

export async function createSmtpSettings(db: AsyncDatabase, {
  codeSecret, deployment, fallbackMailer, delivery = defaultDelivery, now,
}: {
  codeSecret?: string; deployment?: SmtpConfiguration; fallbackMailer?: Mailer; delivery?: SmtpDelivery; now: () => number;
}) {
  if (db.dialect === 'sqlite') await db.exec(`CREATE TABLE IF NOT EXISTS smtp_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, config TEXT, updated_at INTEGER NOT NULL
  );`);
  const select = db.prepare('SELECT revision,config,updated_at AS updatedAt FROM smtp_settings WHERE id=1');
  const upsert = db.prepare(`INSERT INTO smtp_settings(id,revision,config,updated_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config,updated_at=excluded.updated_at`);
  const key = codeSecret && codeSecret.length >= 32
    ? createHmac('sha256', codeSecret).update('dazi.smtp.credentials.v1').digest() : undefined;

  async function stored() {
    const row = (await select.get()) as { revision: number; config: string | null; updatedAt: number } | undefined;
    return { revision: row?.revision ?? 0, override: row?.config ? JSON.parse(row.config) as StoredSmtp : undefined, updatedAt: row?.updatedAt ?? null };
  }

  function cryptKey() {
    if (!key) throw new SmtpError('部署需配置至少 32 字符的 CODE_SECRET', 503);
    return key;
  }

  function encrypt(password: string) {
    if (!password) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', cryptKey(), iv);
    const bytes = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }

  function decrypt(secret: string | null) {
    if (!secret) return '';
    const encryptionKey = cryptKey();
    try {
      const bytes = Buffer.from(secret, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } catch {
      throw new SmtpError('SMTP 密码无法解密，请重新填写密码', 409);
    }
  }

  function restore({ secret, ...config }: StoredSmtp): SmtpConfiguration {
    return { ...config, password: decrypt(secret) };
  }

  async function describe() {
    const { override, ...state } = await stored();
    const config = override ?? deployment;
    const source = override ? 'admin' : deployment ? 'deployment' : fallbackMailer ? 'development' : 'unconfigured';
    const protectedPassword = override?.secret ?? null;
    let passwordState = deployment?.password && !override ? 'deployment' : 'empty';
    if (protectedPassword) {
      try { decrypt(protectedPassword); passwordState = 'saved'; }
      catch { passwordState = 'unavailable'; }
    }
    return {
      ...state, source, editable: Boolean(key), passwordState,
      fallback: deployment ? 'deployment' : fallbackMailer ? 'development' : 'unconfigured',
      config: config ? { host: config.host, port: config.port, security: config.security, from: config.from, username: config.username } : null,
    };
  }

  function resolveDraft(draft: NonNullable<Draft>, existing?: StoredSmtp): SmtpConfiguration {
    const { username, password, ...settings } = draft;
    if (!username) {
      if (password) throw new SmtpError('填写 SMTP 密码时须填写账号');
      return { ...settings, username, password: '' };
    }
    if (password) return { ...settings, username, password };
    const sameAccount = existing && existing.host === settings.host && existing.port === settings.port
      && existing.security === settings.security && existing.username === username;
    if (!sameAccount || !existing.secret) throw new SmtpError('请输入 SMTP 密码');
    return { ...settings, username, password: decrypt(existing.secret) };
  }

  async function checked(input: RevisionInput) {
    const state = await stored();
    if (state.revision !== input.revision) throw new SmtpError('邮件配置已变更，请刷新后重试', 409);
    return state;
  }

  function register(app: FastifyInstance, audit: ReturnType<typeof createAdminAudit>, assertCurrentAdmin: (request: FastifyRequest) => Promise<void>) {
    const write = db.transaction(async (request: FastifyRequest, input: z.infer<typeof saveInput> | RevisionInput) => {
      await assertCurrentAdmin(request);
      const actor: AdminActor = request.admin;
      const { override, revision } = await checked(input);
      if ('host' in input) {
        cryptKey();
        const { revision: _, ...draft } = input;
        const { password, ...config } = resolveDraft(draft, override);
        (await upsert.run(revision + 1, JSON.stringify({ ...config, secret: encrypt(password) }), now()));
        await audit(actor, 'smtp.update', 'setting', 'smtp', '邮件配置', null);
      } else {
        if (!override) throw new SmtpError('当前使用部署默认配置', 409);
        (await upsert.run(revision + 1, null, now()));
        await audit(actor, 'smtp.reset', 'setting', 'smtp', '邮件配置', null);
      }
      return describe();
    });

    app.get('/smtp', async () => describe());
    app.post('/smtp', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const parsed = saveInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '请检查 SMTP 主机、端口和发件人邮箱' });
      try {
        const { override } = await checked(parsed.data);
        cryptKey();
        const { host } = resolveDraft(parsed.data, override);
        await resolvePublicSmtpHost(host);
        return await write.immediate(request, parsed.data);
      } catch (error) {
        if (error instanceof SmtpError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    });
    app.post('/smtp/reset', async (request, reply) => {
      const parsed = resetInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '邮件配置版本无效' });
      try { return await write.immediate(request, parsed.data); }
      catch (error) {
        if (error instanceof SmtpError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    });
    app.post('/smtp/verify', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
      const parsed = verifyInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '请检查 SMTP 主机、端口和发件人邮箱' });
      const { draft } = parsed.data;
      let config: SmtpConfiguration | undefined;
      let source: SmtpSource;
      try {
        const { override } = await checked(parsed.data);
        config = draft ? resolveDraft(draft, override) : override ? restore(override) : deployment;
        source = override || draft ? 'admin' : 'deployment';
      } catch (error) {
        if (error instanceof SmtpError) return reply.code(error.status).send({ error: error.message });
        throw error;
      }
      if (!config) return reply.code(409).send({ error: '请先填写 SMTP 配置' });
      await audit(request.admin, 'smtp.verify', 'setting', 'smtp', '邮件配置', null);
      try { await delivery.verify(config, source); }
      catch (error) { return reply.code(502).send({ error: verifyFailure(error) }); }
      return { ok: true };
    });
  }

  async function mailer(): Promise<Mailer | undefined> {
    const { override } = await stored();
    if (override) return { async sendCode(...args) { await delivery.sendCode(restore(override), 'admin', ...args); } };
    if (deployment) return { async sendCode(...args) { await delivery.sendCode(deployment, 'deployment', ...args); } };
    return fallbackMailer;
  }

  async function assertStoredSecret() {
    const { override } = await stored();
    if (override?.secret) decrypt(override.secret);
  }

  return { register, mailer, assertStoredSecret };
}
