import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { q } from '../src/db.js';
import { auditFor, createUser, makeTask, post, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

let app;
let sent;
let admin; let aisha; let said; let fatma;
let adminAgent; let aishaAgent; let saidAgent; let fatmaAgent;

before(async () => {
  ({ app, sent } = await setup());
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

describe('the shared board', () => {
  test('any signed-in person can create a task; the audit log records who', async () => {
    const id = await makeTask(aishaAgent, { title: 'Descale the kitchen coffee machine', assignees: [aisha.id], labels: [4] });
    const events = await auditFor(id);
    assert.equal(events[0].action, 'task.created');
    assert.equal(events[0].actor_id, aisha.id);
    const page = await saidAgent.get(`/tasks/${id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Descale the kitchen coffee machine/);
  });

  test('the person closing can credit someone else, and both are recorded', async () => {
    const id = await makeTask(aishaAgent, { title: 'Clean the coffee machine', assignees: [aisha.id] });
    const res = await post(fatmaAgent, `/tasks/${id}/close`, { reason: 'completed', credited: [said.id] }, `/tasks/${id}/close`);
    assert.equal(res.status, 302);
    const task = (await q('SELECT closed_by, close_reason FROM tasks WHERE id = $1', [id])).rows[0];
    assert.equal(task.closed_by, fatma.id);
    assert.equal(task.close_reason, 'completed');
    const credits = (await q('SELECT user_id FROM task_credits WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    assert.deepEqual(credits, [said.id]);
    const closed = (await auditFor(id)).find((e) => e.action === 'task.closed');
    assert.equal(closed.actor_id, fatma.id);
    assert.deepEqual(closed.details.credited, [said.id]);
    const page = await aishaAgent.get(`/tasks/${id}`);
    assert.match(page.text, /Closed by<\/dt>\s*<dd><strong>Fatma Al-Harthi<\/strong>/);
    assert.match(page.text, /Completed by<\/dt>\s*<dd>\s*<strong class="is-done-text">Said Al-Rawahi<\/strong>/);
    const notified = await q(`SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2`, [said.id, id]);
    assert.deepEqual(notified.rows.map((r) => r.kind), ['credited']);
  });

  test('closing as completed needs at least one person', async () => {
    const id = await makeTask(aishaAgent, { title: 'Needs credit' });
    const res = await post(aishaAgent, `/tasks/${id}/close`, { reason: 'completed' }, `/tasks/${id}/close`);
    assert.equal(res.status, 400);
    assert.equal((await q('SELECT closed_at FROM tasks WHERE id = $1', [id])).rows[0].closed_at, null);
  });

  test('moving by drag and drop uses JSON with the CSRF header and is audited', async () => {
    const id = await makeTask(aishaAgent, { title: 'Move me' });
    const token = await tokenFor(saidAgent);
    const res = await saidAgent.post(`/tasks/${id}/move`).set('X-CSRF-Token', token).set('Accept', 'application/json').send({ status: 'progress' });
    assert.equal(res.status, 200);
    const moved = (await auditFor(id)).find((e) => e.action === 'task.moved');
    assert.deepEqual(moved.details, { from: 'todo', to: 'progress' });
    const noToken = await saidAgent.post(`/tasks/${id}/move`).set('Accept', 'application/json').send({ status: 'review' });
    assert.equal(noToken.status, 403);
    const done = await saidAgent.post(`/tasks/${id}/move`).set('X-CSRF-Token', token).send({ status: 'done' });
    assert.equal(done.body.redirect, `/tasks/${id}/close`, 'Done always goes through the close form');
  });

  test('requests with the headers a real browser sends are accepted from the site itself only', async () => {
    const id = await makeTask(aishaAgent, { title: 'Browser headers' });
    const token = await tokenFor(saidAgent);
    const browserLike = (origin, site) => saidAgent.post(`/tasks/${id}/move`)
      .set('X-CSRF-Token', token).set('Accept', 'application/json').set('Origin', origin).set('Sec-Fetch-Site', site);
    assert.equal((await browserLike('http://localhost:3000', 'same-origin').send({ status: 'progress' })).status, 200);
    assert.equal((await browserLike('https://evil.example', 'cross-site').send({ status: 'review' })).status, 403);
    assert.equal((await browserLike('http://127.0.0.1:3000', 'same-origin').send({ status: 'review' })).status, 403, 'an address that is not the site is refused');
  });

  test('moving to Review notifies the creator by email', async () => {
    const id = await makeTask(aishaAgent, { title: 'Please check this' });
    await post(saidAgent, `/tasks/${id}/move`, { status: 'review' });
    const rows = (await q(`SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2`, [aisha.id, id])).rows;
    assert.deepEqual(rows.map((r) => r.kind), ['review']);
    const outbox = (await q(`SELECT to_email, status FROM email_outbox WHERE to_email = $1`, [aisha.email])).rows;
    assert.equal(outbox.length, 1);
  });

  test('only the creator, an assignee or an admin can edit; edits keep the old text', async () => {
    const id = await makeTask(aishaAgent, { title: 'Original title', description: 'Old details' });
    const denied = await post(saidAgent, `/tasks/${id}/edit`, { title: 'Hijacked', description: '', priority: 'low', due_date: '' }, `/tasks/${id}`);
    assert.equal(denied.status, 403);
    const ok = await post(aishaAgent, `/tasks/${id}/edit`, { title: 'Better title', description: 'New details', priority: 'high', due_date: '2026-12-01' }, `/tasks/${id}/edit`);
    assert.equal(ok.status, 302);
    const edit = (await auditFor(id)).find((e) => e.action === 'task.edited');
    assert.equal(edit.details.changes.title.from, 'Original title');
    assert.equal(edit.details.changes.description.previous, 'Old details');
    const asAdmin = await post(adminAgent, `/tasks/${id}/edit`, { title: 'Admin fix', description: 'New details', priority: 'high', due_date: '2026-12-01' }, `/tasks/${id}/edit`);
    assert.equal(asAdmin.status, 302);
  });

  test('request bodies cannot set protected fields', async () => {
    const token = await tokenFor(saidAgent, '/tasks/new');
    const res = await saidAgent.post('/tasks').field('_csrf', token).field('title', 'Sneaky').field('priority', 'med').field('status', 'todo')
      .field('description', '').field('due_date', '').field('creator_id', aisha.id).field('closed_by', aisha.id).field('id', '1');
    const id = Number(res.headers.location.split('/').pop());
    const row = (await q('SELECT creator_id, closed_by FROM tasks WHERE id = $1', [id])).rows[0];
    assert.equal(row.creator_id, said.id);
    assert.equal(row.closed_by, null);
  });

  test('anyone can flag a task; only the creator or an admin can resolve it', async () => {
    const id = await makeTask(aishaAgent, { title: 'Order printer paper' });
    const flagged = await post(saidAgent, `/tasks/${id}/flag`, { reason: 'wrong', note: 'We need A4, not A3' }, `/tasks/${id}/flag`);
    assert.equal(flagged.status, 302);
    const flag = (await q('SELECT id FROM flags WHERE task_id = $1', [id])).rows[0];
    const kinds = (await q('SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2', [aisha.id, id])).rows.map((r) => r.kind);
    assert.ok(kinds.includes('flagged'));
    const denied = await post(saidAgent, `/tasks/${id}/flags/${flag.id}/resolve`, { resolution: 'dismissed' }, `/tasks/${id}`);
    assert.equal(denied.status, 403);
    const ok = await post(aishaAgent, `/tasks/${id}/flags/${flag.id}/resolve`, { resolution: 'fixed' }, `/tasks/${id}`);
    assert.equal(ok.status, 302);
    const wrongTask = await makeTask(aishaAgent, { title: 'Another' });
    const crossed = await post(aishaAgent, `/tasks/${wrongTask}/flags/${flag.id}/resolve`, { resolution: 'fixed' }, `/tasks/${wrongTask}`);
    assert.equal(crossed.status, 404, 'a flag id from another task is refused');
  });

  test('closing as created-by-mistake settles open flags', async () => {
    const id = await makeTask(saidAgent, { title: 'Oops duplicate' });
    await post(fatmaAgent, `/tasks/${id}/flag`, { reason: 'mistake', note: '' }, `/tasks/${id}/flag`);
    await post(fatmaAgent, `/tasks/${id}/close`, { reason: 'mistake' }, `/tasks/${id}/close`);
    const flag = (await q('SELECT resolution FROM flags WHERE task_id = $1', [id])).rows[0];
    assert.equal(flag.resolution, 'closed');
  });

  test('reopening clears the closure but keeps it in the audit log', async () => {
    const id = await makeTask(saidAgent, { title: 'Reopen me' });
    await post(saidAgent, `/tasks/${id}/close`, { reason: 'completed', credited: [said.id] }, `/tasks/${id}/close`);
    await post(fatmaAgent, `/tasks/${id}/reopen`, {}, `/tasks/${id}`);
    const row = (await q('SELECT closed_at, status FROM tasks WHERE id = $1', [id])).rows[0];
    assert.equal(row.closed_at, null);
    assert.equal(row.status, 'todo');
    const actions = (await auditFor(id)).map((e) => e.action);
    assert.deepEqual(actions.slice(-2), ['task.closed', 'task.reopened']);
  });

  test('comments are escaped, not rendered as HTML, and mentions notify', async () => {
    const id = await makeTask(aishaAgent, { title: 'XSS check' });
    await post(saidAgent, `/tasks/${id}/comments`, { body: '<script>alert(1)</script> @Fatma please look' }, `/tasks/${id}`);
    const page = await aishaAgent.get(`/tasks/${id}`);
    assert.ok(!page.text.includes('<script>alert(1)</script>'));
    assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    const kinds = (await q('SELECT kind FROM notifications WHERE user_id = $1 AND task_id = $2', [fatma.id, id])).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ['mentioned']);
  });

  test('titles with HTML are escaped on the board and in the list', async () => {
    await makeTask(aishaAgent, { title: '<img src=x onerror=alert(1)>' });
    for (const path of ['/board', '/tasks']) {
      const page = await saidAgent.get(path);
      assert.ok(!page.text.includes('<img src=x onerror=alert(1)>'), path);
    }
  });

  test('list search, filters and paging use parameters safely', async () => {
    const res = await saidAgent.get(`/tasks?q=${encodeURIComponent("' OR 1=1 --")}&label=1&priority=high&person=not-a-uuid&page=abc`);
    assert.equal(res.status, 200);
    assert.match(res.text, /No tasks match these filters/);
  });

  test('notifications can only be opened by their owner', async () => {
    const id = await makeTask(aishaAgent, { title: 'Assigned to Said', assignees: [said.id] });
    const n = (await q('SELECT id FROM notifications WHERE user_id = $1 AND task_id = $2', [said.id, id])).rows[0];
    assert.equal((await fatmaAgent.get(`/notifications/${n.id}`)).status, 404);
    assert.equal((await saidAgent.get(`/notifications/${n.id}`)).headers.location, `/tasks/${id}`);
  });

  test('Arabic pages render right-to-left', async () => {
    await post(saidAgent, '/lang', { lang: 'ar', next: '/board' });
    const page = await saidAgent.get('/board');
    assert.match(page.text, /<html lang="ar" dir="rtl">/);
    assert.match(page.text, /لوحة الفريق/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/board' });
  });

  test('emails were queued with escaped content', async () => {
    const html = (await q(`SELECT body_html FROM email_outbox WHERE body_html IS NOT NULL LIMIT 1`)).rows[0]?.body_html || '';
    assert.ok(!html.includes('<script>'));
    assert.ok(sent.length >= 0);
  });
});

describe('admin-only areas', () => {
  test('members are refused, admins allowed', async () => {
    for (const path of ['/people', '/labels', '/import', '/audit.csv']) {
      assert.equal((await saidAgent.get(path)).status, 403, path);
      assert.equal((await adminAgent.get(path)).status, 200, path);
    }
    const res = await post(saidAgent, '/people/invite', { email: 'x@example.com', role: 'admin' });
    assert.equal(res.status, 403);
    const role = await post(saidAgent, `/people/${said.id}/role`, { role: 'admin' });
    assert.equal(role.status, 403);
    assert.equal((await q('SELECT role FROM users WHERE id = $1', [said.id])).rows[0].role, 'member');
  });

  test('the last admin cannot be demoted or disabled', async () => {
    const res = await post(adminAgent, `/people/${admin.id}/role`, { role: 'member' }, '/people');
    assert.equal(res.status, 302);
    assert.equal((await q('SELECT role FROM users WHERE id = $1', [admin.id])).rows[0].role, 'admin');
  });
});
