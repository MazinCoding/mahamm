import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { PASSWORD, auditFor, createUser, csrfIn, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

let app;
let admin; let aisha; let said;
let adminAgent; let aishaAgent; let saidAgent;

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

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

const fromHome = (agent, body) => post(agent, '/tasks/bulk', { back: '/home', ...body }, '/home');
// New tasks start in Backlog or To do; move them on through the table like anyone would.
const moveTo = (id, status) => post(adminAgent, '/tasks/bulk', { ids: String(id), apply: `status:${status}`, back: '/table' }, '/table');

describe('start page', () => {
  test('signing in lands on Home, and the site root goes there too', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: said.email, password: PASSWORD });
    assert.equal(res.headers.location, '/home');
    assert.equal((await agent.get('/')).headers.location, '/home');
    assert.equal((await agent.get('/login')).headers.location, '/home');
  });

  test('Home and the menu need a session', async () => {
    const home = await request(app).get('/home');
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/login?next=%2Fhome');
    assert.equal((await request(app).get('/mahamm')).status, 302);
    assert.equal((await request(app).get('/')).headers.location, '/login');
  });
});

describe('My tasks', () => {
  test('shows only my open tasks, what I am doing now first', async () => {
    await makeTask(adminAgent, { title: 'Aisha todo task', status: 'todo', assignees: [aisha.id] });
    await moveTo(await makeTask(adminAgent, { title: 'Aisha doing task', status: 'todo', assignees: [aisha.id] }), 'progress');
    await moveTo(await makeTask(adminAgent, { title: 'Said only task', status: 'todo', assignees: [said.id] }), 'progress');
    const closed = await makeTask(adminAgent, { title: 'Aisha closed task', status: 'todo', assignees: [aisha.id] });
    await post(adminAgent, `/tasks/${closed}/close`, { reason: 'completed', credited: aisha.id, duplicate_of: '' }, `/tasks/${closed}/close`);
    await makeTask(aishaAgent, { title: 'Created but not assigned', status: 'todo' });

    const html = (await aishaAgent.get('/home')).text;
    assert.match(html, /Hello, <bdi>Aisha<\/bdi>/);
    assert.match(html, /Aisha todo task/);
    assert.match(html, /Aisha doing task/);
    assert.doesNotMatch(html, /Said only task/);
    assert.doesNotMatch(html, /Aisha closed task/);
    assert.doesNotMatch(html, /Created but not assigned/, 'Home lists tasks I am assigned to');
    assert.ok(html.indexOf('Aisha doing task') < html.indexOf('Aisha todo task'), 'In progress comes before To do');
  });

  test('says when a due date is missing, and counts what is overdue', async () => {
    await makeTask(adminAgent, { title: 'Late one', status: 'todo', due_date: day(-3), assignees: [said.id] });
    await makeTask(adminAgent, { title: 'Undated one', status: 'todo', assignees: [said.id] });
    const html = (await saidAgent.get('/home')).text;
    assert.match(html, /Overdue · /);
    assert.match(html, /No due date/);
    assert.match(html, /1 overdue/);
  });

  test('a new person sees an explicit empty state', async () => {
    const fresh = await createUser({ name: 'Fatma Al-Harthi' });
    const html = (await (await signIn(app, fresh)).get('/home')).text;
    assert.match(html, /Nothing is assigned to you right now\./);
  });

  test('moving a task from Home returns to Home, is recorded, can be undone, and notifies for review', async () => {
    const id = await makeTask(adminAgent, { title: 'Move me from home', status: 'todo', assignees: [aisha.id] });
    const res = await fromHome(aishaAgent, { ids: String(id), apply: 'status:review' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/home');
    assert.equal((await q('SELECT status FROM tasks WHERE id = $1', [id])).rows[0].status, 'review');
    const moved = (await auditFor(id)).find((e) => e.action === 'task.moved');
    assert.deepEqual([moved.actor_id, moved.details.from, moved.details.to], [aisha.id, 'todo', 'review']);
    const note = await q(`SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2`, [admin.id, id]);
    assert.deepEqual(note.rows.map((r) => r.kind), ['review']);
    const page = await aishaAgent.get('/home');
    assert.match(page.text, new RegExp(`#${id} moved to Review\\.`));
    assert.match(page.text, /action="\/tasks\/bulk\/undo"/);
    assert.match(page.text, /name="back" value="\/home"/);
  });

  test('Done… goes through the close page and comes back to Home', async () => {
    const id = await makeTask(adminAgent, { title: 'Finish me from home', status: 'todo', assignees: [aisha.id] });
    await moveTo(id, 'progress');
    const res = await fromHome(aishaAgent, { ids: String(id), apply: 'close' });
    assert.equal(res.headers.location, `/table/close?ids=${id}&back=%2Fhome`);
    const page = await aishaAgent.get(res.headers.location);
    assert.match(page.text, /<a class="back" href="\/home">/);
    const done = await post(aishaAgent, '/tasks/bulk/close', { ids: String(id), reason: 'completed', credit: '', back: '/home' }, res.headers.location);
    assert.equal(done.headers.location, '/home');
    const task = (await q('SELECT closed_by, close_reason FROM tasks WHERE id = $1', [id])).rows[0];
    assert.deepEqual([task.closed_by, task.close_reason], [aisha.id, 'completed']);
    const credits = (await q('SELECT user_id FROM task_credits WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    assert.deepEqual(credits, [aisha.id]);
  });

  test('only Home and the table are allowed as return pages', async () => {
    const id = await makeTask(adminAgent, { title: 'Return page check', status: 'todo', assignees: [aisha.id] });
    for (const back of ['https://evil.example/', '//evil.example/home', '/home/../people', '/homepage', '/board']) {
      const res = await fromHome(aishaAgent, { ids: String(id), apply: 'status:todo', back });
      assert.equal(res.headers.location, '/table', `back=${back}`);
    }
  });

  test('the status menu needs a session and a CSRF token', async () => {
    const id = await makeTask(adminAgent, { title: 'Guarded move', status: 'todo', assignees: [aisha.id] });
    const anon = await request(app).post('/tasks/bulk').type('form').send({ ids: String(id), apply: 'status:review', back: '/home' });
    assert.ok([401, 403].includes(anon.status));
    const noToken = await aishaAgent.post('/tasks/bulk').type('form').send({ ids: String(id), apply: 'status:review', back: '/home' });
    assert.equal(noToken.status, 403);
    assert.equal((await q('SELECT status FROM tasks WHERE id = $1', [id])).rows[0].status, 'todo');
  });
});

describe('menu and bottom bar', () => {
  test('the menu lists every view; admin tools only for admins', async () => {
    const member = (await aishaAgent.get('/mahamm')).text;
    for (const href of ['/board', '/tasks', '/table', '/tasks/new', '/audit', '/notifications', '/settings']) {
      assert.match(member, new RegExp(`class="menu-item" href="${href}"`), href);
    }
    assert.match(member, /action="\/logout"/);
    for (const href of ['/people', '/labels', '/import']) assert.doesNotMatch(member, new RegExp(`class="menu-item" href="${href}"`), href);
    const adminPage = (await adminAgent.get('/mahamm')).text;
    for (const href of ['/people', '/labels', '/import']) assert.match(adminPage, new RegExp(`class="menu-item" href="${href}"`), href);
  });

  test('every signed-in page has the two tabs; the sign-in page has none', async () => {
    const home = (await aishaAgent.get('/home')).text;
    assert.match(home, /<nav class="tabbar"/);
    assert.match(home, /class="tab-link is-active" href="\/home" aria-current="page"/);
    const board = (await aishaAgent.get('/board')).text;
    assert.match(board, /class="tab-link is-active" href="\/mahamm"/);
    assert.match((await aishaAgent.get('/mahamm')).text, /href="\/mahamm" aria-current="page"/);
    assert.doesNotMatch((await request(app).get('/login')).text, /tabbar/);
  });

  test('Home and the menu in Arabic', async () => {
    await post(saidAgent, '/lang', { lang: 'ar', next: '/home' }, '/home');
    const home = (await saidAgent.get('/home')).text;
    assert.match(home, /<html lang="ar" dir="rtl">/);
    assert.match(home, /مرحبًا، <bdi>Said<\/bdi>/);
    assert.match(home, /مهامي/);
    assert.match(home, /بلا تاريخ استحقاق/);
    assert.match(home, /<a class="my-title" dir="auto"/);
    const menu = (await saidAgent.get('/mahamm')).text;
    assert.match(menu, /كل طرق العرض والأدوات/);
    assert.match(menu, /الرئيسية/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/home' }, '/home');
  });
});

describe('add to home screen', () => {
  test('the manifest and icons are served, and every page links them', async () => {
    const res = await request(app).get('/manifest.webmanifest');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/manifest\+json/);
    assert.equal(res.headers['set-cookie'], undefined, 'no session for the manifest');
    const manifest = JSON.parse(res.text);
    assert.equal(manifest.start_url, '/home');
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
      const file = await request(app).get(icon.src);
      assert.equal(file.status, 200, icon.src);
      assert.equal(file.headers['content-type'], 'image/png');
    }
    assert.equal((await request(app).get('/static/icons/apple-touch-icon.png')).status, 200);
    for (const html of [(await request(app).get('/login')).text, (await aishaAgent.get('/home')).text]) {
      assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
      assert.match(html, /<link rel="apple-touch-icon" href="\/static\/icons\/apple-touch-icon.png">/);
      assert.match(html, /viewport-fit=cover/);
    }
  });
});
