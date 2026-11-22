import { createHash } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { encryptField, initCrypto } from '../src/crypto.js';
import { asSystem, closeDb, initDb, q as dbq, withOrg } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { setTransport } from '../src/mail.js';
import { initNotify } from '../src/notify.js';
import { hashPassword } from '../src/passwords.js';
import { currentCode, newTotpSecret } from '../src/totp.js';
import { migrate } from '../scripts/migrate.js';

export const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55432/mahamm_test';
export const PASSWORD = 'correct-horse-battery-42';

export const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB,
  SESSION_SECRET: 's'.repeat(48),
  DATA_ENCRYPTION_KEY: 'k'.repeat(48),
  SETUP_TOKEN: 'setup-token-for-tests-0123456789',
  PASSWORD_BREACH_CHECK: 'false',
  APP_URL: 'http://localhost:3000',
};

// Organization #1, created by migration 009; the tests' people and tasks live there.
export const ORG1 = '00000000-0000-4000-8000-000000000001';

// The app under test connects as a role that is not a superuser and doesn't own
// the tables, so row-level security applies to it exactly as it does to the
// live app after migration 010 forces it. Its password is derived from the
// test database address, so nothing secret is written here.
const APP_ROLE = 'mahamm_rls_test';
function appDatabaseUrl() {
  const url = new URL(TEST_DB);
  url.username = APP_ROLE;
  url.password = createHash('sha256').update(`${TEST_DB}:${APP_ROLE}`).digest('hex');
  return { url: url.toString(), password: url.password };
}

// Fresh schema for each test file, then the real migrations.
export async function setup(envOverrides = {}) {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
  await admin.query('CREATE SCHEMA public');
  await migrate(TEST_DB, false, () => {});
  const appDb = appDatabaseUrl();
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  END $$`);
  await admin.query(`ALTER ROLE ${APP_ROLE} PASSWORD '${appDb.password}'`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await admin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
  await admin.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  await admin.end();
  const config = loadConfig({ ...testEnv, DATABASE_URL: appDb.url, ...envOverrides });
  const logger = createLogger(config);
  initDb(config, logger);
  initCrypto(config.dataKey);
  initNotify(config);
  const sent = [];
  setTransport({ sendMail: async (m) => { sent.push(m); return {}; } });
  const app = createApp(config, logger);
  return { app, config, sent };
}

// Tests read and write the database directly as the system (all organizations),
// like a background job would. Requests to the app still run in one organization.
export const q = (text, params) => asSystem(() => dbq(text, params));
export const inOrg = (orgId, fn) => withOrg(orgId, fn);

export async function teardown() {
  await closeDb();
}

export async function resetLimits() {
  await q('DELETE FROM rate_limits');
}

let n = 0;
export async function createUser({ name, email, role = 'member', status = 'active', twoFactor = false, org = ORG1 } = {}) {
  n += 1;
  const totpSecret = twoFactor ? newTotpSecret() : null;
  const { rows } = await q(
    `INSERT INTO users (email, name, password_hash, role, status, totp_enabled, totp_secret_enc, org_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, email, name, role, org_id`,
    [email || `person${n}@example.com`, name || `Person Number${n}`, await hashPassword(PASSWORD), role, status, twoFactor, totpSecret ? encryptField(totpSecret) : null, org],
  );
  return { ...rows[0], totpSecret };
}

export function csrfIn(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/) || html.match(/name="csrf-token" content="([^"]+)"/);
  return m ? m[1] : null;
}

export async function tokenFor(agent, path = '/board') {
  const res = await agent.get(path);
  return csrfIn(res.text);
}

// Signs in through the real forms (including the two-step page for admins).
export async function signIn(app, user, password = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: user.email, password });
  if (res.headers.location === '/login/two-factor') {
    const twoFactorPage = await agent.get('/login/two-factor');
    await new Promise((r) => setTimeout(r, 5));
    const done = await agent.post('/login/two-factor').type('form').send({ _csrf: csrfIn(twoFactorPage.text), code: currentCode(user.totpSecret) });
    if (done.status !== 302) throw new Error(`two-step sign-in failed: ${done.status}`);
  } else if (res.status !== 302) {
    throw new Error(`sign-in failed: ${res.status}`);
  }
  return agent;
}

export async function post(agent, path, body, fromPage = '/board') {
  const token = await tokenFor(agent, fromPage);
  return agent.post(path).type('form').send({ _csrf: token, ...body });
}

export async function makeTask(agent, fields = {}) {
  const token = await tokenFor(agent, '/tasks/new');
  const req = agent.post('/tasks').field('_csrf', token).field('title', fields.title || 'A task').field('description', fields.description || '')
    .field('priority', fields.priority || 'med').field('status', fields.status || 'todo').field('due_date', fields.due_date || '');
  for (const a of fields.assignees || []) req.field('assignees', a);
  for (const l of fields.labels || []) req.field('labels', String(l));
  const res = await req;
  const id = Number((res.headers.location || '').split('/').pop());
  if (!id) throw new Error(`task not created: ${res.status} ${res.text.slice(0, 300)}`);
  return id;
}

export async function auditFor(taskId) {
  return (await q('SELECT action, actor_id, details FROM audit_events WHERE task_id = $1 ORDER BY id', [taskId])).rows;
}

// Connects `user` the way an outside app would (registration, consent, code
// exchange with PKCE) and returns an access token for the connector.
export async function connectApp(app, user, returnUri) {
  const { createHash, randomBytes } = await import('node:crypto');
  const agent = await signIn(app, user);
  const reg = await request(app).post('/oauth/register').send({ client_name: 'Test app', redirect_uris: [returnUri] });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const page = await agent.get(`/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: reg.body.client_id, redirect_uri: returnUri, code_challenge: challenge, code_challenge_method: 'S256', scope: 'tasks offline_access',
  })}`);
  const form = page.text.slice(page.text.indexOf('action="/oauth/authorize"'));
  const fields = Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  const back = await agent.post('/oauth/authorize').type('form').send({ ...fields, decision: 'allow' });
  const code = new URL(back.headers.location).searchParams.get('code');
  const res = await request(app).post('/oauth/token').type('form')
    .send({ grant_type: 'authorization_code', client_id: reg.body.client_id, code, redirect_uri: returnUri, code_verifier: verifier });
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${res.text}`);
  return res.body.access_token;
}
