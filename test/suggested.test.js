import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { auditFor, createUser, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

let app;
let admin; let aisha; let said;
let adminAgent; let aishaAgent; let saidAgent;
const ids = {};

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const moveTo = (id, status) => post(adminAgent, '/tasks/bulk', { ids: String(id), apply: `status:${status}`, back: '/table' }, '/table');
const join = (agent, id, back = '/home') => post(agent, `/tasks/${id}/join`, { back }, '/home');
const assignees = async (id) => (await q('SELECT user_id FROM task_assignees WHERE task_id = $1 ORDER BY user_id', [id])).rows.map((r) => r.user_id);

before(async () => {
  ({ app } = await setup());
  admin = await createUser({ role: 'admin', name: 'Ahmed Al-Balushi', twoFactor: true });
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  said = await createUser({ name: 'Said Al-Rawahi' });
  adminAgent = await signIn(app, admin);
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);

  // Created in this order, so "oldest first" can be checked too.
  ids.highOthers = await makeTask(adminAgent, { title: 'S high, Said on it', priority: 'high', status: 'todo', assignees: [said.id] });
  ids.highOld = await makeTask(adminAgent, { title: 'S high, nobody, older', priority: 'high', status: 'todo' });
  ids.highNew = await makeTask(adminAgent, { title: 'S high, nobody, newer', priority: 'high', status: 'todo' });
  ids.highDue = await makeTask(adminAgent, { title: 'S high, nobody, due soon', priority: 'high', status: 'todo', due_date: day(2) });
  ids.highBacklog = await makeTask(adminAgent, { title: 'S high, backlog', priority: 'high', status: 'backlog' });
  ids.medReview = await makeTask(adminAgent, { title: 'S med, Said reviewing', priority: 'med', status: 'todo', assignees: [said.id] });
  await moveTo(ids.medReview, 'review');
  ids.medTodo = await makeTask(adminAgent, { title: 'S med, nobody', priority: 'med', status: 'todo' });
  ids.lowMine = await makeTask(adminAgent, { title: 'S low, Aisha on it', priority: 'low', status: 'todo', assignees: [aisha.id] });
  ids.closed = await makeTask(adminAgent, { title: 'S high, closed', priority: 'high', status: 'todo' });
  await post(adminAgent, `/tasks/${ids.closed}/close`, { reason: 'notneeded', duplicate_of: '' }, `/tasks/${ids.closed}/close`);
});
after(teardown);
beforeEach(resetLimits);

describe('suggested tasks', () => {
  test('every open task I am not on: priority first, then others on it, unassigned, Backlog; then due date, then oldest', async () => {
    const html = (await aishaAgent.get('/suggested')).text;
    const order = [ids.highOthers, ids.highDue, ids.highOld, ids.highNew, ids.highBacklog, ids.medReview, ids.medTodo];
    const at = order.map((id) => html.indexOf(`data-task-id="${id}"`));
    assert.ok(at.every((i) => i > 0), `all listed: ${at}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the agreed order');
    assert.equal(html.indexOf(`data-task-id="${ids.lowMine}"`), -1, 'not tasks I am already on');
    assert.equal(html.indexOf(`data-task-id="${ids.closed}"`), -1, 'not closed tasks');
    assert.match(html, /Open tasks you&#39;re not on yet: 7\./);
  });

  test('Home shows the first five and links to the rest; who is on it is shown, or "Nobody yet"', async () => {
    const html = (await aishaAgent.get('/home')).text;
    const shown = html.match(/<li class="my-task suggest"/g) || [];
    assert.equal(shown.length, 5);
    assert.match(html, /<a class="link-sm" href="\/suggested">See all 7<\/a>/);
    assert.match(html, /<bdi>Said Al-Rawahi<\/bdi>/);
    assert.match(html, /Nobody yet/);
    assert.match(html, /action="\/tasks\/\d+\/join"/);
  });
});

describe('joining', () => {
  test('adds me as an assignee, is recorded, moves the task to My tasks, and can be undone', async () => {
    const res = await join(aishaAgent, ids.highOld);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/home');
    assert.deepEqual(await assignees(ids.highOld), [aisha.id]);
    const ev = (await auditFor(ids.highOld)).at(-1);
    assert.equal(ev.action, 'task.edited');
    assert.equal(ev.actor_id, aisha.id);
    assert.deepEqual(ev.details.changes, { assignees: { added: [aisha.id], removed: [] } });
    assert.ok(ev.details.batch);

    const home = (await aishaAgent.get('/home')).text;
    assert.match(home, new RegExp(`You joined #${ids.highOld}\\. It&#39;s in My tasks now\\.`));
    assert.match(home, /action="\/tasks\/bulk\/undo"/);
    const myList = home.slice(home.indexOf('id="mine-title"'));
    assert.match(myList, new RegExp(`data-task-id="${ids.highOld}"`), 'now in My tasks');
    assert.doesNotMatch(home.slice(0, home.indexOf('id="mine-title"')), new RegExp(`data-task-id="${ids.highOld}"`), 'gone from Suggested');

    await post(aishaAgent, '/tasks/bulk/undo', { batch: ev.details.batch, back: '/home' }, '/home');
    assert.deepEqual(await assignees(ids.highOld), []);
  });

  test('anyone can join a task others are already on; joining twice changes nothing', async () => {
    await join(aishaAgent, ids.highOthers);
    assert.deepEqual(await assignees(ids.highOthers), [aisha.id, said.id].sort());
    const before = (await auditFor(ids.highOthers)).length;
    await join(aishaAgent, ids.highOthers);
    assert.equal((await auditFor(ids.highOthers)).length, before);
    assert.match((await aishaAgent.get('/home')).text, new RegExp(`You&#39;re already on #${ids.highOthers}\\.`));
  });

  test('joining gives the same edit rights as any assignee', async () => {
    assert.equal((await saidAgent.get(`/tasks/${ids.medTodo}/edit`)).status, 403);
    await join(saidAgent, ids.medTodo);
    assert.equal((await saidAgent.get(`/tasks/${ids.medTodo}/edit`)).status, 200);
  });

  test('not allowed: a closed task, a missing task, no session, no CSRF token', async () => {
    const closed = await join(aishaAgent, ids.closed);
    assert.equal(closed.headers.location, '/home');
    assert.deepEqual(await assignees(ids.closed), []);
    assert.match((await aishaAgent.get('/home')).text, new RegExp(`#${ids.closed} is already closed`));
    assert.equal((await join(aishaAgent, 999999)).status, 404);
    const anon = await request(app).post(`/tasks/${ids.medTodo}/join`).type('form').send({ back: '/home' });
    assert.ok([401, 403].includes(anon.status));
    const noToken = await aishaAgent.post(`/tasks/${ids.medTodo}/join`).type('form').send({ back: '/home' });
    assert.equal(noToken.status, 403);
    assert.ok(!(await assignees(ids.medTodo)).includes(aisha.id));
  });

  test('returns to the suggested list when joined from there, and never anywhere else', async () => {
    assert.equal((await join(aishaAgent, ids.highNew, '/suggested?page=1')).headers.location, '/suggested?page=1');
    for (const back of ['https://evil.example/', '/people', '/suggested?page=1&x=2']) {
      assert.equal((await join(aishaAgent, ids.highBacklog, back)).headers.location, '/home', back);
    }
  });

  test('Suggested tasks in Arabic', async () => {
    const fresh = await createUser({ name: 'Fatma Al-Harthi' });
    const agent = await signIn(app, fresh);
    await post(agent, '/lang', { lang: 'ar', next: '/home' }, '/home');
    const html = (await agent.get('/home')).text;
    assert.match(html, /مهام مقترحة/);
    assert.match(html, /انضم/);
    assert.match(html, /لا أحد بعد/);
    assert.match(html, /<a class="my-title" dir="auto"/);
  });
});
