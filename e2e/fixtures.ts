import { createHash } from 'node:crypto';
import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

export const test = base.extend<{ clientIp: string }>({
  clientIp: [async ({ context }, use, testInfo) => {
    const bytes = createHash('sha256').update(`${testInfo.testId}:${testInfo.retry}`).digest();
    const clientIp = `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
    await context.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp });
    await use(clientIp);
  }, { auto: true }],
});
