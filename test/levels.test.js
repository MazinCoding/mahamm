import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from './helpers.js';
import { rememberDays } from '../src/devices.js';
import { canGrant, canManage, grantable } from '../src/roles.js';
import { connectApp, createUser, csrfIn, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
let app;
let owner; let ownerAgent;
let exec; let execAgent;
let admin; let adminAgent;
let member; let memberAgent;
let trainee; let traineeAgent;

before(async () => {
  ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN }));
  owner = await createUser({ name: 'Owner Levels', role: 'superadmin', twoFactor: true });
  exec = await createUser({ name: 'Exec Levels', role: 'executive', twoFactor: true });
  admin = await createUser({ name: 'Admin Levels', role: 'admin', twoFactor: true });
  member = await createUser({ name: 'Member Levels' });
  trainee = await createUser({ name: 'Trainee Levels', role: 'trainee' });
  ownerAgent = await signIn(app, owner);
  execAgent = await signIn(app, exec);
  adminAgent = await signIn(app, admin);
  memberAgent = await signIn(app, member);
  traineeAgent = await signIn(app, trainee);
});
after(teardown);
beforeEach(resetLimits);

const roleOf = async (id) => (await q('SELECT role FROM users WHERE id = $1', [id])).rows[0].role;
const statusOf = async (id) => (await q('SELECT status FROM users WHERE id = $1', [id])).rows[0].status;
let seq = 0;
const someone = (role = 'member') => {
  seq += 1;
  return createUser({ name: `Target Person${seq}`, role, twoFactor: ['admin', 'executive'].includes(role) });
};
const setLevel = (agent, id, role) => post(agent, `/people/${id}/role`, { role }, '/people');

describe('the level rules', () => {
  test('each level manages only the levels below it', () => {
    const at = (role) => ({ id: 'x', role });
    assert.deepEqual(grantable(at('superadmin')), ['trainee', 'member', 'admin', 'executive']);
    assert.deepEqual(grantable(at('executive')), ['trainee', 'member', 'admin']);
    assert.deepEqual(grantable(at('admin')), ['trainee', 'member']);
    assert.deepEqual(grantable(at('member')), []);
    assert.deepEqual(grantable(at('trainee')), []);
    assert.equal(canManage(at('admin'), 'admin'), false);
    assert.equal(canManage(at('executive'), 'admin'), true);
    assert.equal(canManage(at('executive'), 'superadmin'), false);
    assert.equal(canGrant(at('superadmin'), 'superadmin'), false);
  });

  test('admins and above get 30-day devices; members and trainees 90', () => {
    for (const r of ['admin', 'executive', 'superadmin']) assert.equal(rememberDays(r), 30, r);
    for (const r of ['member', 'trainee']) assert.equal(rememberDays(r), 90, r);
  });
});

describe('changing levels on the People page', () => {
  test('the superadmin makes an executive; the change is audited', async () => {
    const p = await someone();
    assert.equal((await setLevel(ownerAgent, p.id, 'executive')).status, 302);
    assert.equal(await roleOf(p.id), 'executive');
    const ev = (await q(`SELECT actor_id, details FROM audit_events WHERE action = 'user.role_changed' AND subject_user_id = $1`, [p.id])).rows[0];
    assert.equal(ev.actor_id, owner.id);
    assert.deepEqual({ from: ev.details.from, to: ev.details.to }, { from: 'member', to: 'executive' });
  });

  test('an executive makes admins but not executives', async () => {
    const p = await someone();
    await setLevel(execAgent, p.id, 'admin');
    assert.equal(await roleOf(p.id), 'admin');
    const res = await setLevel(execAgent, p.id, 'executive');
    assert.equal(res.status, 302);
    assert.equal(await roleOf(p.id), 'admin');
    const page = await execAgent.get('/people');
    assert.match(page.text, /only give levels below your own/);
  });

  test('an admin can make members and trainees, but not admins', async () => {
    const p = await someone();
    await setLevel(adminAgent, p.id, 'trainee');
    assert.equal(await roleOf(p.id), 'trainee');
    await setLevel(adminAgent, p.id, 'admin');
    assert.equal(await roleOf(p.id), 'trainee');
  });

  test('nobody acts on people at or above their own level', async () => {
    const otherAdmin = await someone('admin');
    await setLevel(adminAgent, otherAdmin.id, 'member');
    assert.equal(await roleOf(otherAdmin.id), 'admin', 'admin cannot demote another admin');
    await setLevel(adminAgent, exec.id, 'member');
    assert.equal(await roleOf(exec.id), 'executive', 'admin cannot demote an executive');
    await setLevel(execAgent, owner.id, 'member');
    assert.equal(await roleOf(owner.id), 'superadmin', 'nobody can demote the superadmin');

    await post(adminAgent, `/people/${exec.id}/status`, { status: 'disabled' }, '/people');
    assert.equal(await statusOf(exec.id), 'active', 'admin cannot disable an executive');
    await post(execAgent, `/people/${owner.id}/status`, { status: 'disabled' }, '/people');
    assert.equal(await statusOf(owner.id), 'active', 'nobody can disable the superadmin');

    const reset = await post(adminAgent, `/people/${exec.id}/reset-link`, {}, '/people');
    assert.equal(reset.status, 302, 'no reset link for someone above you');
    assert.equal((await q('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1', [exec.id])).rows[0].n, 0);
    assert.equal((await post(execAgent, `/people/${admin.id}/reset-link`, {}, '/people')).status, 200, 'an executive can make one for an admin');
  });

  test('the database allows one superadmin only, never without an account', async () => {
    await assert.rejects(q(`UPDATE users SET role = 'superadmin' WHERE id = $1`, [member.id]));
    await assert.rejects(q(`INSERT INTO users (name, role, email_notifications) VALUES ('No Account Owner', 'superadmin', false)`));
  });

  test('members and trainees cannot change levels', async () => {
    const p = await someone();
    assert.equal((await setLevel(memberAgent, p.id, 'trainee')).status, 403);
    assert.equal((await setLevel(traineeAgent, p.id, 'trainee')).status, 403);
    assert.equal(await roleOf(p.id), 'member');
  });

  test('executives and the superadmin reach the admin pages and must use two-step', async () => {
    for (const agent of [ownerAgent, execAgent]) assert.equal((await agent.get('/people')).status, 200);
    const noTwoStep = await createUser({ name: 'Exec Without Code', role: 'executive' });
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: noTwoStep.email, password: 'correct-horse-battery-42' });
    const res = await agent.get('/people');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/settings/two-factor');
  });

  test('the People page shows levels in Arabic', async () => {
    await post(execAgent, '/lang', { lang: 'ar' }, '/people');
    const page = await execAgent.get('/people');
    assert.match(page.text, /تنفيذي/);
    assert.match(page.text, /متدرّب/);
    await post(execAgent, '/lang', { lang: 'en' }, '/people');
  });
});

describe('people without accounts', () => {
  test('get a level now, which their invite offers and their acceptance applies', async () => {
    const add = await post(ownerAgent, '/people/add', { name: 'Future Exec Person', role: 'executive' }, '/people');
    assert.equal(add.status, 302);
    const p = (await q(`SELECT * FROM users WHERE name = 'Future Exec Person'`)).rows[0];
    assert.equal(p.role, 'executive');
    assert.equal(p.email, null);
    const ev = (await q(`SELECT details FROM audit_events WHERE action = 'person.added' AND subject_user_id = $1`, [p.id])).rows[0];
    assert.equal(ev.details.role, 'executive');

    // An admin can't invite, rename or change someone above them.
    const inv = await post(adminAgent, `/people/${p.id}/invite`, { email: 'future.exec@example.com', role: 'member' }, '/people');
    assert.equal(inv.status, 302);
    assert.equal((await q('SELECT count(*)::int AS n FROM invites WHERE user_id = $1', [p.id])).rows[0].n, 0);
    await post(adminAgent, `/people/${p.id}/rename`, { name: 'Renamed By Admin' }, '/people');
    assert.equal((await q('SELECT name FROM users WHERE id = $1', [p.id])).rows[0].name, 'Future Exec Person');

    // The superadmin invites them as an executive.
    const ok = await post(ownerAgent, `/people/${p.id}/invite`, { email: 'future.exec@example.com', role: 'executive' }, '/people');
    assert.equal(ok.status, 200);
    const token = ok.text.match(/value="http:\/\/localhost:3000\/invite\/([^"]+)"/)[1];
    const guest = request.agent(app);
    const page = await guest.get(`/invite/${token}`);
    const res = await guest.post(`/invite/${token}`).type('form').send({ _csrf: csrfIn(page.text), name: 'Future Exec Person', password: 'correct-horse-battery-42', confirm: 'correct-horse-battery-42' });
    assert.equal(res.headers.location, '/settings/two-factor', 'executives set up two-step first');
    assert.equal(await roleOf(p.id), 'executive');
  });

  test('an admin can add trainees but not admins, and can set a level before they join', async () => {
    await post(adminAgent, '/people/add', { name: 'Trainee To Be', role: 'trainee' }, '/people');
    const t = (await q(`SELECT id, role FROM users WHERE name = 'Trainee To Be'`)).rows[0];
    assert.equal(t.role, 'trainee');
    await setLevel(adminAgent, t.id, 'member');
    assert.equal(await roleOf(t.id), 'member');
    const res = await post(adminAgent, '/people/add', { name: 'Admin To Be', role: 'admin' }, '/people');
    assert.equal(res.status, 403);
    assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE name = 'Admin To Be'`)).rows[0].n, 0);
  });

  test('admins can only invite at levels below their own', async () => {
    const res = await post(adminAgent, '/people/invite', { email: 'want.admin@example.com', role: 'admin' }, '/people');
    assert.equal(res.status, 302);
    assert.equal((await q(`SELECT count(*)::int AS n FROM invites WHERE email = 'want.admin@example.com'`)).rows[0].n, 0);
    assert.equal((await post(adminAgent, '/people/invite', { email: 'new.trainee@example.com', role: 'trainee' }, '/people')).status, 200);
  });
});

describe('trainees', () => {
  test('add tasks for themselves, but not for other people', async () => {
    const mine = await makeTask(traineeAgent, { title: 'Trainee own task', assignees: [trainee.id] });
    assert.ok(mine);
    await assert.rejects(makeTask(traineeAgent, { title: 'Trainee assigns member', assignees: [member.id] }), /403/);
    const form = await traineeAgent.get('/tasks/new');
    assert.doesNotMatch(form.text, new RegExp(`value="${member.id}"`), 'the picker shows only themselves');
    assert.match(form.text, /only add or take off yourself/);
  });

  test('editing keeps other people on the task and refuses adding anyone else', async () => {
    const id = await makeTask(memberAgent, { title: 'Shared with trainee', assignees: [member.id, trainee.id] });
    const page = await traineeAgent.get(`/tasks/${id}/edit`);
    const send = (assignees) => traineeAgent.post(`/tasks/${id}/edit`).type('form')
      .send({ _csrf: csrfIn(page.text), title: 'Shared with trainee', description: '', priority: 'med', due_date: '', assignees });
    // Their form only has themselves; unticking it leaves the member on the task.
    assert.equal((await send([])).status, 302);
    const after = (await q('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    assert.deepEqual(after, [member.id]);
    const other = await someone();
    assert.equal((await send([other.id])).status, 403);
  });

  test('the table ribbon assigns only themselves', async () => {
    const id = await makeTask(traineeAgent, { title: 'Ribbon trainee task', assignees: [trainee.id] });
    const res = await post(traineeAgent, '/tasks/bulk', { ids: [id], apply: 'assignee', assignee: member.id, back: '/table' }, '/table');
    assert.ok([302, 403].includes(res.status));
    const people = (await q('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    assert.deepEqual(people, [trainee.id]);
  });

  test('cannot close: Done moves the task to Review instead', async () => {
    const id = await makeTask(traineeAgent, { title: 'Trainee finished it', assignees: [trainee.id] });
    const close = await traineeAgent.get(`/tasks/${id}/close`);
    assert.equal(close.status, 302);
    assert.equal(close.headers.location, `/tasks/${id}`);
    const post1 = await post(traineeAgent, `/tasks/${id}/close`, { reason: 'completed', credited: trainee.id }, `/tasks/${id}`);
    assert.equal(post1.status, 403);
    assert.match(post1.text, /Trainees can’t close tasks/);
    const moved = await post(traineeAgent, `/tasks/${id}/move`, { status: 'done' }, `/tasks/${id}`);
    assert.equal(moved.status, 302);
    const task = (await q('SELECT status, closed_at FROM tasks WHERE id = $1', [id])).rows[0];
    assert.deepEqual({ status: task.status, closed: task.closed_at !== null }, { status: 'review', closed: false });
    const bulk = await post(traineeAgent, '/tasks/bulk/close', { ids: [id], reason: 'completed', credit: [trainee.id], back: '/table' }, '/table');
    assert.equal(bulk.status, 403);
    assert.equal((await q('SELECT closed_at FROM tasks WHERE id = $1', [id])).rows[0].closed_at, null);
    const show = await traineeAgent.get(`/tasks/${id}`);
    assert.doesNotMatch(show.text, new RegExp(`href="/tasks/${id}/close"`));
  });

  test('the same in Arabic', async () => {
    const id = await makeTask(traineeAgent, { title: 'مهمة المتدرب', assignees: [trainee.id] });
    await post(traineeAgent, '/lang', { lang: 'ar' }, '/board');
    const res = await post(traineeAgent, `/tasks/${id}/close`, { reason: 'completed', credited: trainee.id }, `/tasks/${id}`);
    assert.equal(res.status, 403);
    assert.match(res.text, /لا يستطيع المتدرّب إغلاق المهام/);
    await post(traineeAgent, '/lang', { lang: 'en' }, '/board');
  });

  test('through the connector: no closing and no assigning others', async () => {
    const token = await connectApp(app, trainee, RETURN);
    const call = async (name, args) => (await request(app).post('/connector').set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
    const id = await makeTask(traineeAgent, { title: 'Connector trainee task', assignees: [trainee.id] });
    const closed = await call('close_tasks', { task_ids: [id], reason: 'completed' });
    assert.equal(closed.isError, true);
    assert.match(closed.content[0].text, /Trainees can't close tasks/);
    const assigned = await call('update_tasks', { task_ids: [id], add_assignees: ['Member Levels'] });
    assert.equal(assigned.isError, true);
    assert.match(assigned.content[0].text, /only add or take off themselves/);
    const created = await call('create_tasks', { tasks: [{ title: 'Trainee names someone', assignees: ['Member Levels'] }] });
    assert.equal(created.isError, true);
    assert.equal((await q(`SELECT count(*)::int AS n FROM tasks WHERE title = 'Trainee names someone'`)).rows[0].n, 0);
    const review = await call('update_tasks', { task_ids: [id], status: 'review' });
    assert.ok(!review.isError, review.content?.[0]?.text);
  });

  test('members can still close and assign as before', async () => {
    const id = await makeTask(memberAgent, { title: 'Member closes it', assignees: [trainee.id] });
    const res = await post(memberAgent, `/tasks/${id}/close`, { reason: 'completed', credited: trainee.id }, `/tasks/${id}`);
    assert.equal(res.status, 302);
    assert.notEqual((await q('SELECT closed_at FROM tasks WHERE id = $1', [id])).rows[0].closed_at, null);
  });
});
