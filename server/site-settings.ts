import type { AsyncDatabase } from './database/types.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminActor, createAdminAudit } from './admin.js';

const speedThreshold = z.number().int().min(1).max(1000);
const settingsSchema = z.strictObject({
  registrationEnabled: z.boolean(),
  guestPracticeEnabled: z.boolean(),
  guestLeaderboardEnabled: z.boolean(),
  reviewThresholdZh: speedThreshold,
  reviewThresholdEn: speedThreshold,
});
export type SiteSettings = z.infer<typeof settingsSchema>;
export type SiteSettingsSnapshot = { settings: SiteSettings; revision: number };
const defaults: SiteSettings = {
  registrationEnabled: true,
  guestPracticeEnabled: true,
  guestLeaderboardEnabled: true,
  reviewThresholdZh: 220,
  reviewThresholdEn: 180,
};
const settingLabels: Record<keyof SiteSettings, string> = {
  registrationEnabled: '开放注册',
  guestPracticeEnabled: '游客新开在线练习',
  guestLeaderboardEnabled: '游客提交排行榜',
  reviewThresholdZh: '中文速度复核阈值',
  reviewThresholdEn: '英文速度复核阈值',
};
const fields = Object.keys(settingLabels) as Array<keyof SiteSettings>;
const updateSchema = z.strictObject({ settings: settingsSchema, revision: z.number().int().nonnegative() });

function formatValue(value: number | boolean) {
  return typeof value === 'number' ? String(value) : value ? '开启' : '关闭';
}

export async function createSiteSettings(db: AsyncDatabase, audit: ReturnType<typeof createAdminAudit>) {
  if (db.dialect === 'sqlite') await db.exec(`CREATE TABLE IF NOT EXISTS site_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0)
  )`);
  const select = db.prepare('SELECT settings, revision FROM site_settings WHERE id=1');
  const save = db.prepare(`INSERT INTO site_settings (id, settings, revision) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings=excluded.settings, revision=excluded.revision`);

  async function read(): Promise<SiteSettingsSnapshot> {
    const row = (await select.get()) as { settings: string; revision: number } | undefined;
    return row ? { settings: settingsSchema.parse(JSON.parse(row.settings)), revision: row.revision }
      : { settings: { ...defaults }, revision: 0 };
  }

  const update = db.transaction(async (actor: AdminActor, { settings, revision }: SiteSettingsSnapshot) => {
    const previous = await read();
    if (previous.revision !== revision) return null;
    const changes = fields.filter((key) => previous.settings[key] !== settings[key]);
    if (!changes.length) return previous;

    const nextRevision = revision + 1;
    (await save.run(JSON.stringify(settings), nextRevision));
    const reason = changes.map((key) => `${settingLabels[key]}（${formatValue(previous.settings[key])} → ${formatValue(settings[key])}）`).join('、');
    await audit(actor, 'settings.site.update', 'setting', 'site', '站点设置', reason);
    return { settings, revision: nextRevision };
  });

  return { read, update: update.immediate };
}

export function registerSiteSettingsRoutes(app: FastifyInstance, store: Awaited<ReturnType<typeof createSiteSettings>>) {
  app.get('/settings/site', async () => store.read());
  app.post('/settings/site', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '站点设置无效' });
    const updated = await store.update(request.admin, parsed.data);
    if (!updated) return reply.code(409).send({ error: '站点设置已更新，请重新加载' });
    return updated;
  });
}
