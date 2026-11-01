import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { auditFor, createUser, makeTask, post, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

let app;
let admin; let aisha; let said;
let adminAgent; let aishaAgent; let saidAgent;

before(async () => {
  ({ app } = await setup());
  admin = await createUser({ role: 'admin', name: 'Ahmed Al-Balushi', twoFactor: true });
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  said = await createUser({ name: 'Said Al-Rawahi' });
  adminAgent = await signIn(app, admin);
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);
});
after(teardown);
beforeEach(resetLimits);

const quick = (agent, body) => post(agent, '/tasks/quick', { back: '/table', ...body }, '/table');
const latest = async () => (await q('SELECT id, title, status, priority, creator_id FROM tasks ORDER BY id DESC LIMIT 1')).rows[0];
const setLimit = (agent, limit) => post(agent, '/board/wip-limit', { limit: String(limit) }, '/board');

describe('quick-add row', () => {
  test('adds a task with just a title, in To do and Medium, and records who', async () => {
    const res = await quick(aishaAgent, { title: '  Order printer toner  ', status: 'todo' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/table');
    const task = await latest();
    assert.deepEqual([task.title, task.status, task.priority, task.creator_id], ['Order printer toner', 'todo', 'med', aisha.id]);
    assert.equal((await auditFor(task.id))[0].action, 'task.created');
    const page = await aishaAgent.get('/table');
    assert.match(page.text, new RegExp(`Added #${task.id}\\.`));
    assert.match(page.text, /id="quick-title"[^>]* autofocus>/, 'the cursor goes back to the box for the next task');
  });

  test('starts in Backlog when the table is filtered to Backlog, and never anywhere else', async () => {
    const page = await aishaAgent.get('/table?status=backlog');
    assert.match(page.text, /name="status" value="backlog"/);
    await quick(aishaAgent, { title: 'Backlog idea', status: 'backlog' });
    assert.equal((await latest()).status, 'backlog');
    await quick(aishaAgent, { title: 'Sneaky review', status: 'review' });
    assert.equal((await latest()).status, 'todo');
  });

  test('refuses an empty or too-long title, and only returns to the table', async () => {
    const before = (await latest()).id;
    await quick(aishaAgent, { title: '   ' });
    assert.match((await aishaAgent.get('/table')).text, /Type a title first\./);
    await quick(aishaAgent, { title: 'x'.repeat(201) });
    assert.match((await aishaAgent.get('/table')).text, /Titles can be up to 200 characters\./);
    assert.equal((await latest()).id, before);
    const away = await quick(aishaAgent, { title: 'Going nowhere', back: 'https://evil.example/' });
    assert.equal(away.headers.location, '/table');
    const keep = await quick(aishaAgent, { title: 'Keeps filters', back: '/table?sort=due&dir=asc' });
    assert.equal(keep.headers.location, '/table?sort=due&dir=asc');
  });

  test('needs a session and a CSRF token', async () => {
    const before = (await latest()).id;
    const anon = await request(app).post('/tasks/quick').type('form').send({ title: 'Anonymous' });
    assert.ok([401, 403].includes(anon.status));
    const noToken = await aishaAgent.post('/tasks/quick').type('form').send({ title: 'No token' });
    assert.equal(noToken.status, 403);
    assert.equal((await latest()).id, before);
  });

  test('the quick-add row is in Arabic too, and shows on an empty table', async () => {
    await post(saidAgent, '/lang', { lang: 'ar', next: '/table' });
    const page = await saidAgent.get('/table?q=nothing-matches-this');
    assert.match(page.text, /أضف مهمة: اكتب العنوان واضغط Enter/);
    assert.match(page.text, /id="quick-add"/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/table' });
  });
});

describe('in-progress limit', () => {
  test('only admins can change it; the change is audited', async () => {
    const member = await setLimit(aishaAgent, 2);
    assert.equal(member.status, 403);
    assert.match((await aishaAgent.get('/board')).text, /\d+ \/ 5</, 'members keep the default');
    assert.doesNotMatch((await aishaAgent.get('/board')).text, /action="\/board\/wip-limit"/, 'members see no form');

    const res = await setLimit(adminAgent, 3);
    assert.equal(res.headers.location, '/board');
    const board = await adminAgent.get('/board');
    assert.match(board.text, /In-progress limit set to 3\./);
    assert.match(board.text, /name="limit" min="1" max="50" step="1" value="3"/);
    const ev = (await q(`SELECT actor_id, details FROM audit_events WHERE action = 'settings.wip_limit_changed' ORDER BY id`)).rows;
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].actor_id, ev[0].details], [admin.id, { from: 5, to: 3 }]);
    assert.match((await adminAgent.get('/audit')).text, /changed the in-progress limit from 5 to 3/);

    await setLimit(adminAgent, 3);
    assert.match((await adminAgent.get('/board')).text, /Nothing changed\./);
    for (const bad of ['0', '51', '2.5', 'abc', '']) {
      await setLimit(adminAgent, bad);
      assert.match((await adminAgent.get('/board')).text, /The limit must be a whole number from 1 to 50\./, bad);
    }
    assert.equal((await q(`SELECT value FROM app_settings WHERE key = 'wip_limit'`)).rows[0].value, 3);
  });

  test('going over the limit warns but never blocks', async () => {
    await setLimit(adminAgent, 1);
    const a = await makeTask(aishaAgent, { title: 'Over one' });
    const b = await makeTask(aishaAgent, { title: 'Over two' });
    const token = await tokenFor(saidAgent, '/table');
    const res = await saidAgent.post('/tasks/bulk').set('X-CSRF-Token', token).set('Accept', 'application/json')
      .send({ ids: [a, b], apply: 'status:progress' });
    assert.deepEqual(res.body.updated, [a, b], 'the moves still happen');
    const count = (await q(`SELECT count(*)::int AS n FROM tasks WHERE closed_at IS NULL AND status = 'progress'`)).rows[0].n;
    const table = await saidAgent.get('/table');
    assert.match(table.text, new RegExp(`In progress is now over the limit \\(${count} / 1\\)\\.`));
    assert.match(table.text, new RegExp(`class="wip-count is-over">In progress: ${count} / 1<`));
    assert.match((await saidAgent.get('/board')).text, new RegExp(`stat-value is-bad">${count} / 1<`));
  });
});
