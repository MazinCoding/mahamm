// Applies every migrations/*.sql file not yet recorded in schema_migrations,
// each inside its own transaction. Safe to run on every deploy.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig, ConfigError } from '../src/config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(databaseUrl, sslOption = false, log = console.log) {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: sslOption });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const config = loadConfig();
    let ssl = false;
    if (config.databaseSsl === 'require') ssl = { rejectUnauthorized: false };
    if (config.databaseSsl === 'verify-full') ssl = { rejectUnauthorized: true, ca: config.databaseCaCert };
    await migrate(process.env.MIGRATION_DATABASE_URL || config.databaseUrl, ssl);
    console.log('migrations up to date');
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `Migration error: ${err.message}`);
    process.exit(1);
  }
}
