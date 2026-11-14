import { readFileSync, existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { getTransformedRoutes } from '@vercel/routing-utils';

it('maps every nested API path to an existing Vercel Function using Vercel routing rules', () => {
  const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const result = getTransformedRoutes(config);
  expect(result.error).toBeNull();
  const routes = result.routes ?? [];
  for (const path of ['/api/health', '/api/auth/login', '/api/workspace/sync', '/api/tests/example/pause']) {
    const matched = routes.find((route) => 'src' in route && route.src && new RegExp(route.src).test(path));
    expect(matched).toBeDefined();
    expect(matched && 'dest' in matched && matched.dest).toMatch(/^\/api\/handler/);
  }
  expect(existsSync('api/handler.ts')).toBe(true);
});
