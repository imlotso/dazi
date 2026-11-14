import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('refuses PostgreSQL migration when no explicit database target is configured', () => {
  const env = { ...process.env, DATABASE_URL: '', DAZI_DATABASE_NAME: '', DAZI_DATABASE_SCHEMA: '', DAZI_CONFIRM_TARGET: '' };
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/postgres-database.ts', 'migrate'], { env, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/DATABASE_URL|target/i);
});

it('refuses a URL from a different endpoint even when database and schema names match', () => {
  const env = { ...process.env, DATABASE_URL: 'postgresql://user:private-test-password@production.example.test/neondb',
    DAZI_DATABASE_HOST: 'preview.example.test', DAZI_DATABASE_NAME: 'neondb', DAZI_DATABASE_SCHEMA: 'public',
    DAZI_CONFIRM_TARGET: 'preview.example.test/neondb/public' };
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/postgres-database.ts', 'migrate'], { env, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/endpoint does not match/i);
  expect(result.stderr).not.toContain('private-test-password');
});
