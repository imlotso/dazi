import pg from 'pg';
import { importSqlite } from '../server/postgres/import-sqlite';
import { migratePostgres } from '../server/postgres/migrate';

async function main() {
  const action = process.argv[2];
  if (action !== 'migrate' && action !== 'import') throw new Error('Use migrate or import');
  const connectionString = process.env.DATABASE_URL;
  const database = process.env.DAZI_DATABASE_NAME;
  const schema = process.env.DAZI_DATABASE_SCHEMA;
  if (!connectionString || !database || !schema || process.env.DAZI_CONFIRM_TARGET !== `${database}/${schema}`) {
    throw new Error('DATABASE_URL and an explicitly confirmed target database/schema are required');
  }
  const source = process.argv[3];
  if (action === 'import' && !source) throw new Error('An explicit SQLite source path is required');
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query(`SET search_path TO "${schema.replaceAll('"', '""')}", pg_catalog`);
    if (action === 'migrate') {
      await migratePostgres(client, { database, schema });
      console.log('PostgreSQL schema is ready.');
    } else {
      const { counts } = await importSqlite(client, source, { database, schema });
      console.log('Import verified and committed.');
      for (const [table, count] of Object.entries(counts)) console.log(`${table}: ${count}`);
    }
  } finally { await client.end(); }
}

main().catch((error: unknown) => {
  // Database drivers can include SQL parameters, hostnames, and credentials in
  // their diagnostics. Only print fixed, explicitly safe operator messages.
  const safe = error instanceof Error && [
    'Use migrate or import',
    'DATABASE_URL and an explicitly confirmed target database/schema are required',
    'An explicit SQLite source path is required',
    'PostgreSQL target does not match the explicitly selected database and schema',
    'PostgreSQL target schema is not empty',
    'PostgreSQL target is not empty',
    'Unsupported PostgreSQL schema version',
    'SQLite integrity or foreign-key validation failed',
    'SQLite source contains unsupported tables',
  ].includes(error.message) ? error.message : 'Database operation failed; commit status may be unknown. Inspect the target before retrying.';
  console.error(safe);
  process.exitCode = 1;
});
