import pg from 'pg';
import { importSqlite } from '../server/postgres/import-sqlite';
import { exportSqlite } from '../server/postgres/export-sqlite';
import { assertPostgresTarget, migratePostgres } from '../server/postgres/migrate';
import { PostgresDatabase } from '../server/postgres/database';
import { AsyncPostgres } from '../server/database/postgres';
import { seedPostgresCatalog } from '../server/postgres/seed';
import { bootstrapPostgresAdmin } from '../server/postgres/bootstrap';

async function readPassword() {
  if (process.stdin.isTTY) throw new Error('Supply the administrator password through standard input');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 514) throw new Error('Invalid administrator details');
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/u, '');
}

async function main() {
  const action = process.argv[2];
  if (action !== 'migrate' && action !== 'import' && action !== 'export' && action !== 'seed' && action !== 'bootstrap') throw new Error('Use migrate, import, export, seed or bootstrap');
  const connectionString = process.env.DATABASE_URL;
  const database = process.env.DAZI_DATABASE_NAME;
  const schema = process.env.DAZI_DATABASE_SCHEMA;
  const host = process.env.DAZI_DATABASE_HOST;
  if (!connectionString || !database || !schema || !host || process.env.DAZI_CONFIRM_TARGET !== `${host}/${database}/${schema}`) {
    throw new Error('DATABASE_URL and an explicitly confirmed target database/schema are required');
  }
  if (new URL(connectionString).hostname !== host) throw new Error('PostgreSQL endpoint does not match the explicitly confirmed target');
  const source = process.argv[3];
  if (action === 'import' && !source) throw new Error('An explicit SQLite source path is required');
  if (action === 'export' && !source) throw new Error('An explicit SQLite destination is required');
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query(`SET search_path TO "${schema.replaceAll('"', '""')}", pg_catalog`);
    if (action === 'migrate') {
      await migratePostgres(client, { database, schema });
      console.log('PostgreSQL schema is ready.');
    } else if (action === 'import') {
      const { counts } = await importSqlite(client, source, { database, schema });
      console.log('Import verified and committed.');
      for (const [table, count] of Object.entries(counts)) console.log(`${table}: ${count}`);
    } else if (action === 'export') {
      const { counts } = await exportSqlite(client, source, { database, schema });
      console.log('SQLite export verified and written to a new file.');
      for (const [table, count] of Object.entries(counts)) console.log(`${table}: ${count}`);
    } else {
      await assertPostgresTarget(client, { database, schema });
      const databaseStore = new PostgresDatabase(connectionString, schema);
      try {
        await databaseStore.verifySchema();
        const adapter = new AsyncPostgres(databaseStore);
        if (action === 'seed') {
          const count = await seedPostgresCatalog(adapter);
          console.log(`Public articles initialized: ${count}`);
        } else {
          await bootstrapPostgresAdmin(adapter, process.env.ADMIN_USERNAME ?? '', process.env.ADMIN_EMAIL ?? '', await readPassword());
          console.log('First administrator created.');
        }
      } finally { await databaseStore.close(); }
    }
  } finally { await client.end(); }
}

main().catch((error: unknown) => {
  // Database drivers can include SQL parameters, hostnames, and credentials in
  // their diagnostics. Only print fixed, explicitly safe operator messages.
  const safe = error instanceof Error && [
    'Use migrate, import, export, seed or bootstrap',
    'DATABASE_URL and an explicitly confirmed target database/schema are required',
    'An explicit SQLite source path is required',
    'An explicit SQLite destination is required',
    'SQLite destination already exists',
    'PostgreSQL target does not match the explicitly selected database and schema',
    'PostgreSQL endpoint does not match the explicitly confirmed target',
    'PostgreSQL target schema is not empty',
    'PostgreSQL target is not empty',
    'PostgreSQL catalog is not empty',
    'Supply the administrator password through standard input',
    'Invalid administrator details',
    'An administrator already exists',
    'Administrator account is unavailable',
    'Unsupported PostgreSQL schema version',
    'SQLite integrity or foreign-key validation failed',
    'SQLite source contains unsupported tables',
  ].includes(error.message) ? error.message : 'Database operation failed; commit status may be unknown. Inspect the target before retrying.';
  console.error(safe);
  process.exitCode = 1;
});
