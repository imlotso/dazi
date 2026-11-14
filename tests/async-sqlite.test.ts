import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AsyncSqlite } from '../server/database/sqlite';

it('serializes asynchronous transactions and prevents unrelated writes joining a rollback', async () => {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE items(id TEXT PRIMARY KEY)');
  const db = new AsyncSqlite(raw);
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = db.transaction(async () => {
    await db.prepare('INSERT INTO items(id) VALUES (?)').run('rolled-back');
    entered();
    await gate;
    throw new Error('intentional rollback');
  });
  const first = transaction();
  await inside;
  const unrelated = db.prepare('INSERT INTO items(id) VALUES (?)').run('preserved');
  release();
  await expect(first).rejects.toThrow('intentional rollback');
  await unrelated;
  expect(await db.prepare('SELECT id FROM items').all()).toEqual([{ id: 'preserved' }]);
  await db.close();
});
