import { AsyncLocalStorage } from 'node:async_hooks';
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

// Which organization the current request belongs to. Every request runs in a
// context (see requestContext); signing in or reading a connector token sets
// its organization. Row-level security in the database then only shows that
// organization's rows. With no organization set, company tables show nothing.
const als = new AsyncLocalStorage();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestContext(req, res, next) {
  als.run({ orgId: null, bypass: false }, next);
}

// Sets the organization for the rest of this request.
export function setOrg(orgId) {
  const store = als.getStore();
  if (!store) throw new Error('no request context');
  if (!UUID.test(String(orgId))) throw new Error('bad organization id');
  store.orgId = orgId;
}

export const currentOrg = () => als.getStore()?.orgId ?? null;

// Runs fn across all organizations. Only for background jobs, migrations and
// looking up an account by something secret (email at sign-in, a token) before
// its organization is known.
export function asSystem(fn) {
  return als.run({ orgId: null, bypass: true }, fn);
}

// Runs fn inside one organization.
export function withOrg(orgId, fn) {
  if (!UUID.test(String(orgId))) throw new Error('bad organization id');
  return als.run({ orgId, bypass: false }, fn);
}

// Keeps the context across libraries whose callbacks lose it (multer).
export function bindContext(fn) {
  const store = als.getStore();
  return store ? (...args) => als.run(store, () => fn(...args)) : fn;
}

// The settings for this transaction. The id is checked against the UUID
// pattern above, so it is safe to put in the statement.
function scopeSql() {
  const store = als.getStore();
  if (store?.bypass) return "SELECT set_config('app.bypass', 'on', true), set_config('app.org_id', '', true)";
  if (store?.orgId) return `SELECT set_config('app.bypass', 'off', true), set_config('app.org_id', '${store.orgId}', true)`;
  return null;
}

// Inside a transaction already open on `db`, switch to one organization
// (after looking something up as the system).
export async function scopeTo(db, orgId) {
  if (!UUID.test(String(orgId))) throw new Error('bad organization id');
  await db.query(`SELECT set_config('app.bypass', 'off', true), set_config('app.org_id', '${orgId}', true)`);
}

export async function q(text, params) {
  const scope = scopeSql();
  if (!scope) return getPool().query(text, params);
  const client = await getPool().connect();
  try {
    await client.query(`BEGIN; ${scope}`);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one(text, params) {
  const { rows } = await q(text, params);
  return rows[0] ?? null;
}

// Runs fn(client) inside a transaction. Every service function takes a
// `db` argument that is either the pool or this client.
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const scope = scopeSql();
    if (scope) await client.query(scope);
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
