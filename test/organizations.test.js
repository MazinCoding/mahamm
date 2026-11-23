import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q as appQuery, withOrg } from '../src/db.js';
import { ORG1, connectApp, createUser, makeTask, post, q, resetLimits, setup, signIn, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
const ORG2 = '00000000-0000-4000-8000-000000000002';
// Tables that are shared by the whole app on purpose. Every other table must
// belong to an organization.
const GLOBAL_TABLES = ['organizations', 'rate_limits', 'oauth_clients', 'session', 'schema_migrations', 'platform_admins', 'platform_audit'];

let app;
let ownerA; let memberA; let agentA;
let ownerB; let memberB; let agentB;
let taskA;

before(async () => {
  ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN }));
  await q(`INSERT INTO organizations (id, name) VALUES ($1, 'Second Org')`, [ORG2]);
  await q(`INSERT INTO labels (org_id, name_en, name_ar, color) VALUES ($1, 'Only In B', 'فقط ب', 'green')`, [ORG2]);
  ownerA = await createUser({ name: 'Alpha Owner', role: 'superadmin', twoFactor: true });
  memberA = await createUser({ name: 'Alpha Member' });
  ownerB = await createUser({ name: 'Bravo Owner', role: 'superadmin', twoFactor: true, org: ORG2 });
  memberB = await createUser({ name: 'Bravo Member', org: ORG2 });
  agentA = await signIn(app, ownerA);
  agentB = await signIn(app, ownerB);
  taskA = await makeTask(agentA, { title: 'Alpha secret plan', assignees: [memberA.id] });
});
after(teardown);
beforeEach(resetLimits);

describe('the database itself', () => {
  test('every company table has org_id and forced row-level security with a policy', async () => {
    const { rows } = await q(`
      SELECT c.relname AS name, c.relrowsecurity AND c.relforcerowsecurity AS rls,
        EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'org_id') AS has_org,
        EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS has_policy
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const missing = rows
      .filter((r) => !GLOBAL_TABLES.includes(r.name))
      .filter((r) => !r.has_org || !r.rls || !r.has_policy)
      .map((r) => r.name);
    assert.deepEqual(missing, [], `tables without organization protection: ${missing.join(', ')}`);
  });

  test('with no organization set, company tables show nothing (fails closed)', async () => {
    const all = (await q('SELECT count(*)::int AS n FROM tasks')).rows[0].n;
    assert.ok(all > 0);
    const none = (await appQuery('SELECT count(*)::int AS n FROM tasks')).rows[0].n;
    assert.equal(none, 0);
  });

  test('inside one organization, only its rows are visible', async () => {
    const seen = await withOrg(ORG2, () => appQuery('SELECT name FROM users ORDER BY name'));
    assert.deepEqual(seen.rows.map((r) => r.name), ['Bravo Member', 'Bravo Owner']);
  });

  test('rows can only link to rows of the same organization', async () => {
    await assert.rejects(q('INSERT INTO task_assignees (org_id, task_id, user_id) VALUES ($1, $2, $3)', [ORG2, taskA, memberB.id]));
    await assert.rejects(q('INSERT INTO task_assignees (org_id, task_id, user_id) VALUES ($1, $2, $3)', [ORG1, taskA, memberB.id]));
  });

  test('an organization cannot write rows into another', async () => {
    await assert.rejects(withOrg(ORG2, () => appQuery(
      `INSERT INTO labels (org_id, name_en, name_ar, color) VALUES ($1, 'Sneaky', 'خلسة', 'red')`, [ORG1],
    )));
  });
});

describe('the website keeps organizations apart', () => {
  test('pages of one organization never show the other', async () => {
    for (const path of ['/board', '/tasks', '/table', '/home', '/suggested', '/people', '/audit']) {
      const res = await agentB.get(path);
      assert.equal(res.status, 200, path);
      assert.doesNotMatch(res.text, /Alpha secret plan|Alpha Member|Alpha Owner/, path);
    }
    const people = await agentB.get('/people');
    assert.match(people.text, /Bravo Member/);
    const a = await agentA.get('/board');
    assert.match(a.text, /Alpha secret plan/);
    assert.doesNotMatch(a.text, /Bravo/);
  });

  test('another organization\'s task is not found, and crafted ids change nothing', async () => {
    assert.equal((await agentB.get(`/tasks/${taskA}`)).status, 404);
    assert.equal((await agentB.get(`/tasks/${taskA}/edit`)).status, 404);
    const comment = await post(agentB, `/tasks/${taskA}/comments`, { body: 'Hello from B' });
    assert.ok([403, 404].includes(comment.status), String(comment.status));
    await post(agentB, '/tasks/bulk', { ids: [taskA], apply: 'status:progress', back: '/table' }, '/table');
    await post(agentB, `/tasks/${taskA}/join`, {}, '/home');
    const row = (await q('SELECT status FROM tasks WHERE org_id = $1 AND id = $2', [ORG1, taskA])).rows[0];
    assert.equal(row.status, 'todo');
    assert.equal((await q('SELECT count(*)::int AS n FROM comments WHERE org_id = $1 AND task_id = $2', [ORG1, taskA])).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM task_assignees WHERE task_id = $1 AND user_id = $2', [taskA, ownerB.id])).rows[0].n, 0);
  });

  test('people of another organization can\'t be assigned', async () => {
    const id = await makeTask(agentB, { title: 'Bravo task', assignees: [memberB.id, memberA.id] });
    const people = (await q('SELECT user_id FROM task_assignees WHERE org_id = $1 AND task_id = $2', [ORG2, id])).rows.map((r) => r.user_id);
    assert.deepEqual(people, [memberB.id]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM audit_events WHERE org_id = $1 AND task_id = $2 AND action = 'task.created'`, [ORG2, id])).rows[0].n, 1);
  });

  test('each company numbers its tasks from #1, and #N always means your own', async () => {
    const bFirst = (await q(`SELECT min(id)::int AS n FROM tasks WHERE org_id = $1`, [ORG2])).rows[0].n;
    assert.equal(bFirst, 1);
    assert.equal(taskA, 1, 'the first company also started at #1');
    const second = await makeTask(agentA, { title: 'Alpha second' });
    assert.equal(second, 2);
    const asB = await agentB.get('/tasks/1');
    assert.equal(asB.status, 200);
    assert.match(asB.text, /Bravo task/);
    assert.doesNotMatch(asB.text, /Alpha secret plan/);
    const asA = await agentA.get('/tasks/1');
    assert.match(asA.text, /Alpha secret plan/);
    assert.doesNotMatch(asA.text, /Bravo task/);
    // Changing your #1 doesn't touch the other company's #1.
    await post(agentB, '/tasks/bulk', { ids: [1], apply: 'status:progress', back: '/table' }, '/table');
    const statuses = (await q('SELECT org_id, status FROM tasks WHERE id = 1 ORDER BY org_id')).rows;
    assert.deepEqual(statuses.map((r) => [r.org_id, r.status]), [[ORG1, 'todo'], [ORG2, 'progress']]);
  });

  test('two tasks added at the same moment get different numbers', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5].map((n) => makeTask(agentB, { title: `Same moment ${n}` })));
    assert.equal(new Set(ids).size, 5);
  });

  test('settings belong to each organization', async () => {
    await post(agentB, '/board/wip-limit', { limit: '9' }, '/board');
    const rows = (await q(`SELECT org_id, value FROM app_settings WHERE key = 'wip_limit' ORDER BY org_id`)).rows;
    assert.deepEqual(rows.map((r) => [r.org_id, Number(r.value)]), [[ORG2, 9]]);
  });

  test('an email that has an account in another organization can\'t be invited', async () => {
    const res = await post(agentB, '/people/invite', { email: memberA.email, role: 'member' }, '/people');
    assert.equal(res.status, 302);
    assert.equal((await q('SELECT count(*)::int AS n FROM invites WHERE email = $1', [memberA.email])).rows[0].n, 0);
  });

  test('the owner of one organization manages only its own people', async () => {
    await post(agentB, `/people/${memberA.id}/role`, { role: 'trainee' }, '/people');
    await post(agentB, `/people/${memberA.id}/status`, { status: 'disabled' }, '/people');
    const a = (await q('SELECT role, status FROM users WHERE id = $1', [memberA.id])).rows[0];
    assert.deepEqual(a, { role: 'member', status: 'active' });
  });

  test('both owners are "Owner", in English and Arabic', async () => {
    const page = await agentB.get('/settings');
    assert.match(page.text, /Your level: Owner/);
    await post(agentB, '/lang', { lang: 'ar' }, '/board');
    assert.match((await agentB.get('/settings')).text, /مستواك: المالك/);
    await post(agentB, '/lang', { lang: 'en' }, '/board');
  });
});

describe('the connector keeps organizations apart', () => {
  test('a connected app works only in its account\'s organization', async () => {
    const token = await connectApp(app, memberB, RETURN);
    const call = async (name, args) => (await request(app).post('/connector').set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
    const other = await call('get_task', { task_id: taskA });
    assert.equal(other.isError, true);
    const team = await call('get_team', {});
    const text = JSON.stringify(team);
    assert.doesNotMatch(text, /Alpha/);
    assert.match(text, /Bravo Member/);
    const grant = (await q('SELECT org_id FROM oauth_grants WHERE user_id = $1', [memberB.id])).rows[0];
    assert.equal(grant.org_id, ORG2);
  });
});
