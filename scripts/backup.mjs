import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const source = resolve(process.env.DATABASE_PATH || './data/dazi.sqlite');
const destination = resolve(process.argv[2] || `./data/backup-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
if (source === destination) throw new Error('Backup destination must differ from the live database');
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(destination);
  console.log(`Backup created: ${destination}`);
} finally { db.close(); }
