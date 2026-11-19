import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { alike } from '../src/services/matches.js';
import { connectApp, createUser, csrfIn, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
let app;
let aisha; let said;
let aishaAgent; let saidAgent;

before(async () => {
  ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN }));
  aisha = await createUser({ name: 'Aisha Al-Matcher' });
  said = await createUser({ name: 'Said Al-Matcher' });
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);
});
after(teardown);
beforeEach(resetLimits);

const taskRow = async (id) => (await q('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
const peopleOn = async (id) => (await q('SELECT user_id FROM task_assignees WHERE task_id = $1 ORDER BY user_id', [id])).rows.map((r) => r.user_id);
const flagsOn = async (id) => (await q('SELECT id, reason, note, resolved_at, resolution FROM flags WHERE task_id = $1 ORDER BY id', [id])).rows;
const commentsOn = async (id) => (await q('SELECT body FROM comments WHERE task_id = $1 ORDER BY id', [id])).rows.map((r) => r.body);
const closeAgo = (id, days, reason = 'completed') => q(
  `UPDATE tasks SET closed_at = now() - make_interval(days => $2), closed_by = creator_id, close_reason = $3 WHERE id = $1`,
  [id, days, reason],
);

describe('close matches: how alike titles are', () => {
  test('nearly the same words count; a different object, one-word titles and loose overlaps do not', () => {
    assert.equal(alike('Renew the office internet contract', 'Renew internet contract for the office'), 1);
    assert.equal(alike('Order printer toner', 'Order toner for the printer'), 1);
    assert.ok(alike('Ahmed fix printer', 'Ahmed fix laptop') < 0.75);
    assert.equal(alike('Printer', 'Printer'), 0);
    assert.ok(alike('Office internet router replacement', 'Renew the office internet contract') < 0.75);
    assert.ok(alike('تجديد عقد الإنترنت', 'تجديد عقد الانترنت للمكتب') >= 0.75);
  });
});

describe('close matches on the website', () => {
  test('a task like an older one is still added, flagged, and shows the older task with Merge', async () => {
    const older = await makeTask(aishaAgent, { title: 'Renew the office internet contract', assignees: [said.id] });
    const newer = await makeTask(aishaAgent, { title: 'Renew internet contract for the office', assignees: [aisha.id] });
    assert.ok(newer > older);
    const [flag] = await flagsOn(newer);
    assert.equal(flag.reason, 'duplicate');
    assert.ok(flag.note.includes(`#${older}`));
    assert.deepEqual(await flagsOn(older), [], 'the older task is never flagged by a newer one');

    const mine = await aishaAgent.get(`/tasks/${newer}`);
    assert.ok(mine.text.includes('Close match'));
    assert.ok(mine.text.includes(`Merge into #${older}`));
    assert.ok(mine.text.includes('Not the same'));
    assert.ok(mine.text.includes(`/tasks/${older}`));

    const theirs = await saidAgent.get(`/tasks/${newer}`);
    assert.ok(theirs.text.includes('Close match'));
    assert.ok(!theirs.text.includes(`Merge into #${older}`));
    assert.ok(theirs.text.includes('can merge it or mark it as not the same'));
    const refused = await post(saidAgent, `/tasks/${newer}/merge`, {}, `/tasks/${newer}`);
    assert.equal(refused.status, 403);
    assert.equal((await taskRow(newer)).closed_at, null);
  });

  test('Merge closes the newer task as a duplicate, moves its people and details over, and Undo takes it all back', async () => {
    const older = await makeTask(aishaAgent, { title: 'Book the meeting room for Thursday', assignees: [said.id] });
    const newer = await makeTask(aishaAgent, {
      title: 'Book meeting room Thursday', assignees: [aisha.id], description: 'Projector too', due_date: '2026-12-03',
    });
    const res = await post(aishaAgent, `/tasks/${newer}/merge`, {}, `/tasks/${newer}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `/tasks/${older}`);

    const closed = await taskRow(newer);
    assert.ok(closed.closed_at);
    assert.equal(closed.close_reason, 'duplicate');
    assert.equal(closed.duplicate_of, older);
    assert.ok((await flagsOn(newer)).every((f) => f.resolved_at));
    assert.deepEqual(await peopleOn(older), [aisha.id, said.id].sort());
    const [note] = await commentsOn(older);
    assert.ok(note.startsWith(`Merged #${newer} into this task: Book meeting room Thursday`));
    assert.ok(note.includes('Projector too'));
    assert.ok(note.includes('2026-12-03'));

    const page = await aishaAgent.get(`/tasks/${older}`);
    assert.ok(page.text.includes(`Merged #${newer} into #${older}.`));
    const batch = page.text.match(/name="batch" value="([0-9a-f-]{36})"/)[1];
    const undo = await aishaAgent.post('/tasks/bulk/undo').type('form').send({ _csrf: csrfIn(page.text), batch, back: `/tasks/${older}` });
    assert.equal(undo.headers.location, `/tasks/${older}`);

    const back = await taskRow(newer);
    assert.equal(back.closed_at, null);
    assert.equal(back.duplicate_of, null);
    assert.deepEqual(await peopleOn(older), [said.id]);
    assert.ok((await flagsOn(newer)).some((f) => f.reason === 'duplicate' && !f.resolved_at), 'the close match is open again');
    assert.equal((await commentsOn(older)).at(-1), `Undid merging #${newer} into this task.`);
    assert.ok((await aishaAgent.get(`/tasks/${newer}`)).text.includes(`Merge into #${older}`));
  });

  test('Not the same keeps both and the box goes away', async () => {
    const older = await makeTask(aishaAgent, { title: 'Clean the storage room shelves' });
    const newer = await makeTask(aishaAgent, { title: 'Clean storage room shelves' });
    const [flag] = await flagsOn(newer);
    await post(aishaAgent, `/tasks/${newer}/flags/${flag.id}/resolve`, { resolution: 'dismissed' }, `/tasks/${newer}`);
    assert.equal((await flagsOn(newer))[0].resolution, 'dismissed');
    const page = await aishaAgent.get(`/tasks/${newer}`);
    assert.ok(!page.text.includes(`Merge into #${older}`));
    assert.equal((await taskRow(newer)).closed_at, null);
    assert.equal((await taskRow(older)).closed_at, null);
  });

  test('only tasks open or closed in the last seven days count, never one closed as a mistake', async () => {
    const stale = await makeTask(aishaAgent, { title: 'Fix the lobby air conditioner' });
    await closeAgo(stale, 8);
    const afterStale = await makeTask(aishaAgent, { title: 'Fix lobby air conditioner' });
    assert.deepEqual(await flagsOn(afterStale), []);

    const mistake = await makeTask(aishaAgent, { title: 'Order the new office chairs' });
    await closeAgo(mistake, 0, 'mistake');
    const afterMistake = await makeTask(aishaAgent, { title: 'Order new office chairs' });
    assert.deepEqual(await flagsOn(afterMistake), []);

    const recent = await makeTask(aishaAgent, { title: 'Replace the kitchen water filter', assignees: [said.id] });
    await closeAgo(recent, 2);
    const afterRecent = await makeTask(aishaAgent, { title: 'Replace kitchen water filter', assignees: [aisha.id] });
    assert.equal((await flagsOn(afterRecent))[0].reason, 'duplicate');
    // Merging into a closed task adds nobody to it and leaves it closed.
    await post(aishaAgent, `/tasks/${afterRecent}/merge`, {}, `/tasks/${afterRecent}`);
    assert.equal((await taskRow(afterRecent)).duplicate_of, recent);
    assert.ok((await taskRow(recent)).closed_at);
    assert.deepEqual(await peopleOn(recent), [said.id]);
    assert.ok((await commentsOn(recent))[0].includes(`#${afterRecent}`));
  });

  test('quick add and the Home box say when a new task looks like an older one', async () => {
    const older = await makeTask(aishaAgent, { title: 'Print the visitor badges' });
    await post(aishaAgent, '/tasks/quick', { title: 'Print visitor badges', status: 'todo', back: '/table' }, '/table');
    const table = await aishaAgent.get('/table');
    assert.match(table.text, new RegExp(`It looks like #${older}: open #\\d+ to merge them or keep both`));

    const home = await aishaAgent.get('/home');
    await aishaAgent.post('/tasks/mine').type('form').send({ _csrf: csrfIn(home.text), title: 'Print visitor badges again' });
    assert.match((await aishaAgent.get('/home')).text, /It looks like #\d+: open #\d+ to merge them/);

    await post(aishaAgent, '/tasks/quick', { title: 'Water the plants', status: 'todo', back: '/table' }, '/table');
    assert.ok(!(await aishaAgent.get('/table')).text.includes('It looks like'));
  });
});

describe('close matches through the connector', () => {
  let nextId = 1;
  async function call(token, name, args = {}) {
    const res = await request(app).post('/connector').set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(res.status, 200, res.text);
    return res.body.result;
  }
  async function ok(token, name, args = {}) {
    const result = await call(token, name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent;
  }

  test('a close match comes back in full; merge_tasks merges, Undo takes it back, and only the creator may', async () => {
    const me = await createUser({ name: 'Hilal Connector' });
    const other = await createUser({ name: 'Nasra Connector' });
    const token = await connectApp(app, me, RETURN);
    const otherToken = await connectApp(app, other, RETURN);

    const first = (await ok(token, 'create_tasks', { tasks: [{ title: 'Collect the courier parcels', assignees: ['Nasra Connector'] }] })).tasks[0];
    assert.equal(first.close_match, undefined);
    const second = (await ok(token, 'create_tasks', { tasks: [{ title: 'Collect courier parcels', assign_to_me: true }] })).tasks[0];
    assert.equal(second.close_match.task.id, first.id);
    assert.ok(second.close_match.flag_id);

    assert.equal((await ok(token, 'get_task', { task_id: second.id })).close_match.task.id, first.id);
    const refused = await call(otherToken, 'merge_tasks', { task_id: second.id });
    assert.ok(refused.isError);
    assert.match(refused.content[0].text, /Only whoever added/);

    const merged = await ok(token, 'merge_tasks', { task_id: second.id });
    assert.deepEqual([merged.merged, merged.from, merged.into, merged.task.id], [true, second.id, first.id, first.id]);
    assert.deepEqual(merged.added, ['Hilal Connector']);
    assert.equal((await taskRow(second.id)).duplicate_of, first.id);
    assert.ok((await commentsOn(first.id))[0].startsWith(`Merged #${second.id} into this task`));

    const undone = await ok(token, 'undo', { batch: merged.batch });
    assert.equal(undone.kind, 'changes');
    assert.equal((await taskRow(second.id)).closed_at, null);
    assert.equal((await ok(token, 'get_task', { task_id: second.id })).close_match.task.id, first.id);

    await ok(token, 'flag_task', { action: 'resolve', task_id: second.id, flag_id: second.close_match.flag_id, resolution: 'dismissed' });
    assert.equal((await ok(token, 'get_task', { task_id: second.id })).close_match, null);
    const nothing = await call(token, 'merge_tasks', { task_id: second.id });
    assert.ok(nothing.isError);
    assert.match(nothing.content[0].text, /no close match/);
  });

  test('tasks added together are not matched with each other', async () => {
    const me = await createUser({ name: 'Talal Connector' });
    const token = await connectApp(app, me, RETURN);
    const out = await ok(token, 'create_tasks', { tasks: [
      { title: 'Sweep the rooftop terrace', assign_to_me: true },
      { title: 'Sweep rooftop terrace', assign_to_me: true },
    ] });
    assert.equal(out.tasks[0].close_match, undefined);
    assert.equal(out.tasks[1].close_match, undefined);
  });
});
