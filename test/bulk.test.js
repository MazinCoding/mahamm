import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { auditFor, createUser, makeTask, post, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

let app;
let admin; let aisha; let said; let fatma;
let adminAgent; let aishaAgent; let saidAgent; let fatmaAgent;

before(async () => {
  ({ app } = await setup());
  admin = await createUser({ role: 'admin', name: 'Ahmed Al-Balushi', twoFactor: true });
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  said = await createUser({ name: 'Said Al-Rawahi' });
  fatma = await createUser({ name: 'Fatma Al-Harthi' });
  adminAgent = await signIn(app, admin);
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);
  fatmaAgent = await signIn(app, fatma);
});
after(teardown);
beforeEach(resetLimits);

// The page script's request: JSON with the CSRF header.
async function bulk(agent, body) {
  const token = await tokenFor(agent, '/table');
  return agent.post('/tasks/bulk').set('X-CSRF-Token', token).set('Accept', 'application/json').send(body);
}
const tasks = async (ids) => (await q(
  `SELECT id, status, priority, due_date::text AS due,
          ARRAY(SELECT label_id FROM task_labels WHERE task_id = t.id ORDER BY label_id) AS labels,
          ARRAY(SELECT user_id::text FROM task_assignees WHERE task_id = t.id ORDER BY user_id) AS people
   FROM tasks t WHERE id = ANY($1::int[]) ORDER BY id`, [ids],
)).rows;
const outbox = async (email) => (await q('SELECT subject, body_text FROM email_outbox WHERE to_email = $1 ORDER BY id', [email])).rows;

describe('applying values from the table ribbon', () => {
  test('anyone can change status; each task gets its own audit entry, sharing one batch id', async () => {
    const a = await makeTask(aishaAgent, { title: 'Status one' });
    const b = await makeTask(aishaAgent, { title: 'Status two' });
    const res = await bulk(saidAgent, { ids: [a, b], apply: 'status:progress' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, [a, b]);
    assert.deepEqual((await tasks([a, b])).map((t) => t.status), ['progress', 'progress']);
    const moves = [...await auditFor(a), ...await auditFor(b)].filter((e) => e.action === 'task.moved');
    assert.equal(moves.length, 2);
    assert.ok(moves.every((e) => e.actor_id === said.id && e.details.from === 'todo' && e.details.to === 'progress'));
    assert.equal(moves[0].details.batch, moves[1].details.batch);
    assert.match(moves[0].details.batch, /^[0-9a-f-]{36}$/);
  });

  test('other fields need edit rights: tasks you can\'t edit are skipped and listed', async () => {
    const mine = await makeTask(saidAgent, { title: 'Said made this' });
    const assigned = await makeTask(aishaAgent, { title: 'Said is assigned', assignees: [said.id] });
    const notMine = await makeTask(aishaAgent, { title: 'Not Said\'s' });
    const res = await bulk(saidAgent, { ids: [mine, assigned, notMine], apply: 'priority:high' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, [mine, assigned]);
    assert.deepEqual(res.body.skipped.locked, [notMine]);
    assert.deepEqual((await tasks([mine, assigned, notMine])).map((t) => t.priority), ['high', 'high', 'med']);
    const page = await saidAgent.get('/table');
    assert.match(page.text, new RegExp(`Tasks updated: 2\\. Skipped because you can’t edit them: #${notMine}\\.`));
    const asAdmin = await bulk(adminAgent, { ids: [notMine], apply: 'priority:low' });
    assert.deepEqual(asAdmin.body.updated, [notMine], 'admins can edit any task');
  });

  test('a label is added where missing, and removed when every selected task has it', async () => {
    const a = await makeTask(aishaAgent, { title: 'Label one', labels: [1] });
    const b = await makeTask(aishaAgent, { title: 'Label two' });
    let res = await bulk(aishaAgent, { ids: [a, b], apply: 'label:1' });
    assert.deepEqual(res.body.updated, [b], 'only the task missing it changes');
    assert.deepEqual((await tasks([a, b])).map((t) => t.labels), [[1], [1]]);
    res = await bulk(aishaAgent, { ids: [a, b], apply: 'label:1' });
    assert.deepEqual(res.body.updated, [a, b]);
    assert.deepEqual((await tasks([a, b])).map((t) => t.labels), [[], []]);
    const edits = (await auditFor(b)).filter((e) => e.action === 'task.edited').map((e) => e.details.changes.labels);
    assert.deepEqual(edits, [{ added: [1], removed: [] }, { added: [], removed: [1] }]);
    const bad = await bulk(aishaAgent, { ids: [a], apply: 'label:999' });
    assert.equal(bad.status, 400);
  });

  test('assigning several tasks sends one email listing them, and one in-app notification per task', async () => {
    const ids = [];
    for (const title of ['Batch one', 'Batch two', 'Batch three']) ids.push(await makeTask(aishaAgent, { title }));
    const before = (await outbox(fatma.email)).length;
    const res = await bulk(aishaAgent, { ids, apply: 'assignee', assignee: fatma.id });
    assert.deepEqual(res.body.updated, ids);
    assert.ok((await tasks(ids)).every((t) => t.people.includes(fatma.id)));
    const notes = (await q(`SELECT task_id, kind FROM notifications WHERE user_id = $1 AND task_id = ANY($2::int[])`, [fatma.id, ids])).rows;
    assert.equal(notes.length, 3);
    assert.ok(notes.every((n) => n.kind === 'assigned'));
    const mails = (await outbox(fatma.email)).slice(before);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, 'Aisha Al-Lawati assigned you to 3 tasks');
    for (const id of ids) assert.match(mails[0].body_text, new RegExp(`#${id} · Batch`));
    assert.match(mails[0].body_text, new RegExp(`/table\\?person=${fatma.id}`));

    const single = await makeTask(aishaAgent, { title: 'Just one' });
    await bulk(aishaAgent, { ids: [single], apply: 'assignee', assignee: fatma.id });
    const last = (await outbox(fatma.email)).at(-1);
    assert.equal(last.subject, `Aisha Al-Lawati assigned you to #${single}`, 'one task keeps the usual email');

    const off = await bulk(aishaAgent, { ids, apply: 'assignee', assignee: fatma.id });
    assert.deepEqual(off.body.updated, ids, 'everyone had her, so she is removed from all');
    assert.ok((await tasks(ids)).every((t) => !t.people.includes(fatma.id)));
  });

  test('disabled people can be removed but not assigned', async () => {
    const gone = await createUser({ name: 'Former Person', status: 'disabled' });
    const id = await makeTask(aishaAgent, { title: 'Nobody new' });
    const res = await bulk(aishaAgent, { ids: [id], apply: 'assignee', assignee: gone.id });
    assert.equal(res.status, 400);
    assert.deepEqual((await tasks([id]))[0].people, []);
  });

  test('moving several tasks to Review sends each creator one email', async () => {
    const a = await makeTask(fatmaAgent, { title: 'Review one' });
    const b = await makeTask(fatmaAgent, { title: 'Review two' });
    const before = (await outbox(fatma.email)).length;
    await bulk(saidAgent, { ids: [a, b], apply: 'status:review' });
    const mails = (await outbox(fatma.email)).slice(before);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, 'Said Al-Rawahi moved 2 tasks to Review and asked you to check them');
  });

  test('due dates can be set and cleared; bad dates are refused', async () => {
    const id = await makeTask(aishaAgent, { title: 'Dated' });
    await bulk(aishaAgent, { ids: [id], apply: 'due', due: '2026-12-15' });
    assert.equal((await tasks([id]))[0].due, '2026-12-15');
    await bulk(aishaAgent, { ids: [id], apply: 'due-clear' });
    assert.equal((await tasks([id]))[0].due, null);
    const changes = (await auditFor(id)).filter((e) => e.action === 'task.edited').map((e) => e.details.changes.due_date);
    assert.deepEqual(changes, [{ from: null, to: '2026-12-15' }, { from: '2026-12-15', to: null }]);
    for (const due of ['2026-02-30', 'tomorrow', '']) {
      const res = await bulk(aishaAgent, { ids: [id], apply: 'due', due });
      assert.equal(res.status, 400, due);
    }
  });

  test('closed tasks and unknown ids are skipped, never changed', async () => {
    const id = await makeTask(aishaAgent, { title: 'Already done', assignees: [aisha.id] });
    await post(aishaAgent, `/tasks/${id}/close`, { reason: 'completed', credited: [aisha.id] }, `/tasks/${id}/close`);
    const res = await bulk(aishaAgent, { ids: [id, 999999], apply: 'status:todo' });
    assert.deepEqual(res.body.updated, []);
    assert.deepEqual(res.body.skipped.closed, [id]);
    assert.deepEqual(res.body.skipped.missing, [999999]);
    assert.notEqual((await q('SELECT closed_at FROM tasks WHERE id = $1', [id])).rows[0].closed_at, null);
  });

  test('requests are validated, and can only change the chosen field', async () => {
    const id = await makeTask(aishaAgent, { title: 'Validate me' });
    const tooMany = Array.from({ length: 51 }, (_, i) => i + 1);
    for (const body of [
      { ids: [], apply: 'status:todo' },
      { ids: tooMany, apply: 'status:todo' },
      { ids: [id], apply: 'status:done' },
      { ids: [id], apply: 'title:Hacked' },
      { ids: [id], apply: 'priority:urgent' },
      { ids: ['abc'], apply: 'priority:high' },
    ]) {
      const res = await bulk(aishaAgent, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    await bulk(aishaAgent, { ids: [id], apply: 'priority:low', creator_id: said.id, title: 'Hacked', status: 'review' });
    const row = (await q('SELECT title, status, priority, creator_id FROM tasks WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { title: 'Validate me', status: 'todo', priority: 'low', creator_id: aisha.id });
  });

  test('needs a session and a CSRF token', async () => {
    const id = await makeTask(aishaAgent, { title: 'Guarded' });
    const anon = await request(app).post('/tasks/bulk').set('Accept', 'application/json').send({ ids: [id], apply: 'priority:high' });
    assert.ok([401, 403].includes(anon.status));
    const noToken = await aishaAgent.post('/tasks/bulk').set('Accept', 'application/json').send({ ids: [id], apply: 'priority:high' });
    assert.equal(noToken.status, 403);
    assert.equal((await tasks([id]))[0].priority, 'med');
  });

  test('works as a plain form without JavaScript, returning only to the table', async () => {
    const id = await makeTask(aishaAgent, { title: 'No script' });
    const res = await post(aishaAgent, '/tasks/bulk', { ids: [String(id)], apply: 'priority:high', back: '/table?sort=due' }, '/table');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/table?sort=due');
    assert.equal((await tasks([id]))[0].priority, 'high');
    const elsewhere = await post(aishaAgent, '/tasks/bulk', { ids: [String(id)], apply: 'priority:low', back: 'https://evil.example/' }, '/table');
    assert.equal(elsewhere.headers.location, '/table');
    const sneaky = await post(aishaAgent, '/tasks/bulk', { ids: [String(id)], apply: 'priority:low', back: '/settings' }, '/table');
    assert.equal(sneaky.headers.location, '/table');
    const empty = await post(aishaAgent, '/tasks/bulk', { apply: 'priority:low', back: '/table' }, '/table');
    assert.equal(empty.status, 302);
    const page = await aishaAgent.get('/table');
    assert.match(page.text, /Select one or more rows first\./);
  });

  test('the table marks fields a person can\'t edit, and shows the ribbon in Arabic', async () => {
    const id = await makeTask(aishaAgent, { title: 'Aisha only' });
    const page = await saidAgent.get('/table');
    assert.match(page.text, /id="bulk"/);
    assert.match(page.text, new RegExp(`value="${id}" form="bulk"`));
    const row = page.text.slice(page.text.indexOf(`data-task-id="${id}"`));
    assert.match(row.slice(0, 4000), /data-field="priority" data-locked/);
    assert.doesNotMatch(row.slice(0, 4000), /data-field="status" data-locked/, 'status stays open to everyone');
    await post(saidAgent, '/lang', { lang: 'ar', next: '/table' });
    const ar = await saidAgent.get('/table');
    assert.match(ar.text, /إسناد أو إلغاء الإسناد/);
    assert.match(ar.text, /<html lang="ar" dir="rtl">/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/table' });
  });
});
