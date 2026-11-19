import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { translator } from '../src/i18n.js';
import { prunePreviews } from '../src/services/previews.js';
import { connectApp, createUser, csrfIn, resetLimits, setup, signIn, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
let app;
before(async () => ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN })));
after(teardown);
beforeEach(resetLimits);

let nextId = 1;
async function call(token, name, args = {}) {
  const res = await request(app).post('/connector').set('Authorization', `Bearer ${token}`)
    .send({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.result, JSON.stringify(res.body));
  return res.body.result;
}
async function ok(token, name, args = {}) {
  const result = await call(token, name, args);
  assert.ok(!result.isError, result.content?.[0]?.text);
  return result.structuredContent;
}

let seq = 0;
async function person(first, extra = {}) {
  seq += 1;
  return createUser({ name: `${first} Checker${seq}`, email: `${first.toLowerCase()}.c${seq}@example.com`, ...extra });
}
async function addTask(creator, { title = 'A task', assignees = [] } = {}) {
  const { rows } = await q(`INSERT INTO tasks (title, creator_id) VALUES ($1, $2) RETURNING id`, [title, creator.id]);
  for (const u of assignees) await q('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)', [rows[0].id, u.id]);
  return rows[0].id;
}
async function sixTasks(creator, word, assignees = []) {
  const ids = [];
  for (let i = 1; i <= 6; i += 1) ids.push(await addTask(creator, { title: `${word} ${i}`, assignees }));
  return ids;
}
const taskRow = async (id) => (await q('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
const secretOf = (result) => result._meta['mahamm/confirm'];

describe('connector: changes that wait for confirmation', () => {
  test('a big change comes back as a preview; only the card secret confirms it, once', async () => {
    const me = await person('Amal');
    const token = await connectApp(app, me, RETURN);
    const ids = await sixTasks(me, 'Shelf');
    const result = await call(token, 'update_tasks', { task_ids: ids, priority: 'high', add_labels: ['Client'] });
    assert.ok(!result.isError);
    const out = result.structuredContent;
    assert.equal(out.waiting_for_confirmation, true);
    assert.equal(out.preview.kind, 'update');
    assert.equal(out.preview.count, 6);
    assert.deepEqual(out.preview.tasks.map((t) => t.title), ['Shelf 1', 'Shelf 2', 'Shelf 3', 'Shelf 4', 'Shelf 5', 'Shelf 6']);
    assert.deepEqual(out.preview.changes, { priority: 'high', add_labels: ['Client'] });
    assert.match(out.preview.confirm_url, /\/previews\/[0-9a-f-]{36}$/);
    const { preview_id: previewId, secret } = secretOf(result);
    assert.equal(previewId, out.preview.id);
    assert.ok(!result.content[0].text.includes(secret));
    assert.equal((await taskRow(ids[0])).priority, 'med');

    const wrong = await call(token, 'confirm_preview', { preview_id: previewId, secret: 'x'.repeat(43) });
    assert.ok(wrong.isError);
    assert.match(wrong.content[0].text, /Confirm button/);
    assert.equal((await taskRow(ids[0])).priority, 'med');

    const done = await ok(token, 'confirm_preview', { preview_id: previewId, secret });
    assert.equal(done.done, true);
    assert.equal(done.changed, true);
    assert.equal(done.tasks.length, 6);
    for (const id of ids) assert.equal((await taskRow(id)).priority, 'high');
    const events = (await q(`SELECT details FROM audit_events WHERE details->>'preview' = $1`, [previewId])).rows;
    assert.equal(events.length, 6);
    assert.ok(events.every((e) => e.details.via === 'connector' && e.details.batch === done.batch));
    const again = await ok(token, 'confirm_preview', { preview_id: previewId, secret });
    assert.deepEqual(again, { done: false, gone: 'confirmed' });

    const undo = await ok(token, 'undo', { batch: done.batch });
    assert.equal(undo.undone.length, 6);
    assert.equal((await taskRow(ids[0])).priority, 'med');
  });

  test('taking someone else off a task waits for confirmation too', async () => {
    const me = await person('Badriya');
    const other = await person('Sultan');
    const token = await connectApp(app, me, RETURN);
    const id = await addTask(me, { title: 'Shared job', assignees: [me, other] });
    const result = await call(token, 'update_tasks', { task_ids: [id], remove_assignees: [other.name] });
    assert.deepEqual(result.structuredContent.preview.changes.remove_assignees, [other.name]);
    const done = await ok(token, 'confirm_preview', { ...secretOf(result) });
    assert.equal(done.done, true);
    assert.deepEqual(done.tasks[0].assignees, [me.name]);
  });

  test("cancelling, expiry, and someone else's preview", async () => {
    const me = await person('Zainab');
    const other = await person('Majid');
    const token = await connectApp(app, me, RETURN);
    const otherToken = await connectApp(app, other, RETURN);
    const ids = await sixTasks(me, 'Crate');

    const first = await call(token, 'close_tasks', { task_ids: ids, reason: 'not_needed' });
    assert.equal(first.structuredContent.preview.kind, 'close');
    const { preview_id: firstId, secret: firstSecret } = secretOf(first);
    const stranger = await call(otherToken, 'confirm_preview', { preview_id: firstId, secret: firstSecret });
    assert.ok(stranger.isError);
    assert.match(stranger.content[0].text, /no such change/);
    assert.deepEqual(await ok(token, 'cancel_preview', { preview_id: firstId }), { cancelled: true });
    assert.deepEqual(await ok(token, 'confirm_preview', { preview_id: firstId, secret: firstSecret }), { done: false, gone: 'cancelled' });
    assert.equal((await taskRow(ids[0])).closed_at, null);

    const second = await call(token, 'close_tasks', { task_ids: ids, reason: 'not_needed' });
    await q(`UPDATE connector_previews SET expires_at = now() - interval '1 minute' WHERE id = $1`, [secretOf(second).preview_id]);
    assert.deepEqual(await ok(token, 'confirm_preview', { ...secretOf(second) }), { done: false, gone: 'expired' });
    assert.equal((await taskRow(ids[0])).closed_at, null);

    await q(`UPDATE connector_previews SET expires_at = now() - interval '2 days' WHERE id = $1`, [secretOf(second).preview_id]);
    await prunePreviews();
    assert.equal((await q('SELECT count(*)::int AS n FROM connector_previews WHERE id = $1', [secretOf(second).preview_id])).rows[0].n, 0);
  });

  test("Mahamm's own page shows the change to its person only, in their language, and confirms it", async () => {
    const me = await person('Hessa');
    const other = await person('Abdullah');
    await q(`UPDATE users SET lang = 'ar' WHERE id = $1`, [me.id]);
    const token = await connectApp(app, me, RETURN);
    const ids = await sixTasks(me, 'Carton', [me]);
    const result = await call(token, 'close_tasks', { task_ids: ids, reason: 'completed' });
    const url = new URL(result.structuredContent.preview.confirm_url);

    const otherAgent = await signIn(app, other);
    assert.equal((await otherAgent.get(url.pathname)).status, 404);
    const agent = await signIn(app, me);
    const page = await agent.get(url.pathname);
    assert.equal(page.status, 200);
    const ar = translator('ar');
    assert.ok(page.text.includes(ar('preview.title')));
    assert.ok(page.text.includes(ar('preview.close', { count: 6 })));
    assert.ok(page.text.includes(ar('preview.creditAssignees')));
    assert.ok(page.text.includes('Carton 6'));

    const res = await agent.post(`${url.pathname}/confirm`).type('form').send({ _csrf: csrfIn(page.text) });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/home');
    for (const id of ids) assert.equal((await taskRow(id)).close_reason, 'completed');
    const after = await agent.get(url.pathname);
    assert.ok(after.text.includes(ar('preview.gone.confirmed')));
    assert.ok(!after.text.includes(`${url.pathname}/confirm`));
    const late = await call(token, 'confirm_preview', { ...secretOf(result) });
    assert.deepEqual(late.structuredContent, { done: false, gone: 'confirmed' });
  });

  test('Mahamm page: cancel, and posting without the form token is refused', async () => {
    const me = await person('Shamsa');
    const token = await connectApp(app, me, RETURN);
    const ids = await sixTasks(me, 'Box');
    const result = await call(token, 'update_tasks', { task_ids: ids, status: 'review' });
    const path = new URL(result.structuredContent.preview.confirm_url).pathname;
    const agent = await signIn(app, me);
    const page = await agent.get(path);
    const forged = await agent.post(`${path}/confirm`).type('form').send({});
    assert.equal(forged.status, 403);
    assert.equal((await taskRow(ids[0])).status, 'todo');
    const res = await agent.post(`${path}/cancel`).type('form').send({ _csrf: csrfIn(page.text) });
    assert.equal(res.headers.location, '/home');
    assert.ok((await agent.get(path)).text.includes(translator('en')('preview.gone.cancelled')));
    assert.equal((await taskRow(ids[0])).status, 'todo');
  });
});

describe('connector: adding many tasks, labels, descriptions and repeats', () => {
  test('more than ten new tasks wait for confirmation, then share one Undo', async () => {
    const me = await person('Nawal');
    const token = await connectApp(app, me, RETURN);
    const tasks = Array.from({ length: 12 }, (_, i) => ({ title: `Minutes item ${i + 1}`, assign_to_me: i === 0 }));
    const result = await call(token, 'create_tasks', { source: 'text', tasks });
    const out = result.structuredContent;
    assert.equal(out.preview.kind, 'create');
    assert.equal(out.preview.count, 12);
    assert.deepEqual(out.preview.tasks[0].assignees, [me.name]);
    assert.deepEqual(out.preview.tasks[1].assignees, []);
    assert.equal((await q(`SELECT count(*)::int AS n FROM tasks WHERE title LIKE 'Minutes item %'`)).rows[0].n, 0);
    const done = await ok(token, 'confirm_preview', { ...secretOf(result) });
    assert.equal(done.tasks.length, 12);
    assert.equal((await q(`SELECT count(*)::int AS n FROM tasks WHERE title LIKE 'Minutes item %'`)).rows[0].n, 12);
    const undo = await ok(token, 'undo', { batch: done.batch });
    assert.equal(undo.kind, 'added_tasks');
    assert.equal(undo.undone.length, 12);
  });

  test('new tasks take a description and labels; an unknown label is reported, not flagged', async () => {
    const me = await person('Ruqaya');
    const token = await connectApp(app, me, RETURN);
    const out = await ok(token, 'create_tasks', {
      tasks: [{ title: 'Order toner', description: 'Two black cartridges', labels: ['تقنية المعلومات', 'Gardening'], started: true }],
    });
    const [task] = out.tasks;
    assert.deepEqual(task.missing, [{ heard: 'Gardening', problem: 'no_such_label' }]);
    assert.equal((await taskRow(task.id)).description, 'Two black cartridges');
    assert.deepEqual((await q('SELECT label_id FROM task_labels WHERE task_id = $1', [task.id])).rows.map((r) => r.label_id), [3]);
    const [flag] = (await q('SELECT note FROM flags WHERE task_id = $1', [task.id])).rows;
    assert.equal(flag.note, translator('en')('connector.noAssignee'));
  });

  test('a new task like an open one points to it: a close match in full, looser ones by number', async () => {
    const me = await person('Hamdan');
    const token = await connectApp(app, me, RETURN);
    const first = await addTask(me, { title: 'Renew the office internet contract' });
    const looser = await addTask(me, { title: 'Office internet router replacement' });
    const out = await ok(token, 'create_tasks', { tasks: [{ title: 'Renew internet contract for the office' }, { title: 'Water the plants' }] });
    assert.equal(out.tasks[0].close_match.task.id, first);
    assert.deepEqual(out.tasks[0].similar.map((t) => t.id), [looser]);
    assert.equal(out.tasks[1].similar, undefined);
    assert.equal(out.tasks[1].close_match, undefined);
  });
});

describe('connector: admin changes', () => {
  test('members cannot; admins confirm adding a person and changing the in-progress limit', async () => {
    const member = await person('Saleh');
    const admin = await person('Admin', { role: 'admin', twoFactor: true });
    const memberToken = await connectApp(app, member, RETURN);
    const refused = await call(memberToken, 'admin_change', { action: 'set_in_progress_limit', limit: 7 });
    assert.ok(refused.isError);
    assert.match(refused.content[0].text, /Only admins/);

    const token = await connectApp(app, admin, RETURN);
    const add = await call(token, 'admin_change', { action: 'add_person', name: 'Fatma Warehouse' });
    assert.deepEqual(add.structuredContent.preview.name, 'Fatma Warehouse');
    assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE name = 'Fatma Warehouse'`)).rows[0].n, 0);
    const added = await ok(token, 'confirm_preview', { ...secretOf(add) });
    assert.equal(added.added_person, 'Fatma Warehouse');
    const fatma = (await q(`SELECT email FROM users WHERE name = 'Fatma Warehouse'`)).rows[0];
    assert.equal(fatma.email, null);
    const taken = await call(token, 'admin_change', { action: 'add_person', name: 'fatma warehouse' });
    assert.ok(taken.isError);
    assert.match(taken.content[0].text, /already has that name/);

    const limit = await call(token, 'admin_change', { action: 'set_in_progress_limit', limit: 7 });
    assert.equal(limit.structuredContent.preview.from, 5);
    assert.equal(limit.structuredContent.preview.to, 7);
    await ok(token, 'confirm_preview', { ...secretOf(limit) });
    assert.equal((await ok(token, 'get_team')).in_progress.limit, 7);
    assert.ok((await q(`SELECT 1 FROM audit_events WHERE action = 'settings.wip_limit_changed' AND actor_id = $1`, [admin.id])).rows[0]);
  });
});
