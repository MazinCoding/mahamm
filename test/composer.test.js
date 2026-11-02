import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { auditFor, createUser, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

let app; let config;
let admin; let aisha; let said;
let adminAgent; let aishaAgent; let saidAgent;

before(async () => {
  ({ app, config } = await setup());
  admin = await createUser({ role: 'admin', name: 'Ahmed Al-Balushi', twoFactor: true });
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  said = await createUser({ name: 'Said Al-Rawahi' });
  adminAgent = await signIn(app, admin);
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);
  await q(`INSERT INTO labels (name_en, name_ar, color) VALUES ('Printer', 'طابعة', 'blue')`);
});
after(teardown);
beforeEach(resetLimits);

const send = (agent, title) => post(agent, '/tasks/mine', { title }, '/home');
const latest = async () => (await q('SELECT id, title, status, priority, creator_id FROM tasks ORDER BY id DESC LIMIT 1')).rows[0];
const assignees = async (id) => (await q('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
const label = async () => (await q(`SELECT id FROM labels WHERE name_en = 'Printer'`)).rows[0].id;
const task = async (id) => (await q('SELECT status, priority, due_date FROM tasks WHERE id = $1', [id])).rows[0];
// The details form exactly as the sheet sends it, with nothing changed unless overridden.
const details = (agent, id, fields = {}) => post(agent, `/tasks/${id}/details`, {
  status: 'progress', priority: 'med', due_when: 'none', due_date: '', add_assignee: '', assignees: aisha.id, ...fields,
}, `/home?added=${id}`);
const dayIn = (n) => {
  const d = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('composer', () => {
  test('the title is enough: In progress, Medium, assigned to me, recorded, then the details panel', async () => {
    const res = await send(aishaAgent, '  Fix the printer on floor 2  ');
    const task = await latest();
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/home?added=${task.id}`);
    assert.deepEqual([task.title, task.status, task.priority, task.creator_id], ['Fix the printer on floor 2', 'progress', 'med', aisha.id]);
    assert.deepEqual(await assignees(task.id), [aisha.id]);
    assert.equal((await auditFor(task.id))[0].action, 'task.created');
    const notes = await q('SELECT count(*)::int AS n FROM notifications WHERE task_id = $1', [task.id]);
    assert.equal(notes.rows[0].n, 0, 'nobody is told about their own task');

    const html = (await aishaAgent.get(res.headers.location)).text;
    assert.match(html, new RegExp(`Added #${task.id} to your tasks, In progress\\.`));
    assert.match(html, /data-added-panel/);
    assert.match(html, new RegExp(`<form class="added-form" method="post" action="/tasks/${task.id}/details">`));
    assert.match(html, new RegExp(`<h2 id="added-title" tabindex="-1">Add details to #${task.id}</h2>`));
    assert.match(html, /name="status" value="progress" checked>/);
    assert.match(html, /name="priority" value="med" checked>/);
    assert.match(html, /name="labels" value="\d+"><span>Printer<\/span>/, 'labels start unticked');
    assert.match(html, new RegExp(`name="assignees" value="${aisha.id}" checked>`), 'I am on it already');
    assert.match(html, /name="due_when" value="none" checked>/);
    assert.match(html, /<a class="btn btn-secondary" href="\/home" data-later>Add details later<\/a>/);
    assert.match(html, /<button class="btn btn-primary" type="submit">Submit details<\/button>/);
    const mine = html.slice(html.indexOf('id="mine-title"'));
    assert.match(mine, /Fix the printer on floor 2/, 'already in My tasks');
  });

  test('refuses an empty or too-long title, and keeps what was typed in the box', async () => {
    const before = (await latest()).id;
    const empty = await send(aishaAgent, '   ');
    assert.equal(empty.headers.location, '/home');
    let html = (await aishaAgent.get('/home')).text;
    assert.match(html, /Type a title first\./);
    const long = 'x'.repeat(205);
    await send(aishaAgent, long);
    html = (await aishaAgent.get('/home')).text;
    assert.match(html, /Titles can be up to 200 characters\./);
    assert.match(html, new RegExp(`id="composer-title"[^>]* value="${long}"`), 'the text stays');
    assert.equal((await latest()).id, before);
    assert.doesNotMatch((await aishaAgent.get('/home')).text, /value="xxxx/, 'only kept for the next page');
  });

  test('warns, but still adds, when In progress goes over the limit', async () => {
    await post(adminAgent, '/board/wip-limit', { limit: '1' }, '/board');
    await send(saidAgent, 'One more thing in progress');
    const html = (await saidAgent.get(`/home?added=${(await latest()).id}`)).text;
    assert.match(html, /In progress is now over the limit/);
    assert.match(html, /class="flash flash-warn"/);
    await post(adminAgent, '/board/wip-limit', { limit: '5' }, '/board');
  });

  test('needs a session and a CSRF token', async () => {
    const before = (await latest()).id;
    const anon = await request(app).post('/tasks/mine').type('form').send({ title: 'Anonymous' });
    assert.ok([401, 403].includes(anon.status));
    const noToken = await aishaAgent.post('/tasks/mine').type('form').send({ title: 'No token' });
    assert.equal(noToken.status, 403);
    assert.equal((await latest()).id, before);
  });
});

describe('details sheet', () => {
  test('nothing is saved until Submit details; then everything is saved at once, with one Undo', async () => {
    await send(aishaAgent, 'Order toner');
    const { id } = await latest();
    const res = await details(aishaAgent, id, {
      status: 'review', priority: 'high', labels: String(await label()), add_assignee: said.id, due_when: 'tomorrow',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/home');
    const row = await task(id);
    assert.deepEqual([row.status, row.priority, row.due_date], ['review', 'high', dayIn(1)]);
    assert.deepEqual((await assignees(id)).sort(), [aisha.id, said.id].sort());
    assert.equal((await q('SELECT count(*)::int AS n FROM task_labels WHERE task_id = $1', [id])).rows[0].n, 1);

    const events = (await auditFor(id)).slice(1);
    assert.deepEqual(events.map((e) => e.action), ['task.moved', 'task.edited']);
    assert.equal(events[0].details.batch, events[1].details.batch, 'one batch for Undo');
    assert.deepEqual(Object.keys(events[1].details.changes).sort(), ['assignees', 'due_date', 'labels', 'priority']);
    const assigned = await q(`SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2`, [said.id, id]);
    assert.deepEqual(assigned.rows.map((r) => r.kind), ['assigned']);

    const home = (await aishaAgent.get('/home')).text;
    assert.match(home, new RegExp(`Details saved for #${id}\\.`));
    assert.match(home, /action="\/tasks\/bulk\/undo"/);
    await post(aishaAgent, '/tasks/bulk/undo', { batch: events[0].details.batch, back: '/home' }, '/home');
    const back = await task(id);
    assert.deepEqual([back.status, back.priority, back.due_date], ['progress', 'med', null]);
    assert.deepEqual(await assignees(id), [aisha.id]);
  });

  test('Today and a picked date; no date when "On a date" has none; nothing changed says so', async () => {
    await send(aishaAgent, 'Book the meeting room');
    const { id } = await latest();
    await details(aishaAgent, id, { due_when: 'today' });
    assert.equal((await task(id)).due_date, dayIn(0));
    await details(aishaAgent, id, { due_when: 'date', due_date: '2026-12-15' });
    assert.equal((await task(id)).due_date, '2026-12-15');
    const missing = await details(aishaAgent, id, { due_when: 'date', due_date: '' });
    assert.equal(missing.headers.location, `/home?added=${id}`, 'back to the sheet');
    assert.match((await aishaAgent.get(missing.headers.location)).text, /Pick a date first/);
    assert.equal((await task(id)).due_date, '2026-12-15');
    await details(aishaAgent, id, { due_when: 'date', due_date: '2026-12-15' });
    assert.match((await aishaAgent.get('/home')).text, /Nothing changed\./);
  });

  test('Done saves the details, then asks who did it on the close page', async () => {
    await send(aishaAgent, 'Already fixed the kettle');
    const { id } = await latest();
    const res = await details(aishaAgent, id, { status: 'done', priority: 'low' });
    assert.equal(res.headers.location, `/table/close?ids=${id}&back=%2Fhome`);
    const row = await task(id);
    assert.deepEqual([row.status, row.priority], ['progress', 'low'], 'not closed until the close page');
    assert.equal((await q('SELECT closed_at FROM tasks WHERE id = $1', [id])).rows[0].closed_at, null);
  });

  test('only for an open task I created: not for other people\'s tasks, closed tasks or nonsense', async () => {
    const theirs = await makeTask(saidAgent, { title: 'Said made this', status: 'todo', assignees: [aisha.id] });
    for (const added of [String(theirs), 'abc', '999999', '-1']) {
      const res = await aishaAgent.get(`/home?added=${added}`);
      assert.equal(res.status, 200, added);
      assert.doesNotMatch(res.text, /data-added-panel/, added);
    }
    await send(aishaAgent, 'Close me straight away');
    const { id } = await latest();
    await post(aishaAgent, '/tasks/bulk/close', { ids: String(id), reason: 'completed', credit: '', back: '/home' }, `/table/close?ids=${id}&back=%2Fhome`);
    assert.doesNotMatch((await aishaAgent.get(`/home?added=${id}`)).text, /data-added-panel/);
    const late = await details(aishaAgent, id, { priority: 'high' });
    assert.equal(late.headers.location, '/home');
    assert.match((await aishaAgent.get('/home')).text, new RegExp(`#${id} is already closed`));
  });

  test('not allowed: someone else\'s task, bad values, no session, no CSRF token', async () => {
    const theirs = await makeTask(saidAgent, { title: 'Said keeps this one', status: 'todo' });
    const res = await details(aishaAgent, theirs, { priority: 'high' });
    assert.equal(res.status, 403);
    assert.equal((await task(theirs)).priority, 'med');

    await send(aishaAgent, 'Check bad values');
    const { id } = await latest();
    for (const bad of [{ status: 'closed' }, { priority: 'urgent' }, { due_when: 'someday' }, { due_when: 'date', due_date: '2026-02-30' }, { add_assignee: 'not-a-person' }]) {
      const r = await details(aishaAgent, id, bad);
      assert.equal(r.headers.location, `/home?added=${id}`, JSON.stringify(bad));
    }
    assert.deepEqual((await auditFor(id)).map((e) => e.action), ['task.created'], 'nothing saved');
    const anon = await request(app).post(`/tasks/${id}/details`).type('form').send({ status: 'review', priority: 'high', due_when: 'none' });
    assert.ok([401, 403].includes(anon.status));
    const noToken = await aishaAgent.post(`/tasks/${id}/details`).type('form').send({ status: 'review', priority: 'high', due_when: 'none' });
    assert.equal(noToken.status, 403);
    assert.equal((await task(id)).status, 'progress');
  });

  test('composer and sheet in Arabic', async () => {
    await post(saidAgent, '/lang', { lang: 'ar', next: '/home' }, '/home');
    await send(saidAgent, 'تغيير فلتر الماء');
    const { id } = await latest();
    const html = (await saidAgent.get(`/home?added=${id}`)).text;
    assert.match(html, /placeholder="على ماذا تعمل الآن؟"/);
    assert.match(html, new RegExp(`أضف تفاصيل إلى #${id}`));
    assert.match(html, /أضف التفاصيل لاحقًا/);
    assert.match(html, /إرسال التفاصيل/);
    assert.match(html, /<p class="added-task" dir="auto">تغيير فلتر الماء<\/p>/);
    assert.match(html, /<input id="composer-title" class="composer-input" name="title" maxlength="200" dir="auto"/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/home' }, '/home');
  });
});
