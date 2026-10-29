import pg from 'pg';

// Dates come back as JS Dates; `date` columns stay as 'YYYY-MM-DD' strings
// so a due date never shifts a day because of the server's time zone.
pg.types.setTypeParser(1082, (v) => v);

let pool = null;

export function initDb(config, logger) {
  let ssl = false;
  if (config.databaseSsl === 'require') ssl = { rejectUnauthorized: false };
  if (config.databaseSsl === 'verify-full') ssl = { rejectUnauthorized: true, ca: config.databaseCaCert };
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl,
    max: 10,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    application_name: 'mahamm',
  });
  pool.on('error', (err) => logger?.error({ err }, 'postgres pool error'));
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('Database not initialised');
  return pool;
}

export function q(text, params) {
  return getPool().query(text, params);
}

export async function one(text, params) {
  const { rows } = await getPool().query(text, params);
  return rows[0] ?? null;
}

// Runs fn(client) inside a transaction. Every service function takes a
// `db` argument that is either the pool or this client.
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  if (pool) await pool.end();
  pool = null;
}
