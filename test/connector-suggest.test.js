import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { translator } from '../src/i18n.js';
import { connectApp, createUser, csrfIn, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

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
  return createUser({ name: `${first} Suggester${seq}`, email: `${first.toLowerCase()}.s${seq}@example.com`, ...extra });
}
async function addTask(creator, { title, description = '', status = 'todo', priority = 'med', assignees = [], labels = [], closed = false } = {}) {
  const { rows } = await q(
    `INSERT INTO tasks (title, description, status, priority, creator_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [title, description, status, priority, creator.id],
  );
  const { id } = rows[0];
  for (const u of assignees) await q('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)', [id, u.id]);
  for (const l of labels) await q('INSERT INTO task_labels (task_id, label_id) VALUES ($1, $2)', [id, l]);
  if (closed) {
    await q(`UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = 'completed' WHERE id = $1`, [id, creator.id]);
    for (const u of assignees) await q('INSERT INTO task_credits (task_id, user_id) VALUES ($1, $2)', [id, u.id]);
  }
  return id;
}
const taskRow = async (id) => (await q('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
const DESIGN = 9;
const DOCS = 6;

describe('connector: skills and suggestions', () => {
  test('set_my_skills adds, removes and replaces, ignoring case; get_team shows them', async () => {
    const me = await person('Aisha');
    const token = await connectApp(app, me, RETURN);
    assert.deepEqual((await ok(token, 'set_my_skills', { skills: ['Figma', 'React'] })).your_skills, ['Figma', 'React']);
    assert.deepEqual((await ok(token, 'set_my_skills', { skills: ['figma', 'Excel'] })).your_skills, ['Figma', 'React', 'Excel']);
    assert.deepEqual((await ok(token, 'set_my_skills', { skills: ['react'], mode: 'remove' })).your_skills, ['Figma', 'Excel']);
    assert.deepEqual((await ok(token, 'get_team')).your_skills, ['Figma', 'Excel']);
    assert.deepEqual((await ok(token, 'set_my_skills', { skills: ['Arabic copywriting'], mode: 'replace' })).your_skills, ['Arabic copywriting']);
    const many = Array.from({ length: 20 }, (_, i) => `Skill ${i}`);
    assert.ok((await call(token, 'set_my_skills', { skills: many })).isError);
  });

  test('suggest_tasks ranks open tasks by fit, with reasons and what is unknown, and leaves out tasks I am on', async () => {
    const me = await person('Noor');
    const other = await person('Salim');
    const token = await connectApp(app, me, RETURN);
    const without = await ok(token, 'suggest_tasks', {});
    assert.equal(without.skills_saved, false);
    await ok(token, 'set_my_skills', { skills: ['Figma'] });
    await addTask(other, { title: 'Old poster', assignees: [me], labels: [DESIGN], closed: true });
    const plain = await addTask(other, { title: 'Count the chairs in the hall' });
    const fits = await addTask(other, { title: 'Redraw the onboarding screens', description: 'Use the Figma file', labels: [DESIGN] });
    const team = await addTask(other, { title: 'Move the archive room', assignees: [other] });
    await q('UPDATE tasks SET team_task = true WHERE id = $1', [team]);
    const mine = await addTask(other, { title: 'Already mine', assignees: [me] });

    const out = await ok(token, 'suggest_tasks', { limit: 10 });
    assert.equal(out.skills_saved, true);
    assert.deepEqual(out.your_skills, ['Figma']);
    assert.deepEqual(out.your_recent_labels, ['Design']);
    const ids = out.candidates.map((c) => c.id);
    assert.ok(!ids.includes(mine));
    assert.ok(ids.indexOf(fits) < ids.indexOf(team) && ids.indexOf(team) < ids.indexOf(plain), JSON.stringify(ids));
    const top = out.candidates.find((c) => c.id === fits);
    assert.deepEqual(top.why.skills, ['Figma']);
    assert.deepEqual(top.why.like_work_you_finished, ['Design']);
    assert.deepEqual(top.unknown, ['due_date']);
    const teamRow = out.candidates.find((c) => c.id === team);
    assert.equal(teamRow.why.team_task, true);
    assert.deepEqual(teamRow.why.others_on_it, [other.name]);
    assert.deepEqual(out.candidates.find((c) => c.id === plain).unknown, ['due_date', 'description']);
    assert.equal(out.your_in_progress, 0);
  });

  test('take_task joins and starts a task in one Undo, settles "No assignee" flags, and refuses closed tasks', async () => {
    const me = await person('Yara');
    const token = await connectApp(app, me, RETURN);
    const { tasks: [flagged] } = await ok(token, 'create_tasks', { tasks: [{ title: 'Unblock the gate', assignees: ['Nobody Unheardof'], started: true }] });
    const taken = await ok(token, 'take_task', { task_id: flagged.id });
    assert.equal(taken.taken, true);
    assert.deepEqual(taken.task.assignees, [me.name]);
    assert.equal(taken.task.flagged, false);

    const other = await person('Ghalib');
    const id = await addTask(other, { title: 'Sort the post' });
    const out = await ok(token, 'take_task', { task_id: id });
    assert.equal(out.task.status, 'in_progress');
    assert.deepEqual(out.task.assignees, [me.name]);
    const undo = await ok(token, 'undo', { batch: out.batch });
    assert.deepEqual(undo.undone, [id, id]);
    const row = await taskRow(id);
    assert.equal(row.status, 'todo');
    assert.equal((await q('SELECT count(*)::int AS n FROM task_assignees WHERE task_id = $1', [id])).rows[0].n, 0);

    await q(`UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = 'notneeded' WHERE id = $1`, [id, other.id]);
    const late = await call(token, 'take_task', { task_id: id });
    assert.ok(late.isError);
  });
});

describe('connector and website: reviewers', () => {
  test('sending a task for review tells the reviewer, who sees it waiting; undo puts the reviewer back', async () => {
    const me = await person('Huda');
    const reviewer = await person('Maryam');
    const nobody = (await q(`INSERT INTO users (name, role, status, email_notifications) VALUES ('Reviewless Person', 'member', 'active', false) RETURNING id`)).rows[0];
    const token = await connectApp(app, me, RETURN);
    const id = await addTask(me, { title: 'Quarterly report', status: 'progress', assignees: [me] });

    const noAccount = await ok(token, 'update_tasks', { task_ids: [id], reviewer: 'Reviewless Person' });
    assert.equal(noAccount.changed, false);
    assert.equal(noAccount.missing[0].problem, 'nobody_by_that_name');
    assert.ok(nobody.id);

    const sent = await ok(token, 'update_tasks', { task_ids: [id], status: 'review', reviewer: reviewer.name });
    assert.equal(sent.tasks[0].reviewer, reviewer.name);
    assert.equal(sent.tasks[0].status, 'review');
    const notes = (await q(`SELECT user_id FROM notifications WHERE task_id = $1 AND kind = 'review'`, [id])).rows.map((r) => r.user_id);
    assert.deepEqual(notes, [reviewer.id]);

    const reviewerToken = await connectApp(app, reviewer, RETURN);
    const work = await ok(reviewerToken, 'my_work');
    assert.deepEqual(work.waiting_for_your_review.map((t) => t.id), [id]);
    assert.deepEqual((await ok(token, 'my_work')).waiting_for_your_review, []);
    assert.deepEqual((await ok(token, 'search_tasks', { reviewer: reviewer.name })).tasks.map((t) => t.id), [id]);
    const history = (await ok(token, 'get_task', { task_id: id })).history.map((h) => h.text).join(' | ');
    assert.ok(history.includes(reviewer.name), history);

    const cleared = await ok(token, 'update_tasks', { task_ids: [id], reviewer: null });
    assert.equal(cleared.tasks[0].reviewer, undefined);
    await ok(token, 'undo', { batch: cleared.batch });
    assert.equal((await taskRow(id)).reviewer_id, reviewer.id);
  });

  test('website: the edit page sets a reviewer, the task page shows it, and moving to Review tells them', async () => {
    const owner = await person('Rawya');
    const reviewer = await person('Ilham');
    const id = await addTask(owner, { title: 'Brochure draft', assignees: [owner] });
    const agent = await signIn(app, owner);
    const page = await agent.get(`/tasks/${id}/edit`);
    assert.ok(page.text.includes('name="reviewer_id"'));
    assert.ok(page.text.includes(reviewer.name));
    const saved = await agent.post(`/tasks/${id}/edit`).type('form').send({
      _csrf: csrfIn(page.text), title: 'Brochure draft', description: '', priority: 'med', due_date: '', assignees: owner.id, reviewer_id: reviewer.id,
    });
    assert.equal(saved.status, 302);
    assert.equal((await taskRow(id)).reviewer_id, reviewer.id);
    assert.ok((await agent.get(`/tasks/${id}`)).text.includes(reviewer.name));
    const token = await tokenFor(agent, `/tasks/${id}`);
    await agent.post(`/tasks/${id}/move`).type('form').send({ _csrf: token, status: 'review' });
    const notes = (await q(`SELECT user_id FROM notifications WHERE task_id = $1 AND kind = 'review'`, [id])).rows.map((r) => r.user_id);
    assert.deepEqual(notes, [reviewer.id]);
    const bad = await agent.post(`/tasks/${id}/edit`).type('form').send({
      _csrf: csrfIn(page.text), title: 'Brochure draft', description: '', priority: 'med', due_date: '', reviewer_id: 'not-a-uuid',
    });
    assert.equal(bad.status, 400);
  });

  test('website: skills are saved from Settings, separated by English or Arabic commas', async () => {
    const me = await person('Sara');
    await q(`UPDATE users SET lang = 'ar' WHERE id = $1`, [me.id]);
    const agent = await signIn(app, me);
    const page = await agent.get('/settings');
    assert.ok(page.text.includes(translator('ar')('settings.skills')));
    const res = await agent.post('/settings/profile').type('form').send({ _csrf: csrfIn(page.text), name: me.name, lang: 'ar', skills: 'Figma, React، Excel, figma' });
    assert.equal(res.status, 302);
    assert.deepEqual((await q('SELECT skills FROM users WHERE id = $1', [me.id])).rows[0].skills, ['Figma', 'React', 'Excel']);
    assert.ok((await agent.get('/settings')).text.includes('Figma، React، Excel'));
  });
});

describe('connector: suggestion cards', () => {
  test('suggest_tasks and take_task results come with the card', async () => {
    const me = await person('Lamya');
    const token = await connectApp(app, me, RETURN);
    const res = await call(token, 'suggest_tasks', {});
    assert.equal(res._meta['mahamm/card'].tool, 'suggest_tasks');
    const id = await addTask(me, { title: 'Card take' });
    assert.equal((await call(token, 'take_task', { task_id: id }))._meta['mahamm/card'].tool, 'take_task');
  });
});
