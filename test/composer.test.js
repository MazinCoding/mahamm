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
  await q(`INSERT INTO labels (name_en, name_ar, color) VALUES ('Printer', 'طابعة', 'blue')`);
});
after(teardown);
beforeEach(resetLimits);

const send = (agent, title) => post(agent, '/tasks/mine', { title }, '/home');
const latest = async () => (await q('SELECT id, title, status, priority, creator_id FROM tasks ORDER BY id DESC LIMIT 1')).rows[0];
const assignees = async (id) => (await q('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
// The pop-up's request: JSON with the CSRF header, asking for no message on the next page.
async function popup(agent, body) {
  const token = await tokenFor(agent, '/home');
  return agent.post('/tasks/bulk').set('X-CSRF-Token', token).set('Accept', 'application/json').send({ back: '/home', quiet: true, ...body });
}

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
    assert.match(html, new RegExp(`<h2 id="added-title" tabindex="-1">Added #${task.id}</h2>`));
    assert.match(html, /value="status:progress" aria-pressed="true"/);
    assert.match(html, /value="priority:med" aria-pressed="true"/);
    assert.match(html, /value="label:\d+" aria-pressed="false">Printer/);
    assert.match(html, new RegExp(`name="back" value="/home\\?added=${task.id}"`));
    assert.match(html, /No due date/);
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

describe('details panel', () => {
  test('the pop-up saves each choice, gets its message back, and leaves no message for the next page', async () => {
    await send(aishaAgent, 'Order toner');
    const { id } = await latest();
    const label = (await q(`SELECT id FROM labels WHERE name_en = 'Printer'`)).rows[0].id;
    const high = await popup(aishaAgent, { ids: [id], apply: 'priority:high' });
    assert.equal(high.status, 200);
    assert.equal(high.body.message, 'Tasks updated: 1.');
    const lab = await popup(aishaAgent, { ids: [id], apply: `label:${label}` });
    assert.match(lab.body.message, /Label added: Printer\./);
    const who = await popup(aishaAgent, { ids: [id], apply: 'assignee', assignee: said.id });
    assert.match(who.body.message, /Assigned: Said Al-Rawahi\./);
    const due = await popup(aishaAgent, { ids: [id], apply: 'due', due: '2026-12-15' });
    assert.equal(due.status, 200);
    const moved = await popup(aishaAgent, { ids: [id], apply: 'status:review' });
    assert.equal(moved.body.message, `#${id} moved to Review.`);
    const row = (await q('SELECT priority, due_date, status FROM tasks WHERE id = $1', [id])).rows[0];
    assert.deepEqual([row.priority, row.due_date, row.status], ['high', '2026-12-15', 'review']);
    assert.deepEqual((await assignees(id)).sort(), [aisha.id, said.id].sort());
    const actions = (await auditFor(id)).map((e) => e.action);
    assert.deepEqual(actions, ['task.created', 'task.edited', 'task.edited', 'task.edited', 'task.edited', 'task.moved']);
    assert.doesNotMatch((await aishaAgent.get('/home')).text, /class="flash/, 'no leftover message');
    const done = await popup(aishaAgent, { ids: [id], apply: 'close' });
    assert.equal(done.body.redirect, `/table/close?ids=${id}&back=%2Fhome`);
  });

  test('without JavaScript the panel buttons are forms that come back to the panel', async () => {
    await send(aishaAgent, 'Book the meeting room');
    const { id } = await latest();
    const res = await post(aishaAgent, '/tasks/bulk', { ids: String(id), apply: 'priority:low', back: `/home?added=${id}` }, '/home');
    assert.equal(res.headers.location, `/home?added=${id}`);
    const html = (await aishaAgent.get(res.headers.location)).text;
    assert.match(html, /Tasks updated: 1\./);
    assert.match(html, /value="priority:low" aria-pressed="true"/);
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
  });

  test('the pop-up follows the usual edit rules: no details on someone else\'s task', async () => {
    const theirs = await makeTask(saidAgent, { title: 'Said keeps this one', status: 'todo' });
    const res = await popup(aishaAgent, { ids: [theirs], apply: 'priority:high' });
    assert.match(res.body.message, /Skipped because you can’t edit them/);
    assert.equal((await q('SELECT priority FROM tasks WHERE id = $1', [theirs])).rows[0].priority, 'med');
  });

  test('composer and panel in Arabic', async () => {
    await post(saidAgent, '/lang', { lang: 'ar', next: '/home' }, '/home');
    await send(saidAgent, 'تغيير فلتر الماء');
    const { id } = await latest();
    const html = (await saidAgent.get(`/home?added=${id}`)).text;
    assert.match(html, /placeholder="على ماذا تعمل الآن؟"/);
    assert.match(html, new RegExp(`أُضيفت #${id}`));
    assert.match(html, /<p class="added-task" dir="auto">تغيير فلتر الماء<\/p>/);
    assert.match(html, /<input id="composer-title" class="composer-input" name="title" maxlength="200" dir="auto"/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/home' }, '/home');
  });
});
