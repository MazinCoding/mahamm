import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from './helpers.js';
import { translator } from '../src/i18n.js';
import { IP_LIMIT, PERSON_LIMIT } from '../src/routes/connector.js';
import { addDays, localToday } from '../src/services/connector.js';
import { connectApp, createUser, resetLimits, setup, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
let app;
before(async () => ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN })));
after(teardown);
beforeEach(resetLimits);

let nextId = 1;
const rpc = (token, method, params) => request(app).post('/connector').set('Authorization', `Bearer ${token}`)
  .send({ jsonrpc: '2.0', id: nextId++, method, params });

async function call(token, name, args = {}) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.result, JSON.stringify(res.body));
  return res.body.result;
}

// The structured result of a call that must succeed.
async function ok(token, name, args = {}) {
  const result = await call(token, name, args);
  assert.ok(!result.isError, result.content?.[0]?.text);
  return result.structuredContent;
}

const today = localToday('Asia/Muscat');
const byId = (a, b) => a - b;

// People get names nobody else in this file shares, so names match one person.
let seq = 0;
async function person(first) {
  seq += 1;
  return createUser({ name: `${first} Tester${seq}`, email: `${first.toLowerCase()}${seq}@example.com` });
}

async function addTask(creator, { title = 'A task', description = '', status = 'todo', priority = 'med', due = null, assignees = [], labels = [] } = {}) {
  const { rows } = await q(
    `INSERT INTO tasks (title, description, status, priority, due_date, creator_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [title, description, status, priority, due, creator.id],
  );
  const { id } = rows[0];
  for (const u of assignees) await q('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)', [id, u.id]);
  for (const l of labels) await q('INSERT INTO task_labels (task_id, label_id) VALUES ($1, $2)', [id, l]);
  return id;
}

const taskRow = async (id) => (await q('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
const CLIENT = 7; // seeded label "Client" / "عميل"

describe('connector tools: reading', () => {
  test('search_tasks: words in either language, people, labels, dates; empty values stay empty', async () => {
    const me = await person('Mazin');
    const ahmed = await person('Ahmed');
    const token = await connectApp(app, me, RETURN);
    const printer = await addTask(me, { title: 'Fix the printer', description: 'second floor, by the lifts', status: 'progress', priority: 'high', due: addDays(today, -1), assignees: [ahmed] });
    const report = await addTask(me, { title: 'Print the monthly report', due: today, assignees: [me], labels: [CLIENT] });
    const arabic = await addTask(me, { title: 'الطابعة في المكتب لا تعمل' });
    const ids = (r) => r.tasks.map((t) => t.id);

    const words = await ok(token, 'search_tasks', { words: ['printer', 'الطابعة'] });
    assert.ok(ids(words).includes(printer) && ids(words).includes(arabic));
    assert.ok(!ids(words).includes(report));
    assert.deepEqual(ids(await ok(token, 'search_tasks', { words: ['by the lifts'] })), [printer]);

    assert.deepEqual(ids(await ok(token, 'search_tasks', { person: ahmed.name })), [printer]);
    assert.ok(ids(await ok(token, 'search_tasks', { person: 'me' })).includes(report));
    const client = await ok(token, 'search_tasks', { label: 'عميل' });
    assert.ok(ids(client).includes(report) && !ids(client).includes(printer));
    const overdue = await ok(token, 'search_tasks', { due: 'overdue' });
    assert.ok(ids(overdue).includes(printer) && !ids(overdue).includes(report));
    assert.ok(ids(await ok(token, 'search_tasks', { due: 'today' })).includes(report));
    const high = await ok(token, 'search_tasks', { priority: ['high'], status: ['in_progress'] });
    assert.ok(ids(high).includes(printer));
    assert.equal(high.per_page, 25);
    assert.ok(high.total >= 1);

    const loose = await ok(token, 'search_tasks', { unassigned: true, words: ['الطابعة'] });
    const row = loose.tasks.find((t) => t.id === arabic);
    assert.equal(row.due_date, null);
    assert.deepEqual(row.assignees, []);
    assert.equal(row.status, 'todo');
    assert.equal(row.priority, 'medium');
    assert.ok(row.url.endsWith(`/tasks/${arabic}`));

    const nobody = await ok(token, 'search_tasks', { person: 'Somebody Unheardof' });
    assert.deepEqual(nobody.missing, [{ heard: 'Somebody Unheardof', problem: 'nobody_by_that_name' }]);
    assert.equal(nobody.total, 0);
    const noLabel = await ok(token, 'search_tasks', { label: 'Gardening' });
    assert.equal(noLabel.missing[0].problem, 'no_such_label');
    assert.ok(noLabel.missing[0].labels.includes('Client'));
    const bad = await call(token, 'search_tasks', { due: 'someday' });
    assert.ok(bad.isError);
  });

  test("get_task: details, comments and history in the person's language; unknown tasks", async () => {
    const huda = await person('Huda');
    await q(`UPDATE users SET lang = 'ar' WHERE id = $1`, [huda.id]);
    const token = await connectApp(app, huda, RETURN);
    const { tasks: [added] } = await ok(token, 'create_tasks', { tasks: [{ title: 'تجديد عقد الصيانة', assign_to_me: true }] });
    await ok(token, 'update_tasks', { task_ids: [added.id], add_labels: ['Client'], description: 'العقد ينتهي نهاية الشهر' });
    await ok(token, 'add_comment', { task_id: added.id, text: 'اتصلت بالمورد' });
    const full = await ok(token, 'get_task', { task_id: added.id });
    assert.equal(full.title, 'تجديد عقد الصيانة');
    assert.equal(full.description, 'العقد ينتهي نهاية الشهر');
    assert.deepEqual(full.labels, ['عميل']);
    assert.deepEqual(full.assignees, [huda.name]);
    assert.equal(full.comments[0].text, 'اتصلت بالمورد');
    assert.equal(full.comments[0].by, huda.name);
    assert.equal(full.closed, null);
    assert.match(full.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const ar = translator('ar');
    assert.ok(full.history.length >= 2);
    assert.ok(full.history.every((h) => h.text.endsWith(ar('ev.via'))), JSON.stringify(full.history));
    const missing = await call(token, 'get_task', { task_id: 999999 });
    assert.ok(missing.isError);
    assert.match(missing.content[0].text, /no task #999999/);
  });

  test('my_work: my tasks, due dates, reviews waiting for me and unread notifications; mark_read', async () => {
    const me = await person('Salim');
    const other = await person('Khalid');
    const token = await connectApp(app, me, RETURN);
    const late = await addTask(other, { title: 'Late one', status: 'progress', due: addDays(today, -2), assignees: [me] });
    const now = await addTask(other, { title: 'Due today', due: today, assignees: [me] });
    const soon = await addTask(other, { title: 'Due soon', due: addDays(today, 3), assignees: [me] });
    const review = await addTask(me, { title: 'Check my quote', status: 'review', assignees: [other] });
    const otherToken = await connectApp(app, other, RETURN);
    await ok(otherToken, 'add_comment', { task_id: now, text: 'Can you look at this?', mention: [me.name] });

    const work = await ok(token, 'my_work');
    assert.equal(work.you, me.name);
    assert.equal(work.today, today);
    assert.deepEqual(work.overdue, [late]);
    assert.deepEqual(work.due_today, [now]);
    assert.deepEqual(work.due_this_week, [soon]);
    assert.deepEqual(work.waiting_for_your_review.map((t) => t.id), [review]);
    assert.equal(work.counts.in_progress, 1);
    assert.equal(work.counts.todo, 2);
    assert.equal(work.team_in_progress.limit, 5);
    const mention = work.notifications.find((n) => n.kind === 'mentioned');
    assert.equal(mention.task_id, now);
    assert.equal(mention.by, other.name);
    assert.ok(work.counts.unread_notifications >= 1);

    assert.ok((await ok(token, 'mark_read', { all: true })).marked_read >= 1);
    assert.equal((await ok(token, 'my_work')).counts.unread_notifications, 0);
    assert.equal((await ok(token, 'mark_read', { notification_ids: [mention.id] })).marked_read, 0);
  });

  test('workload and get_activity: who is busy, what happened, and credit counts as theirs', async () => {
    const lead = await person('Maryam');
    const dev = await person('Yusuf');
    const token = await connectApp(app, lead, RETURN);
    const a = await addTask(lead, { title: 'Busy one', status: 'progress', assignees: [dev] });
    const b = await addTask(lead, { title: 'Busy two', due: addDays(today, -1), assignees: [dev] });
    const load = await ok(token, 'workload');
    const row = load.people.find((p) => p.name === dev.name);
    assert.equal(row.in_progress, 1);
    assert.equal(row.todo, 1);
    assert.equal(row.overdue, 1);
    assert.ok(load.people.some((p) => p.name === lead.name && p.in_progress === 0));
    assert.equal(load.team.in_progress_limit, 5);

    await ok(token, 'update_tasks', { task_ids: [a], status: 'review' });
    await ok(token, 'close_tasks', { task_ids: [b], reason: 'completed' });
    const mine = await ok(token, 'get_activity', { person: 'me', kinds: ['moved'] });
    assert.ok(mine.events.some((e) => e.task_id === a));
    const devs = await ok(token, 'get_activity', { person: dev.name, kinds: ['closed'] });
    assert.deepEqual(devs.events.map((e) => e.task_id), [b]);
    assert.ok(devs.events[0].text.includes(dev.name));
    assert.deepEqual((await ok(token, 'get_activity', { person: 'me', from: addDays(today, 1) })).events, []);
    assert.ok((await ok(token, 'get_activity', { task_id: a, from: today, to: today })).events.length >= 1);
  });
});

describe('connector tools: changing', () => {
  test('update_tasks: anyone moves, only editors edit, one batch for several tasks, undo puts it back', async () => {
    const owner = await person('Hilal');
    const me = await person('Badr');
    const token = await connectApp(app, me, RETURN);
    const theirs = await addTask(owner, { title: 'Their task', priority: 'low' });
    const mine = await addTask(me, { title: 'My task', description: 'old words', priority: 'low' });

    const out = await ok(token, 'update_tasks', { task_ids: [theirs, mine], status: 'in_progress', priority: 'high' });
    assert.deepEqual(out.skipped.not_allowed, [theirs]);
    assert.deepEqual(out.tasks.map((t) => t.id), [theirs, mine].sort(byId));
    assert.equal((await taskRow(theirs)).status, 'progress');
    assert.equal((await taskRow(theirs)).priority, 'low');
    assert.equal((await taskRow(mine)).priority, 'high');
    const events = (await q(`SELECT action, details FROM audit_events WHERE details->>'batch' = $1 ORDER BY id`, [out.batch])).rows;
    assert.ok(events.every((e) => e.details.via === 'connector'));
    assert.equal(events.filter((e) => e.action === 'task.moved').length, 2);

    const renamed = await ok(token, 'update_tasks', { task_ids: [mine], title: 'My renamed task', description: 'new words', add_labels: ['Client', 'تصميم'] });
    assert.deepEqual([...renamed.tasks[0].labels].sort(), ['Client', 'Design']);
    const undo = await ok(token, 'undo', { batch: renamed.batch });
    assert.equal(undo.kind, 'changes');
    assert.deepEqual(undo.undone, [mine]);
    const back = await taskRow(mine);
    assert.equal(back.title, 'My task');
    assert.equal(back.description, 'old words');
    assert.equal((await q('SELECT count(*)::int AS n FROM task_labels WHERE task_id = $1', [mine])).rows[0].n, 0);

    // The first change: their task goes back; mine was changed since, so it stays.
    const undoFirst = await ok(token, 'undo', { batch: out.batch });
    assert.deepEqual(undoFirst.undone, [theirs]);
    assert.deepEqual(undoFirst.changed, [mine]);
    assert.equal((await taskRow(theirs)).status, 'todo');

    const two = await call(token, 'update_tasks', { task_ids: [theirs, mine], title: 'Same title' });
    assert.ok(two.isError);
  });

  test('update_tasks: a status on a closed task reopens it; that move is not undone', async () => {
    const me = await person('Rashid');
    const token = await connectApp(app, me, RETURN);
    const id = await addTask(me, { title: 'Closed too early', assignees: [me] });
    await ok(token, 'close_tasks', { task_ids: [id], reason: 'completed' });
    const out = await ok(token, 'update_tasks', { task_ids: [id], status: 'todo' });
    const row = await taskRow(id);
    assert.equal(row.closed_at, null);
    assert.equal(row.status, 'todo');
    assert.ok((await q(`SELECT 1 FROM audit_events WHERE task_id = $1 AND action = 'task.reopened' AND details->>'via' = 'connector'`, [id])).rows[0]);
    const undo = await ok(token, 'undo', { batch: out.batch });
    assert.deepEqual(undo.undone, []);
    assert.deepEqual(undo.changed, [id]);
    assert.equal((await taskRow(id)).closed_at, null);
  });

  test('update_tasks: big changes wait for a confirmation, unclear names change nothing, taking yourself off is fine', async () => {
    const me = await person('Hamad');
    const other = await person('Nasser');
    const token = await connectApp(app, me, RETURN);
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push(await addTask(me, { title: `Batch ${i}`, assignees: [me, other] }));

    const many = await ok(token, 'update_tasks', { task_ids: ids, priority: 'high' });
    assert.equal(many.changed, false);
    assert.equal(many.waiting_for_confirmation, true);
    assert.equal(many.preview.kind, 'update');
    assert.match(many.message, /confirm/);
    assert.equal((await taskRow(ids[0])).priority, 'med');
    const off = await ok(token, 'update_tasks', { task_ids: [ids[0]], remove_assignees: [other.name] });
    assert.equal(off.changed, false);
    assert.equal(off.waiting_for_confirmation, true);
    const unknown = await ok(token, 'update_tasks', { task_ids: [ids[0]], add_assignees: ['Nobody Unheardof'] });
    assert.equal(unknown.changed, false);
    assert.deepEqual(unknown.missing, [{ heard: 'Nobody Unheardof', problem: 'nobody_by_that_name' }]);
    const self = await ok(token, 'update_tasks', { task_ids: [ids[0]], remove_assignees: ['me'] });
    assert.equal(self.changed, true);
    assert.deepEqual(self.tasks[0].assignees, [other.name]);
  });

  test('update_tasks: adding someone settles the automatic "No assignee" flag', async () => {
    const me = await person('Talal');
    const helper = await person('Zahra');
    const token = await connectApp(app, me, RETURN);
    const { tasks: [t] } = await ok(token, 'create_tasks', { tasks: [{ title: 'Fix the gate', assignees: ['Qais Unheardof'], started: true }] });
    assert.equal(t.flagged, true);
    const out = await ok(token, 'update_tasks', { task_ids: [t.id], add_assignees: [helper.name] });
    assert.equal(out.tasks[0].flagged, false);
    assert.deepEqual((await q('SELECT resolution FROM flags WHERE task_id = $1', [t.id])).rows.map((r) => r.resolution), ['fixed']);
  });

  test('close_tasks: credit by name or to the assignees, never without credit; mistakes settle flags; undo reopens', async () => {
    const me = await person('Fahad');
    const doer = await person('Saif');
    const token = await connectApp(app, me, RETURN);
    const loose = await addTask(me, { title: 'Nobody on this' });
    const refused = await ok(token, 'close_tasks', { task_ids: [loose], reason: 'completed' });
    assert.equal(refused.changed, false);
    assert.deepEqual(refused.needs_credit, [loose]);
    assert.equal((await taskRow(loose)).closed_at, null);

    const done = await ok(token, 'close_tasks', { task_ids: [loose], reason: 'completed', credit: [doer.name] });
    assert.equal(done.tasks[0].status, 'done');
    assert.deepEqual(done.tasks[0].credited, [doer.name]);
    assert.ok((await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND task_id = $2 AND kind = 'credited'`, [doer.id, loose])).rows[0]);
    const undo = await ok(token, 'undo', { batch: done.batch });
    assert.deepEqual(undo.undone, [loose]);
    assert.equal((await taskRow(loose)).closed_at, null);
    assert.equal((await q('SELECT count(*)::int AS n FROM task_credits WHERE task_id = $1', [loose])).rows[0].n, 0);

    const assigned = await addTask(me, { title: 'Saif does this', assignees: [doer] });
    assert.deepEqual((await ok(token, 'close_tasks', { task_ids: [assigned], reason: 'completed' })).tasks[0].credited, [doer.name]);
    const mineToo = await addTask(me, { title: 'I did this one' });
    assert.deepEqual((await ok(token, 'close_tasks', { task_ids: [mineToo], reason: 'completed', credit: ['me'] })).tasks[0].credited, [me.name]);

    const wrong = await addTask(me, { title: 'Made by mistake' });
    await ok(token, 'flag_task', { action: 'raise', task_id: wrong, reason: 'mistake' });
    await ok(token, 'close_tasks', { task_ids: [wrong], reason: 'mistake' });
    assert.equal((await q('SELECT count(*)::int AS n FROM flags WHERE task_id = $1 AND resolved_at IS NULL', [wrong])).rows[0].n, 0);

    const copy = await addTask(me, { title: 'Saif does this again' });
    await ok(token, 'close_tasks', { task_ids: [copy], reason: 'duplicate', duplicate_of: assigned });
    assert.equal((await taskRow(copy)).duplicate_of, assigned);
    assert.ok((await call(token, 'close_tasks', { task_ids: [loose], reason: 'duplicate', duplicate_of: loose })).isError);
    assert.ok((await call(token, 'close_tasks', { task_ids: [loose, mineToo], reason: 'duplicate' })).isError);
    const unknown = await ok(token, 'close_tasks', { task_ids: [loose], reason: 'completed', credit: ['Nobody Unheardof'] });
    assert.equal(unknown.changed, false);
    assert.equal(unknown.missing[0].problem, 'nobody_by_that_name');
    assert.equal((await taskRow(loose)).closed_at, null);
  });

  test('join_task, add_comment with mentions and nudges, flag_task raise and resolve', async () => {
    const owner = await person('Khalfan');
    const me = await person('Ibrahim');
    const token = await connectApp(app, me, RETURN);
    const id = await addTask(owner, { title: 'Paint the lobby', assignees: [owner] });

    const joined = await ok(token, 'join_task', { task_id: id });
    assert.equal(joined.joined, true);
    assert.ok(joined.task.assignees.includes(me.name));
    assert.equal((await ok(token, 'join_task', { task_id: id })).already_on_it, true);

    const nudge = await ok(token, 'add_comment', { task_id: id, text: 'Any update on the paint?', mention: [owner.name], nudge: true });
    assert.equal(nudge.posted, true);
    assert.ok(nudge.text.startsWith(`@${owner.name} `));
    assert.ok((await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND task_id = $2 AND kind = 'mentioned'`, [owner.id, id])).rows[0]);
    assert.ok((await q(`SELECT 1 FROM audit_events WHERE task_id = $1 AND action = 'task.commented' AND details->>'nudge' = 'true'`, [id])).rows[0]);
    const second = await ok(token, 'add_comment', { task_id: id, text: 'And now?', mention: [owner.name], nudge: true });
    assert.equal(second.posted, false);
    assert.ok(second.nudge_limit);
    assert.equal((await ok(token, 'add_comment', { task_id: id, text: 'Hello', mention: ['Nobody Unheardof'] })).posted, false);
    assert.ok((await call(token, 'add_comment', { task_id: id, text: 'Hurry', nudge: true })).isError);

    const raised = await ok(token, 'flag_task', { action: 'raise', task_id: id, reason: 'wrong', note: 'Wrong floor' });
    assert.ok(raised.flag_id);
    const refused = await call(token, 'flag_task', { action: 'resolve', task_id: id, resolution: 'fixed' });
    assert.ok(refused.isError);
    assert.match(refused.content[0].text, /Not allowed/);
    const ownerToken = await connectApp(app, owner, RETURN);
    assert.equal((await ok(ownerToken, 'flag_task', { action: 'resolve', task_id: id, resolution: 'fixed' })).flag_id, raised.flag_id);
    assert.equal((await ok(ownerToken, 'flag_task', { action: 'resolve', task_id: id, resolution: 'dismissed' })).problem, 'no_open_flags');

    const closedId = await addTask(owner, { title: 'Already done' });
    await q(`UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = 'notneeded' WHERE id = $1`, [closedId, owner.id]);
    const late = await call(token, 'join_task', { task_id: closedId });
    assert.ok(late.isError);
    assert.match(late.content[0].text, /closed/);
  });

  test('undo also takes back added tasks within a minute', async () => {
    const me = await person('Muna');
    const token = await connectApp(app, me, RETURN);
    const added = await ok(token, 'create_tasks', { tasks: [{ title: 'Typed by accident' }] });
    const undo = await ok(token, 'undo', { batch: added.batch });
    assert.equal(undo.kind, 'added_tasks');
    assert.deepEqual(undo.undone, [added.tasks[0].id]);
    assert.equal((await taskRow(added.tasks[0].id)).close_reason, 'mistake');
  });
});

describe('connector tools: limits', () => {
  test('calls with a valid token are limited per person, not by address', async () => {
    const me = await person('Zayed');
    const token = await connectApp(app, me, RETURN);
    await resetLimits();
    const anon = await request(app).post('/connector').send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(anon.status, 401);
    const { key } = (await q(`SELECT key FROM rate_limits WHERE key LIKE 'connector-ip:%'`)).rows[0];
    await q('UPDATE rate_limits SET count = $2 WHERE key = $1', [key, IP_LIMIT]);
    assert.equal((await request(app).post('/connector').send({ jsonrpc: '2.0', id: 2, method: 'ping' })).status, 429);
    assert.equal((await request(app).post('/connector').set('Authorization', `Bearer ${'x'.repeat(43)}`).send({ jsonrpc: '2.0', id: 3, method: 'ping' })).status, 429);
    assert.equal((await rpc(token, 'ping', {})).status, 200);
    await q('UPDATE rate_limits SET count = $2 WHERE key = $1', [`connector:${me.id}`, PERSON_LIMIT]);
    assert.equal((await rpc(token, 'ping', {})).status, 429);
  });
});
