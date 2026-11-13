import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const dayPicture = resolve('public/assets/cloud-room.png');
const nightPicture = resolve('public/assets/cloud-room-night.png');

async function editor(page: Page, theme = '日间') {
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '背景图', exact: true }).click();
  return page.getByRole('dialog', { name: `${theme}背景`, exact: true });
}
async function upload(page: Page, file = nightPicture) {
  await page.getByLabel('背景图片').setInputFiles(file);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
}
async function save(page: Page) {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function register(page: Page, username: string) {
  const email = `${username}@example.test`;
  expect((await page.request.post('/api/auth/code', { data: { email, purpose: 'register' } })).ok()).toBe(true);
  const { code } = await (await page.request.get(`/__e2e__/email-code?email=${email}&purpose=register`)).json();
  expect((await page.request.post('/api/auth/register', { data: { email, username, password: 'background-test-2026', code } })).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByRole('button', { name: username, exact: true })).toBeVisible();
}

test('uploads a real raster, adjusts it, preserves typing and restores default after reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '开始练习' }).click();
  await page.getByRole('textbox', { name: '当前行输入' }).fill('我与父亲');
  const dialog = await editor(page);
  await upload(page);
  await dialog.getByRole('combobox', { name: '显示方式' }).selectOption('contain');
  await dialog.getByRole('slider', { name: '水平位置' }).press('Home');
  await dialog.getByRole('slider', { name: '垂直位置' }).press('End');
  await dialog.getByRole('slider', { name: '模糊' }).press('ArrowRight');
  await save(page);
  const image = page.getByTestId('custom-background-image');
  await expect(image).toBeVisible();
  await expect(image).toHaveCSS('object-fit', 'contain');
  await expect(image).toHaveCSS('object-position', '0% 100%');
  await expect(image).toHaveCSS('filter', 'blur(1px)');
  await expect(page.locator('.sleeping-cat')).toHaveCount(0);
  await expect(page.getByTestId('typed-count')).toHaveText('4');
  await expect(page.getByRole('button', { name: '继续练习' })).toBeEnabled();
  const source = await image.getAttribute('src');
  expect(source).toMatch(/^data:image\/webp;base64,/);
  expect(source!.length).toBeLessThan(1_048_610);
  await page.reload();
  await expect(image).toHaveAttribute('src', source!);
  await expect(page.getByTestId('typed-count')).toHaveText('4');
  await editor(page);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await save(page);
  await expect(image).toHaveCount(0);
  await expect(page.locator('.sleeping-cat')).toBeVisible();
  await page.reload();
  await expect(image).toHaveCount(0);
});

test('rejects damaged/active files and cancels a valid replacement without losing the saved background', async ({ page }) => {
  await page.goto('/'); await editor(page); await upload(page); await save(page);
  const source = await page.getByTestId('custom-background-image').getAttribute('src');
  await editor(page);
  await page.getByLabel('背景图片').setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert')).toHaveText('请选择 JPG、PNG 或 WebP 图片');
  await page.getByLabel('背景图片').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') });
  await expect(page.getByRole('alert')).toHaveText('图片无法读取');
  await upload(page, dayPicture);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('custom-background-image')).toHaveAttribute('src', source!);
  await page.reload();
  await expect(page.getByTestId('custom-background-image')).toHaveAttribute('src', source!);
});

test('decodes and stores JPEG, PNG and WebP uploads through the real browser encoder', async ({ page }) => {
  await page.goto('/');
  for (const format of ['jpeg', 'png', 'webp']) {
    const raster = await page.evaluate((type) => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 16;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#9383c4'; context.fillRect(0, 0, 24, 16);
      return canvas.toDataURL('image/' + type);
    }, format);
    await editor(page);
    await page.getByLabel('背景图片').setInputFiles({ name: `picture.${format}`, mimeType: `image/${format}`, buffer: Buffer.from(raster.split(',')[1], 'base64') });
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await save(page);
    await expect(page.getByTestId('custom-background-image')).toBeVisible();
    expect(await page.getByTestId('custom-background-image').evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([24, 16]);
  }
});

test('keeps phone controls reachable and day/night backgrounds independent', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/'); await editor(page); await upload(page); await save(page);
  const daySource = await page.getByTestId('custom-background-image').getAttribute('src');
  await page.getByRole('button', { name: '切换至夜间模式' }).click();
  await expect(page.getByTestId('custom-background-image')).toHaveCount(0);
  await editor(page, '夜间'); await upload(page, dayPicture);
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await save(page);
  const nightSource = await page.getByTestId('custom-background-image').getAttribute('src');
  expect(nightSource).not.toBe(daySource);
  await page.getByRole('button', { name: '切换至日间模式' }).click();
  await expect(page.getByTestId('custom-background-image')).toHaveAttribute('src', daySource!);
});

test('syncs the image and reset across independent accounts/devices without sharing visitor data', async ({ page, browser, baseURL }) => {
  const username = 'bg' + Date.now().toString(36);
  await register(page, username);
  await editor(page); await upload(page); await save(page);
  await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).items.some((item: { kind: string; deleted?: boolean }) => item.kind === 'background' && !item.deleted)).toBe(true);
  await page.getByRole('button', { name: '文章库', exact: true }).click();
  const ordinarySync = page.waitForResponse((response) => response.url().endsWith('/api/workspace/sync') && response.request().postData()?.includes('favorite') === true);
  await page.getByRole('button', { name: '收藏《背影》' }).click();
  const syncResult = await (await ordinarySync).json();
  expect(syncResult.backgroundsUnchanged).toBe(true);
  expect(syncResult.items.some((item: { kind: string }) => item.kind === 'background')).toBe(false);
  await expect(page.getByTestId('custom-background-image')).toBeVisible();
  const context = await browser.newContext({ baseURL });
  const second = await context.newPage();
  try {
    expect((await second.request.post('/api/auth/login', { data: { identifier: username, password: 'background-test-2026' } })).ok()).toBe(true);
    await second.goto('/');
    await expect(second.getByTestId('custom-background-image')).toBeVisible();
    await editor(second); await second.getByRole('button', { name: '恢复默认', exact: true }).click(); await save(second);
    await expect.poll(async () => (await (await second.request.get('/api/workspace')).json()).items.some((item: { kind: string; deleted?: boolean }) => item.kind === 'background' && item.deleted)).toBe(true);
    await page.reload(); await expect(page.getByTestId('custom-background-image')).toHaveCount(0);
    await editor(page); await upload(page); await save(page);
    await page.getByRole('button', { name: username, exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByTestId('custom-background-image')).toHaveCount(0);
    await register(page, username + 'b');
    await expect(page.getByTestId('custom-background-image')).toHaveCount(0);
  } finally { await context.close(); }
});
