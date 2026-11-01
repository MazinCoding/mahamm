import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { q } from '../src/db.js';
import { auditFor, createUser, makeTask, post, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

let app;
let aisha; let said; let fatma;
let aishaAgent; let saidAgent; let fatmaAgent;

before(async () => {
  ({ app } = await setup());
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  said = await createUser({ name: 'Said Al-Rawahi' });
  fatma = await createUser({ name: 'Fatma Al-Harthi' });
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);
  fatmaAgent = await signIn(app, fatma);
});
after(teardown);
beforeEach(resetLimits);

async function bulk(agent, body) {
  const token = await tokenFor(agent, '/table');
  return agent.post('/tasks/bulk').set('X-CSRF-Token', token).set('Accept', 'application/json').send(body);
}
// The Undo button in the message after an action carries the batch id.
async function undoBatchFromPage(agent) {
  const page = await agent.get('/table');
  const m = page.text.match(/name="batch" value="([0-9a-f-]{36})"/);
  return m ? m[1] : null;
}
const undo = (agent, batch) => post(agent, '/tasks/bulk/undo', { batch, back: '/table' }, '/table');
const row = async (id) => (await q(
  `SELECT status, priority, due_date::text AS due, closed_at, closed_by, close_reason,
          ARRAY(SELECT label_id FROM task_labels WHERE task_id = t.id ORDER BY 1) AS labels,
          ARRAY(SELECT user_id::text FROM task_assignees WHERE task_id = t.id ORDER BY 1) AS people,
          ARRAY(SELECT user_id::text FROM task_credits WHERE task_id = t.id ORDER BY 1) AS credits
   FROM tasks t WHERE id = $1`, [id],
)).rows[0];

describe('Done for several tasks', () => {
  test('the ribbon sends Done to the close page instead of closing straight away', async () => {
    const a = await makeTask(aishaAgent, { title: 'Done one' });
    const json = await bulk(saidAgent, { ids: [a], apply: 'close' });
    assert.equal(json.status, 200);
    assert.equal(json.body.redirect, `/table/close?ids=${a}&back=%2Ftable`);
    const form = await post(saidAgent, '/tasks/bulk', { ids: [String(a)], apply: 'close', back: '/table?sort=due' }, '/table');
    assert.equal(form.headers.location, `/table/close?ids=${a}&back=%2Ftable%3Fsort%3Ddue`);
    assert.equal((await row(a)).closed_at, null);
  });

  test('the close page credits assignees by default and marks tasks with nobody as Missing', async () => {
    const withPeople = await makeTask(aishaAgent, { title: 'Has people', assignees: [said.id] });
    const nobody = await makeTask(aishaAgent, { title: 'Has nobody' });
    const page = await fatmaAgent.get(`/table/close?ids=${withPeople}&ids=${nobody}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Its assignees: Said Al-Rawahi/);
    assert.match(page.text, /Missing: pick who did it/);
    assert.match(page.text, /Close selected tasks/);

    const refused = await post(fatmaAgent, '/tasks/bulk/close',
      { ids: [String(withPeople), String(nobody)], credit: ['', ''], reason: 'completed', back: '/table' }, '/table');
    assert.equal(refused.status, 400);
    assert.match(refused.text, new RegExp(`class="close-item is-missing">\\s*<input type="hidden" name="ids" value="${nobody}">`));
    assert.equal((await row(withPeople)).closed_at, null, 'nothing is closed while any task is missing a person');

    const res = await post(fatmaAgent, '/tasks/bulk/close',
      { ids: [String(withPeople), String(nobody)], credit: ['', aisha.id], reason: 'completed', back: '/table' }, '/table');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/table');
    const [a, b] = [await row(withPeople), await row(nobody)];
    assert.deepEqual([a.close_reason, a.closed_by, a.credits], ['completed', fatma.id, [said.id]]);
    assert.deepEqual([b.close_reason, b.closed_by, b.credits], ['completed', fatma.id, [aisha.id]]);
    const closes = [...await auditFor(withPeople), ...await auditFor(nobody)].filter((e) => e.action === 'task.closed');
    assert.equal(closes.length, 2);
    assert.equal(closes[0].details.batch, closes[1].details.batch);
    assert.deepEqual(closes[1].details.credited, [aisha.id]);
    const credited = (await q(`SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2`, [aisha.id, nobody])).rows;
    assert.deepEqual(credited.map((n) => n.kind), ['credited']);
    const table = await fatmaAgent.get('/table');
    assert.match(table.text, /Tasks closed: 2\./);
    assert.match(table.text, /action="\/tasks\/bulk\/undo"/);
  });

  test('Not needed closes without credit; Created by mistake also settles open flags', async () => {
    const plain = await makeTask(aishaAgent, { title: 'Not needed now' });
    const flagged = await makeTask(aishaAgent, { title: 'Made by mistake' });
    await post(saidAgent, `/tasks/${flagged}/flag`, { reason: 'mistake', note: '' }, `/tasks/${flagged}/flag`);
    await post(saidAgent, '/tasks/bulk/close', { ids: [String(plain)], reason: 'notneeded', back: '/table' }, '/table');
    assert.deepEqual([(await row(plain)).close_reason, (await row(plain)).credits], ['notneeded', []]);
    await post(saidAgent, '/tasks/bulk/close', { ids: [String(flagged)], reason: 'mistake', back: '/table' }, '/table');
    const open = (await q('SELECT count(*)::int AS n FROM flags WHERE task_id = $1 AND resolved_at IS NULL', [flagged])).rows[0].n;
    assert.equal(open, 0);
  });

  test('duplicates and unknown reasons are refused here; closed tasks are left alone', async () => {
    const a = await makeTask(aishaAgent, { title: 'Dup?' });
    const res = await post(saidAgent, '/tasks/bulk/close', { ids: [String(a)], reason: 'duplicate', back: '/table' }, '/table');
    assert.equal(res.status, 400);
    assert.equal((await row(a)).closed_at, null);
    await post(saidAgent, '/tasks/bulk/close', { ids: [String(a)], reason: 'notneeded', back: '/table' }, '/table');
    const page = await saidAgent.get(`/table/close?ids=${a}`);
    assert.equal(page.status, 302, 'nothing left to close goes back to the table');
  });

  test('the close page is in Arabic too', async () => {
    const a = await makeTask(aishaAgent, { title: 'عربي' });
    await post(saidAgent, '/lang', { lang: 'ar', next: '/table' });
    const page = await saidAgent.get(`/table/close?ids=${a}`);
    assert.match(page.text, /<html lang="ar" dir="rtl">/);
    assert.match(page.text, /إغلاق المهام المحددة/);
    assert.match(page.text, /غير محدد: اختر من أنجزها/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/table' });
  });
});

describe('Undo', () => {
  test('undoes a status change, recorded as new history marked (undo)', async () => {
    const a = await makeTask(aishaAgent, { title: 'Undo status A' });
    const b = await makeTask(aishaAgent, { title: 'Undo status B', status: 'backlog' });
    await bulk(saidAgent, { ids: [a, b], apply: 'status:review' });
    const batch = await undoBatchFromPage(saidAgent);
    assert.ok(batch);
    const res = await undo(saidAgent, batch);
    assert.equal(res.headers.location, '/table');
    assert.deepEqual([(await row(a)).status, (await row(b)).status], ['todo', 'backlog']);
    const back = (await auditFor(b)).filter((e) => e.action === 'task.moved').at(-1);
    assert.deepEqual(back.details, { from: 'review', to: 'backlog', undo_of: batch });
    const page = await saidAgent.get(`/tasks/${b}`);
    assert.match(page.text, /\(undo\)/);
    assert.ok((await auditFor(b)).length >= 3, 'the original move stays in the history');
  });

  test('undoes labels, people, priority and due dates exactly', async () => {
    const a = await makeTask(aishaAgent, { title: 'Undo fields', labels: [2], assignees: [aisha.id], priority: 'low' });
    const before = await row(a);
    const steps = [
      { apply: 'label:2' }, { apply: 'label:3' }, { apply: 'assignee', assignee: said.id },
      { apply: 'assignee', assignee: aisha.id }, { apply: 'priority:high' }, { apply: 'due', due: '2026-12-01' },
    ];
    for (const step of steps) {
      await bulk(aishaAgent, { ids: [a], ...step });
      const changed = await row(a);
      assert.notDeepEqual(changed, before, JSON.stringify(step));
      await undo(aishaAgent, await undoBatchFromPage(aishaAgent));
      assert.deepEqual(await row(a), before, JSON.stringify(step));
    }
  });

  test('undoing Done reopens the tasks where they were and removes the credit', async () => {
    const a = await makeTask(aishaAgent, { title: 'Undo close', assignees: [said.id], status: 'backlog' });
    await post(aishaAgent, '/tasks/bulk/close', { ids: [String(a)], credit: [''], reason: 'completed', back: '/table' }, '/table');
    assert.notEqual((await row(a)).closed_at, null);
    await undo(aishaAgent, await undoBatchFromPage(aishaAgent));
    const r = await row(a);
    assert.deepEqual([r.closed_at, r.status, r.credits], [null, 'backlog', []]);
    const reopened = (await auditFor(a)).find((e) => e.action === 'task.reopened');
    assert.ok(reopened.details.undo_of);
  });

  test('tasks someone changed since are left alone and listed', async () => {
    const a = await makeTask(aishaAgent, { title: 'Changed later' });
    const b = await makeTask(aishaAgent, { title: 'Not changed later' });
    await bulk(aishaAgent, { ids: [a, b], apply: 'priority:high' });
    const batch = await undoBatchFromPage(aishaAgent);
    await bulk(saidAgent, { ids: [a], apply: 'status:progress' });
    await undo(aishaAgent, batch);
    assert.deepEqual([(await row(a)).priority, (await row(b)).priority], ['high', 'med']);
    const page = await aishaAgent.get('/table');
    assert.match(page.text, new RegExp(`Undone\\. Tasks restored: 1\\. Left as they are because someone changed them since: #${a}\\.`));
    await undo(aishaAgent, batch);
    assert.match((await aishaAgent.get('/table')).text, /Nothing was undone\./, 'undoing twice changes nothing');
    assert.equal((await row(b)).priority, 'med');
  });

  test('only the person who acted can undo, and only for 10 minutes', async () => {
    const a = await makeTask(aishaAgent, { title: 'Mine to undo' });
    await bulk(aishaAgent, { ids: [a], apply: 'priority:high' });
    const batch = await undoBatchFromPage(aishaAgent);
    await undo(saidAgent, batch);
    assert.equal((await row(a)).priority, 'high');
    assert.match((await saidAgent.get('/table')).text, /Undo is no longer available/);

    const old = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
    const b = await makeTask(aishaAgent, { title: 'Too late' });
    await q(`UPDATE tasks SET status = 'review' WHERE id = $1`, [b]);
    await q(`INSERT INTO audit_events (actor_id, action, task_id, details, at) VALUES ($1, 'task.moved', $2, $3, now() - interval '11 minutes')`,
      [aisha.id, b, JSON.stringify({ from: 'todo', to: 'review', batch: old })]);
    await undo(aishaAgent, old);
    assert.equal((await row(b)).status, 'review');
    for (const bad of ['', 'not-a-uuid']) {
      const res = await undo(aishaAgent, bad);
      assert.equal(res.status, 302);
    }
    const noToken = await aishaAgent.post('/tasks/bulk/undo').type('form').send({ batch });
    assert.equal(noToken.status, 403);
  });
});
