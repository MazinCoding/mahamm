import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { q } from '../src/db.js';
import { suggestedTasks } from '../src/services/tasks.js';
import { createUser, csrfIn, post, resetLimits, setup, signIn, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
let app;
let config;
before(async () => ({ app, config } = await setup({ OAUTH_REDIRECT_URIS: RETURN })));
after(teardown);
beforeEach(resetLimits);

// Connects `user` the way an outside app would and returns an access token.
async function tokenFor(user) {
  const agent = await signIn(app, user);
  const reg = await request(app).post('/oauth/register').send({ client_name: 'Test app', redirect_uris: [RETURN] });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const page = await agent.get(`/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: reg.body.client_id, redirect_uri: RETURN, code_challenge: challenge, code_challenge_method: 'S256', scope: 'tasks offline_access',
  })}`);
  const form = page.text.slice(page.text.indexOf('action="/oauth/authorize"'));
  const fields = Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
  const back = await agent.post('/oauth/authorize').type('form').send({ ...fields, decision: 'allow' });
  const code = new URL(back.headers.location).searchParams.get('code');
  const res = await request(app).post('/oauth/token').type('form')
    .send({ grant_type: 'authorization_code', client_id: reg.body.client_id, code, redirect_uri: RETURN, code_verifier: verifier });
  assert.equal(res.status, 200, res.text);
  return res.body.access_token;
}

let nextId = 1;
const rpc = (token, method, params) => request(app).post('/connector').set('Authorization', `Bearer ${token}`)
  .send({ jsonrpc: '2.0', id: nextId++, method, params });

async function call(token, name, args) {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.result, JSON.stringify(res.body));
  return res.body.result;
}

const taskRow = async (id) => (await q('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
const assigneeIds = async (id) => (await q('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
const openFlags = async (id) => (await q('SELECT * FROM flags WHERE task_id = $1 AND resolved_at IS NULL', [id])).rows;
const addPerson = async (name) => (await q(`INSERT INTO users (name, role, status, email_notifications) VALUES ($1, 'member', 'active', false) RETURNING id, name`, [name])).rows[0];

describe('connector: protocol', () => {
  test('without a token it asks the app to sign in, pointing at the metadata', async () => {
    const res = await request(app).post('/connector').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource"`);
    const meta = await request(app).get('/.well-known/oauth-protected-resource');
    assert.equal(meta.body.resource, config.oauth.resource);
    assert.deepEqual(meta.body.authorization_servers, [config.origin]);
    const bad = await request(app).post('/connector').set('Authorization', `Bearer ${'x'.repeat(43)}`).send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(bad.status, 401);
    assert.match(bad.headers['www-authenticate'], /error="invalid_token"/);
  });

  test('initialize, tools/list, notifications and unknown methods', async () => {
    const token = await tokenFor(await createUser());
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.ok(init.body.result.capabilities.tools);
    const odd = await rpc(token, 'initialize', { protocolVersion: '1999-01-01' });
    assert.equal(odd.body.result.protocolVersion, '2025-11-25');
    const list = await rpc(token, 'tools/list', {});
    assert.deepEqual(list.body.result.tools.map((t) => t.name), [
      'get_team', 'my_work', 'search_tasks', 'get_task', 'workload', 'get_activity',
      'create_tasks', 'update_tasks', 'close_tasks', 'join_task', 'add_comment', 'merge_tasks', 'flag_task', 'undo', 'mark_read',
      'open_board', 'suggest_tasks', 'take_task', 'set_my_skills', 'admin_change', 'confirm_preview', 'board_snapshot', 'cancel_preview',
    ]);
    const appOnly = list.body.result.tools.filter((t) => t._meta?.ui?.visibility?.length === 1 && t._meta.ui.visibility[0] === 'app');
    assert.deepEqual(appOnly.map((t) => t.name), ['confirm_preview', 'board_snapshot', 'cancel_preview']);
    for (const tool of list.body.result.tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
      assert.equal(tool.inputSchema.type, 'object', tool.name);
    }
    const note = await request(app).post('/connector').set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    const unknown = await rpc(token, 'resources/subscribe', {});
    assert.equal(unknown.body.error.code, -32601);
    const get = await request(app).get('/connector').set('Authorization', `Bearer ${token}`);
    assert.equal(get.status, 405);
  });

  test('requests from another website are refused', async () => {
    const token = await tokenFor(await createUser());
    const res = await request(app).post('/connector').set('Authorization', `Bearer ${token}`).set('Origin', 'https://evil.example.test')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.equal(res.status, 403);
  });

  test("get_team gives today's date in the team's time zone and everyone who can be assigned", async () => {
    const me = await createUser({ name: 'Mazin Al Saadi' });
    await addPerson('Khalfan Al Amri');
    const token = await tokenFor(me);
    const team = (await call(token, 'get_team', {})).structuredContent;
    assert.equal(team.you, 'Mazin Al Saadi');
    assert.match(team.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(team.timezone, 'Asia/Muscat');
    const khalfan = team.people.find((p) => p.name === 'Khalfan Al Amri');
    assert.equal(khalfan.has_account, false);
  });
});

describe('connector: creating tasks', () => {
  test('a named person is assigned, the speaker is only the creator, To do and Medium by default', async () => {
    const speaker = await createUser({ name: 'Speaker One' });
    const ahmed = await createUser({ name: 'Ahmed Al Balushi' });
    const token = await tokenFor(speaker);
    const result = await call(token, 'create_tasks', { source: 'voice', tasks: [{ title: 'Renew Al Noor vendor contract', assignees: ['Ahmed'], due_date: '2026-11-20' }] });
    assert.ok(!result.isError);
    const [task] = result.structuredContent.tasks;
    assert.equal(task.status, 'todo');
    assert.equal(task.priority, 'medium');
    assert.deepEqual(task.assignees, ['Ahmed Al Balushi']);
    assert.equal(task.due_date, '2026-11-20');
    assert.deepEqual(task.missing, []);
    const row = await taskRow(task.id);
    assert.equal(row.creator_id, speaker.id);
    assert.deepEqual(await assigneeIds(task.id), [ahmed.id]);
    const created = (await q("SELECT details FROM audit_events WHERE task_id = $1 AND action = 'task.created'", [task.id])).rows[0];
    assert.equal(created.details.via, 'connector');
    assert.equal(created.details.batch, result.structuredContent.batch);
    const notified = await q("SELECT 1 FROM notifications WHERE user_id = $1 AND task_id = $2 AND kind = 'assigned'", [ahmed.id, task.id]);
    assert.equal(notified.rowCount, 1);
  });

  test('"I started" is In progress and assigned to the speaker; priorities follow what was said', async () => {
    const speaker = await createUser();
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', {
      tasks: [
        { title: 'Collect contract scans', assign_to_me: true, started: true, priority: 'high' },
        { title: 'Tidy the shared drive', assign_to_me: true, priority: 'low' },
      ],
    });
    assert.equal(out.tasks[0].status, 'in_progress');
    assert.equal(out.tasks[0].priority, 'high');
    assert.equal(out.tasks[1].status, 'todo');
    assert.equal(out.tasks[1].priority, 'low');
    assert.deepEqual(await assigneeIds(out.tasks[0].id), [speaker.id]);
    assert.equal(out.tasks[0].flagged, false);
  });

  test('"we started" makes a team task that others see first among the same priority', async () => {
    const speaker = await createUser();
    const other = await createUser();
    const older = await createUser();
    const olderAgent = await signIn(app, older);
    const page = await olderAgent.get('/home');
    await olderAgent.post('/tasks/mine').type('form').send({ _csrf: csrfIn(page.text), title: 'Someone else is on this' });
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', { tasks: [{ title: 'Move the archive room', assign_to_me: true, started: true, team_task: true }] });
    assert.equal(out.tasks[0].team_task, true);
    const { rows } = await suggestedTasks(other.id, { limit: 50 });
    const medium = rows.filter((t) => t.priority === 'med');
    assert.equal(medium[0].id, out.tasks[0].id);
    const agent = await signIn(app, other);
    const suggested = await agent.get('/suggested');
    assert.ok(suggested.text.includes('Team task'));
  });

  test('a name that matches nobody: To do stays unflagged, In progress is flagged with the suggestion', async () => {
    const speaker = await createUser();
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', {
      source: 'voice',
      tasks: [
        { title: 'Book the meeting room', assignees: ['Zakariya'] },
        { title: 'Count the stock', assignees: ['Zakariya'], started: true },
      ],
    });
    const [todo, doing] = out.tasks;
    assert.deepEqual(todo.assignees, []);
    assert.deepEqual(todo.missing, [{ heard: 'Zakariya', problem: 'nobody_by_that_name' }]);
    assert.equal(todo.flagged, false);
    assert.equal((await openFlags(todo.id)).length, 0);
    assert.equal(doing.flagged, true);
    const [flag] = await openFlags(doing.id);
    assert.equal(flag.reason, 'other');
    assert.equal(flag.note, 'No assignee. Suggested: Zakariya (mentioned in the voice note).');
    assert.equal(flag.flagged_by, speaker.id);
  });

  test('two people with the same name: created unassigned, both offered, and the answer settles the flag', async () => {
    const speaker = await createUser();
    await createUser({ name: 'Salim Al Harthi' });
    const salim2 = await createUser({ name: 'Salim Al Hinai' });
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', { tasks: [{ title: 'Fix the door lock', assignees: ['Salim'], started: true }] });
    const [task] = out.tasks;
    assert.deepEqual(task.assignees, []);
    assert.equal(task.missing[0].problem, 'several_people');
    assert.deepEqual(task.missing[0].could_be.sort(), ['Salim Al Harthi', 'Salim Al Hinai']);
    assert.equal((await openFlags(task.id)).length, 1);

    const updated = (await call(token, 'update_task', { task_id: task.id, add_assignees: ['Salim Al Hinai'] })).structuredContent;
    assert.deepEqual(updated.assignees, ['Salim Al Hinai']);
    assert.deepEqual(await assigneeIds(task.id), [salim2.id]);
    assert.equal((await openFlags(task.id)).length, 0);
    const resolved = (await q('SELECT resolution FROM flags WHERE task_id = $1', [task.id])).rows[0];
    assert.equal(resolved.resolution, 'fixed');
  });

  test('Arabic: titles stay as said, names match across spelling variants, the flag note is in Arabic', async () => {
    const speaker = await createUser();
    await q("UPDATE users SET lang = 'ar' WHERE id = $1", [speaker.id]);
    const person = await addPerson('أحمد البلوشي');
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', {
      source: 'voice',
      tasks: [
        { title: 'تجديد عقد المورد', assignees: ['احمد'] },
        { title: 'جرد المخزن', assignees: ['خلفان'], started: true },
      ],
    });
    assert.equal(out.tasks[0].title, 'تجديد عقد المورد');
    assert.deepEqual(await assigneeIds(out.tasks[0].id), [person.id]);
    const [flag] = await openFlags(out.tasks[1].id);
    assert.equal(flag.note, 'لا يوجد مكلّف. الاسم المقترح: خلفان (ورد في الرسالة الصوتية).');
  });

  test('bad input is reported back, nothing is created', async () => {
    const token = await tokenFor(await createUser());
    const before = (await q('SELECT count(*)::int AS n FROM tasks')).rows[0].n;
    const result = await call(token, 'create_tasks', { tasks: [{ title: '', due_date: 'next week' }] });
    assert.equal(result.isError, true);
    assert.equal((await q('SELECT count(*)::int AS n FROM tasks')).rows[0].n, before);
  });
});

describe('connector: undo and follow-up changes', () => {
  test('undo within a minute closes the tasks as created by mistake and settles their flags', async () => {
    const speaker = await createUser();
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', { tasks: [{ title: 'Oops one', started: true }, { title: 'Oops two' }] });
    const undo = (await call(token, 'undo_created_tasks', { batch: out.batch })).structuredContent;
    assert.deepEqual(undo.undone.sort(), out.tasks.map((t) => t.id).sort());
    for (const t of out.tasks) {
      const row = await taskRow(t.id);
      assert.equal(row.close_reason, 'mistake');
      assert.equal((await openFlags(t.id)).length, 0);
    }
    const closed = (await q("SELECT details FROM audit_events WHERE task_id = $1 AND action = 'task.closed'", [out.tasks[0].id])).rows[0];
    assert.equal(closed.details.undo_of, out.batch);
  });

  test('undo is refused for someone else, after a minute, and for tasks changed since', async () => {
    const speaker = await createUser();
    const token = await tokenFor(speaker);
    const { structuredContent: out } = await call(token, 'create_tasks', { tasks: [{ title: 'Keep me' }, { title: 'Joined by someone' }] });

    const otherToken = await tokenFor(await createUser());
    const notYours = await call(otherToken, 'undo_created_tasks', { batch: out.batch });
    assert.equal(notYours.isError, true);

    const joiner = await signIn(app, await createUser());
    await post(joiner, `/tasks/${out.tasks[1].id}/join`, { back: '/home' }, '/home');
    const undo = (await call(token, 'undo_created_tasks', { batch: out.batch })).structuredContent;
    assert.deepEqual(undo.undone, [out.tasks[0].id]);
    assert.deepEqual(undo.changed, [out.tasks[1].id]);
    assert.equal((await taskRow(out.tasks[1].id)).closed_at, null);

    // An older capture (its entry is backdated two minutes) can no longer be undone.
    const { structuredContent: late } = await call(token, 'create_tasks', { tasks: [{ title: 'Too late' }] });
    const oldBatch = randomUUID();
    await q(`INSERT INTO audit_events (at, actor_id, action, task_id, details) VALUES (now() - interval '2 minutes', $1, 'task.created', $2, $3)`,
      [speaker.id, late.tasks[0].id, JSON.stringify({ batch: oldBatch })]);
    const expired = await call(token, 'undo_created_tasks', { batch: oldBatch });
    assert.equal(expired.isError, true);
  });

  test('status is open to everyone; other details need edit rights', async () => {
    const creator = await createUser();
    const outsider = await createUser();
    const creatorToken = await tokenFor(creator);
    const { structuredContent: out } = await call(creatorToken, 'create_tasks', { tasks: [{ title: 'Shared thing' }] });
    const id = out.tasks[0].id;
    const outsiderToken = await tokenFor(outsider);
    const denied = await call(outsiderToken, 'update_task', { task_id: id, priority: 'high' });
    assert.equal(denied.isError, true);
    assert.equal((await taskRow(id)).priority, 'med');
    const moved = (await call(outsiderToken, 'update_task', { task_id: id, status: 'in_progress' })).structuredContent;
    assert.equal(moved.status, 'in_progress');
    const missing = await call(outsiderToken, 'update_task', { task_id: 999999, status: 'review' });
    assert.equal(missing.isError, true);
  });
});

describe('team tasks on the website', () => {
  test('the edit form turns a team task on and off, recorded in the history', async () => {
    const user = await createUser();
    const agent = await signIn(app, user);
    const page = await agent.get('/home');
    const res = await agent.post('/tasks/mine').type('form').send({ _csrf: csrfIn(page.text), title: 'Paint the office' });
    const id = Number(new URL(res.headers.location, 'http://x').searchParams.get('added'));
    const edit = await agent.get(`/tasks/${id}/edit`);
    assert.ok(edit.text.includes('name="team_task"'));
    const save = (teamTask) => agent.post(`/tasks/${id}/edit`).type('form').send({
      _csrf: csrfIn(edit.text), title: 'Paint the office', description: '', priority: 'med', due_date: '', assignees: user.id, ...(teamTask ? { team_task: 'on' } : {}),
    });
    await save(true);
    assert.equal((await taskRow(id)).team_task, true);
    const shown = await agent.get(`/tasks/${id}`);
    assert.ok(shown.text.includes('made a team task'));
    await save(false);
    assert.equal((await taskRow(id)).team_task, false);
  });
});
