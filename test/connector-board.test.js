import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from './helpers.js';
import { connectApp, createUser, resetLimits, setup, teardown } from './helpers.js';

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
  assert.ok(!res.body.result.isError, JSON.stringify(res.body));
  return res.body.result;
}
async function addTask(creator, title, { status = 'todo', assignees = [], reviewer = null } = {}) {
  const { rows } = await q('INSERT INTO tasks (title, status, creator_id, reviewer_id) VALUES ($1, $2, $3, $4) RETURNING id', [title, status, creator.id, reviewer]);
  for (const u of assignees) await q('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2)', [rows[0].id, u.id]);
  return rows[0].id;
}

describe('connector: the board', () => {
  test('open_board gives the text only counts and the card the tasks, mine and those waiting for my review', async () => {
    const me = await createUser({ name: 'Board Owner' });
    const other = await createUser({ name: 'Board Helper' });
    const token = await connectApp(app, me, RETURN);
    const mine = await addTask(me, 'My board task', { status: 'progress', assignees: [me] });
    const theirs = await addTask(other, 'Their board task', { assignees: [other] });
    const toCheck = await addTask(other, 'Please check', { status: 'review', assignees: [other], reviewer: me.id });
    const closed = await addTask(me, 'Closed board task');
    await q(`UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = 'notneeded' WHERE id = $1`, [closed, me.id]);

    const result = await call(token, 'open_board');
    const data = result.structuredContent;
    assert.deepEqual(
      { backlog: data.backlog, todo: data.todo, in_progress: data.in_progress, review: data.review, yours: data.yours, waiting: data.waiting_for_your_review },
      { backlog: 0, todo: 1, in_progress: 1, review: 1, yours: 1, waiting: 1 },
    );
    assert.equal(data.in_progress_limit, 5);
    assert.ok(!result.content[0].text.includes('My board task'));
    const board = result._meta['mahamm/board'];
    assert.deepEqual(board.tasks.map((t) => t.id).sort((a, b) => a - b), [mine, theirs, toCheck]);
    assert.deepEqual(board.mine, [mine]);
    assert.deepEqual(board.review, [toCheck]);
    assert.equal(result._meta['mahamm/card'].tool, 'open_board');

    const snapshot = (await call(token, 'board_snapshot')).structuredContent;
    assert.deepEqual(snapshot.counts, { backlog: 0, todo: 1, in_progress: 1, review: 1 });
    assert.equal(snapshot.shown, 3);
  });
});
