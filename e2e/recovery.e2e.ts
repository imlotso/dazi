import { expect, test } from './fixtures';
import type { APIRequestContext, Browser } from '@playwright/test';

const password = 'ci-password-123';

async function adminRequest(browser: Browser, baseURL: string, clientIp: string) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { 'X-Forwarded-For': clientIp } });
  let login = await context.request.post('/api/auth/login', { data: { identifier: 'admin@example.test', password } });
  if (!login.ok()) {
    expect((await context.request.post('/api/auth/code', { data: { email: 'admin@example.test', purpose: 'register' } })).ok()).toBe(true);
    const { code } = await (await context.request.get('/__e2e__/email-code?email=admin%40example.test&purpose=register')).json();
    login = await context.request.post('/api/auth/register', { data: { username: 'ci_admin', email: 'admin@example.test', password, code } });
  }
  expect(login.ok()).toBe(true);
  return context;
}

for (const scenario of ['response-lost', 'request-not-delivered'] as const) {
  test(`recovers and ranks a guest practice after ${scenario}`, async ({ page, browser, baseURL, clientIp }) => {
    let started!: (value: { id: string }) => void;
    const created = new Promise<{ id: string }>((resolve) => { started = resolve; });
    await page.route('**/api/tests/start', async (route) => {
      const body = route.request().postDataJSON();
      if (scenario === 'response-lost') {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        started({ id: (await response.json()).id });
      } else started({ id: body.clientId });
      await route.abort('failed');
    });
    await page.goto('/');
    const target = await page.locator('.line-source').evaluateAll((lines) => lines.map((line) => line.getAttribute('data-text')).join(''));
    const input = page.getByRole('textbox', { name: '当前行输入' });
    await input.fill('我与');
    const { id } = await created;
    await expect(page.getByTestId('typed-count')).toHaveText('2');
    await page.waitForTimeout(1300);
    // Simulate the initial guest cookie being lost with an interrupted response.
    await page.context().clearCookies();
    await page.reload();
    await expect(page.getByRole('button', { name: '继续练习' })).toBeEnabled();
    await expect(page.getByTestId('typed-count')).toHaveText('2');
    const recovery = page.waitForResponse((response) => response.url().endsWith('/api/tests/recover') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '继续练习' }).click();
    const recovered = await recovery;
    expect(recovered.status()).toBe(200);
    expect((await recovered.json()).id).toBe(id);
    await expect(page.getByRole('button', { name: '暂停练习' })).toBeEnabled();
    const finished = page.waitForResponse((response) => response.url().endsWith(`/api/tests/${id}/finish`) && response.request().method() === 'POST');
    await page.getByRole('textbox', { name: '当前行输入' }).fill(target!);
    const resultResponse = await finished;
    expect(resultResponse.status()).toBe(200);
    expect((await resultResponse.json())).toMatchObject({ attemptId: id, eligible: true, status: 'review' });
    const result = page.getByRole('dialog', { name: '练习成绩' });
    if (scenario === 'response-lost') {
      await expect(result).toBeVisible();
      await page.context().clearCookies();
      await page.reload();
      await expect(result).toBeVisible();
      await expect(result.getByRole('button', { name: '提交到排行榜' })).toBeVisible();
    }
    await result.getByRole('textbox', { name: '上榜昵称' }).fill(scenario === 'response-lost' ? '恢复丢回包' : '恢复未发出');
    if (scenario === 'response-lost') await page.context().clearCookies();
    const rejected = scenario === 'response-lost' ? page.waitForResponse((response) => response.url().endsWith('/api/leaderboard') && response.status() === 404) : undefined;
    const submitted = page.waitForResponse((response) => response.url().endsWith('/api/leaderboard') && response.request().method() === 'POST' && response.status() === 200);
    await result.getByRole('button', { name: '提交到排行榜' }).click();
    if (rejected) expect((await rejected).status()).toBe(404);
    expect((await submitted).status()).toBe(200);
    await expect(result.getByText('已提交，待复核。')).toBeVisible();
    const admin = await adminRequest(browser, baseURL!, clientIp);
    const pending = await (await admin.request.get('/api/admin/review')).json();
    expect(pending.entries.find((entry: { id: string }) => entry.id === id)?.reasons).toContain('recovered_session');
    expect((await admin.request.post(`/api/admin/review/${id}`, { data: { action: 'approve', reason: '恢复练习验证' } })).ok()).toBe(true);
    const rankings = await (await page.request.get('/api/leaderboard?language=zh&difficulty=beginner&duration=300')).json();
    expect(rankings.entries.some((entry: { attemptId: string }) => entry.attemptId === id)).toBe(true);
    await admin.close();
  });
}

async function register(request: APIRequestContext, username: string) {
  const email = `${username}@example.test`;
  expect((await request.post('/api/auth/code', { data: { email, purpose: 'register' } })).ok()).toBe(true);
  const { code } = await (await request.get('/__e2e__/email-code', { params: { email, purpose: 'register' } })).json();
  expect((await request.post('/api/auth/register', { data: { username, email, password, code } })).ok()).toBe(true);
}

test('recovers an account-synced online draft on a second device', async ({ page, browser, baseURL, clientIp }) => {
  await register(page.request, 'recovery_member');
  await page.route('**/api/tests/start', (route) => route.abort('failed'));
  await page.route('**/api/tests/recover', (route) => route.abort('failed'));
  await page.goto('/');
  await page.getByRole('textbox', { name: '当前行输入' }).fill('我与');
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: '暂停练习' }).click();
  await expect(page.getByRole('button', { name: '继续练习' })).toBeEnabled();
  await page.getByRole('button', { name: '继续练习' }).click();
  await expect(page.getByRole('button', { name: '暂停练习' })).toBeEnabled();
  await page.getByRole('textbox', { name: '当前行输入' }).fill('我与父');
  await page.getByRole('button', { name: '暂停练习' }).click();
  await expect(page.getByRole('button', { name: '继续练习' })).toBeEnabled();
  await expect.poll(async () => {
    const items = (await (await page.request.get('/api/workspace')).json()).items;
    return items.some((item: { kind: string; deleted?: boolean; value?: { typed?: string; elapsedMs?: number; recoveryId?: string; recoveryKey?: string; claimId?: string; recoveryRequestId?: string } }) => item.kind === 'draft' && !item.deleted && item.value?.typed === '我与父' && (item.value.elapsedMs ?? 0) >= 1000 && !!item.value.recoveryId && !!item.value.recoveryKey && !item.value.claimId && !item.value.recoveryRequestId);
  }, { timeout: 15000 }).toBe(true);
  const other = await browser.newContext({ baseURL, extraHTTPHeaders: { 'X-Forwarded-For': clientIp } });
  expect((await other.request.post('/api/auth/login', { data: { identifier: 'recovery_member', password } })).ok()).toBe(true);
  const reader = await other.newPage();
  await reader.goto('/');
  await reader.getByRole('button', { name: '更多' }).click();
  await reader.getByRole('button', { name: '草稿箱' }).click();
  await reader.getByRole('button', { name: '继续《背影》' }).click();
  await expect(reader.getByRole('button', { name: '继续练习' })).toBeEnabled();
  await expect(reader.getByTestId('typed-count')).toHaveText('3');
  await expect(reader.getByTestId('remaining-time')).not.toHaveText('05:00');
  await reader.getByRole('button', { name: '继续练习' }).click();
  await expect(reader.getByRole('button', { name: '暂停练习' })).toBeEnabled();
  const target = await reader.locator('.line-source').evaluateAll((lines) => lines.map((line) => line.getAttribute('data-text')).join(''));
  const finished = reader.waitForResponse((response) => /\/api\/tests\/[^/]+\/finish$/.test(response.url()) && response.request().method() === 'POST');
  await reader.getByRole('textbox', { name: '当前行输入' }).fill(target!);
  expect((await finished).status()).toBe(200);
  const result = reader.getByRole('dialog', { name: '练习成绩' });
  await result.getByRole('button', { name: '提交到排行榜' }).click();
  await expect(result.getByText('已提交，待复核。')).toBeVisible();
  await other.close();
});

test('retries a completed offline score and submits it after connectivity returns', async ({ page }) => {
  let disconnected = true;
  await page.route('**/api/tests/start', (route) => route.abort('failed'));
  await page.route('**/api/tests/recover', (route) => disconnected ? route.abort('failed') : route.continue());
  await page.goto('/');
  const target = await page.locator('.line-source').evaluateAll((lines) => lines.map((line) => line.getAttribute('data-text')).join(''));
  await page.getByRole('textbox', { name: '当前行输入' }).fill('我');
  await page.waitForTimeout(1300);
  await page.getByRole('textbox', { name: '当前行输入' }).fill(target!);
  const result = page.getByRole('dialog', { name: '练习成绩' });
  await expect(result.getByText('成绩尚未同步')).toBeVisible();
  await expect(result.getByRole('button', { name: '重试上榜' })).toBeVisible();
  disconnected = false;
  await result.getByRole('button', { name: '重试上榜' }).click();
  await expect(result.getByRole('button', { name: '提交到排行榜' })).toBeVisible();
  await result.getByRole('textbox', { name: '上榜昵称' }).fill('恢复后重试');
  const submitted = page.waitForResponse((response) => response.url().endsWith('/api/leaderboard') && response.request().method() === 'POST');
  await result.getByRole('button', { name: '提交到排行榜' }).click();
  expect((await submitted).status()).toBe(200);
  await expect(result.getByText('已提交，待复核。')).toBeVisible();
});

test('prevents two devices from submitting the same online round', async ({ page, browser, baseURL, clientIp }) => {
  await register(page.request, 'claim_member');
  await page.goto('/');
  const started = page.waitForResponse((response) => response.url().endsWith('/api/tests/start') && response.status() === 200);
  await page.getByRole('textbox', { name: '当前行输入' }).fill('我');
  const { id } = await (await started).json();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '暂停练习' }).click();
  await expect(page.getByRole('button', { name: '继续练习' })).toBeEnabled();
  await expect.poll(async () => (await (await page.request.get('/api/workspace')).json()).items.some(
    (item: { kind: string; value?: { typed?: string; elapsedMs?: number; claimVersion?: number } }) => item.kind === 'draft' && item.value?.typed === '我' && item.value.claimVersion === 1 && (item.value.elapsedMs ?? 0) >= 1000,
  ), { timeout: 15000 }).toBe(true);
  const other = await browser.newContext({ baseURL, extraHTTPHeaders: { 'X-Forwarded-For': clientIp } });
  expect((await other.request.post('/api/auth/login', { data: { identifier: 'claim_member', password } })).ok()).toBe(true);
  const reader = await other.newPage();
  await reader.goto('/');
  await reader.getByRole('button', { name: '更多' }).click();
  await reader.getByRole('button', { name: '草稿箱' }).click();
  await reader.getByRole('button', { name: '继续《背影》' }).click();
  await expect(reader.getByRole('button', { name: '继续练习' })).toBeEnabled();
  await reader.getByRole('button', { name: '继续练习' }).click();
  await expect(reader.getByRole('button', { name: '暂停练习' })).toBeEnabled();
  await reader.getByRole('textbox', { name: '当前行输入' }).fill('我与');
  await page.getByRole('button', { name: '继续练习' }).click();
  await expect(page.getByText('进度已在其他设备继续，当前练习已另存。')).toBeVisible();
  const target = await reader.locator('.line-source').evaluateAll((lines) => lines.map((line) => line.getAttribute('data-text')).join(''));
  const winner = reader.waitForResponse((response) => response.url().endsWith(`/api/tests/${id}/finish`) && response.status() === 200);
  await reader.getByRole('textbox', { name: '当前行输入' }).fill(target!);
  const winnerResult = await (await winner).json();
  expect(winnerResult.score.total).toBe([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(target!)].length);
  await page.getByRole('textbox', { name: '当前行输入' }).fill(target!);
  const local = page.getByRole('dialog', { name: '练习成绩' });
  await expect(local).toBeVisible();
  await expect(local.getByRole('button', { name: '提交到排行榜' })).toHaveCount(0);
  await expect(local.getByRole('button', { name: '重试上榜' })).toHaveCount(0);
  await other.close();
});

test('recovers a submitted result after its response is lost without submitting twice', async ({ page, browser, baseURL, clientIp }) => {
  let drop = true;
  await page.route('**/api/leaderboard', async (route) => {
    if (drop && route.request().method() === 'POST') {
      drop = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.goto('/');
  const target = await page.locator('.line-source').evaluateAll((lines) => lines.map((line) => line.getAttribute('data-text')).join(''));
  await page.getByRole('textbox', { name: '当前行输入' }).fill('我');
  await page.waitForTimeout(1300);
  await page.getByRole('textbox', { name: '当前行输入' }).fill(target!);
  const result = page.getByRole('dialog', { name: '练习成绩' });
  await result.getByRole('textbox', { name: '上榜昵称' }).fill('回包丢失');
  await result.getByRole('button', { name: '提交到排行榜' }).click();
  await expect(result.getByRole('alert')).toBeVisible();
  await page.reload();
  await expect(result.getByText('已提交，待复核。')).toBeVisible();
  await expect(result.getByRole('button', { name: '提交到排行榜' })).toHaveCount(0);
  const admin = await adminRequest(browser, baseURL!, clientIp);
  const pending = await (await admin.request.get('/api/admin/review')).json();
  expect(pending.entries.filter((entry: { nickname: string }) => entry.nickname === '回包丢失')).toHaveLength(1);
  await admin.close();
});
