import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { createUser, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

let app;
let config;
let aisha; let said;
let aishaAgent; let saidAgent;
const ids = {};

// Task ids in the order the table shows them.
const order = (html) => [...html.matchAll(/<tr class="[^"]*" data-task-id="(\d+)"/g)].map((m) => Number(m[1]));
const setDue = (id, days) => q(
  `UPDATE tasks SET due_date = (now() AT TIME ZONE $3)::date + $2::int WHERE id = $1`, [id, days, config.timezone],
);

before(async () => {
  ({ app, config } = await setup());
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  said = await createUser({ name: 'Said Al-Rawahi' });
  aishaAgent = await signIn(app, aisha);
  saidAgent = await signIn(app, said);
  ids.alpha = await makeTask(aishaAgent, { title: 'Alpha budget sheet', priority: 'low', assignees: [said.id], labels: [1] });
  ids.bravo = await makeTask(aishaAgent, { title: 'Bravo printer toner', priority: 'high', status: 'backlog' });
  ids.charlie = await makeTask(aishaAgent, { title: 'Charlie visitor badges', priority: 'med', labels: [7] });
  ids.delta = await makeTask(aishaAgent, { title: 'Delta closed last week', assignees: [aisha.id] });
  ids.echo = await makeTask(aishaAgent, { title: 'Echo closed long ago', assignees: [aisha.id] });
  await setDue(ids.alpha, -2);
  await setDue(ids.charlie, 3);
  for (const id of [ids.delta, ids.echo]) {
    const res = await post(aishaAgent, `/tasks/${id}/close`, { reason: 'completed', credited: [aisha.id] }, `/tasks/${id}/close`);
    assert.equal(res.status, 302);
  }
  await q(`UPDATE tasks SET closed_at = now() - interval '3 days' WHERE id = $1`, [ids.delta]);
  await q(`UPDATE tasks SET closed_at = now() - interval '30 days' WHERE id = $1`, [ids.echo]);
});
after(teardown);
beforeEach(resetLimits);

describe('the table view', () => {
  test('signed-out visitors are sent to sign in', async () => {
    const res = await request(app).get('/table');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2Ftable');
  });

  test('shows open tasks only, most urgent first, with missing values spelled out', async () => {
    const res = await saidAgent.get('/table');
    assert.equal(res.status, 200);
    assert.deepEqual(order(res.text), [ids.bravo, ids.charlie, ids.alpha]);
    assert.match(res.text, /<a href="\/table" aria-current="page">Table<\/a>/);
    assert.match(res.text, /Unassigned/);
    assert.match(res.text, /No due date/);
    assert.match(res.text, /No labels/);
    assert.match(res.text, /Tasks: 3/);
    assert.match(res.text, /data-color-by="status"/);
  });

  test('recently closed tasks appear only when switched on, greyed and after open ones', async () => {
    const off = await saidAgent.get('/table?status=done');
    assert.deepEqual(order(off.text), [ids.bravo, ids.charlie, ids.alpha], 'Done filter is ignored while closed tasks are hidden');
    const on = await saidAgent.get('/table?closed=1');
    assert.deepEqual(order(on.text), [ids.bravo, ids.charlie, ids.alpha, ids.delta], 'only tasks closed in the last 14 days');
    assert.match(on.text, new RegExp(`class="[^"]*is-closed" data-task-id="${ids.delta}"`));
    assert.match(on.text, /<span class="cell-note">Completed by Aisha Al-Lawati<\/span>/);
    const onlyClosed = await saidAgent.get('/table?closed=1&status=done');
    assert.deepEqual(order(onlyClosed.text), [ids.delta]);
  });

  test('sorting by due date keeps tasks with no date at the end in both directions', async () => {
    const asc = await saidAgent.get('/table?sort=due&dir=asc');
    assert.deepEqual(order(asc.text), [ids.alpha, ids.charlie, ids.bravo]);
    assert.match(asc.text, /aria-sort="ascending"/);
    assert.match(asc.text, /href="\/table\?sort=due&amp;dir=desc"/, 'clicking the same header again reverses it');
    const desc = await saidAgent.get('/table?sort=due&dir=desc');
    assert.deepEqual(order(desc.text), [ids.charlie, ids.alpha, ids.bravo]);
    const title = await saidAgent.get('/table?sort=title&dir=desc');
    assert.deepEqual(order(title.text), [ids.charlie, ids.bravo, ids.alpha]);
    const status = await saidAgent.get('/table?sort=status');
    assert.equal(order(status.text)[0], ids.bravo, 'Backlog sorts first');
  });

  test('filters narrow the rows', async () => {
    const cases = [
      ['due=overdue', [ids.alpha]],
      ['due=week', [ids.charlie]],
      ['due=none', [ids.bravo]],
      ['status=backlog', [ids.bravo]],
      [`person=${said.id}`, [ids.alpha]],
      ['label=7', [ids.charlie]],
      ['priority=med', [ids.charlie]],
      [`q=%23${ids.bravo}`, [ids.bravo]],
      ['q=visitor', [ids.charlie]],
      ['flagged=1', []],
    ];
    for (const [qs, expected] of cases) {
      const res = await saidAgent.get(`/table?${qs}`);
      assert.equal(res.status, 200, qs);
      assert.deepEqual(order(res.text), expected, qs);
    }
    const none = await saidAgent.get('/table?flagged=1');
    assert.match(none.text, /No tasks match these filters/);
  });

  test('unknown or hostile parameters are ignored, never put into SQL or the page', async () => {
    const res = await saidAgent.get(`/table?sort=${encodeURIComponent("id; DROP TABLE tasks --")}&dir=sideways&status=done&due=soon`
      + `&color=${encodeURIComponent('<script>x</script>')}&person=not-a-uuid&label=abc&page=abc&q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('<script>x</script>'));
    assert.match(res.text, /data-color-by="status"/);
    assert.deepEqual(order(res.text), []);
    assert.equal((await q('SELECT count(*)::int AS n FROM tasks')).rows[0].n >= 5, true);
  });

  test('the chosen row colouring is applied', async () => {
    const res = await saidAgent.get('/table?color=priority');
    assert.match(res.text, /data-color-by="priority"/);
    assert.match(res.text, /<option value="priority" selected>/);
  });

  test('titles with HTML are escaped', async () => {
    const id = await makeTask(aishaAgent, { title: '<img src=x onerror=alert(1)>' });
    const res = await saidAgent.get('/table');
    assert.ok(!res.text.includes('<img src=x onerror=alert(1)>'));
    assert.ok(order(res.text).includes(id));
    await q(`UPDATE tasks SET closed_at = now() - interval '60 days', closed_by = $2, close_reason = 'mistake' WHERE id = $1`, [id, aisha.id]);
  });

  test('Arabic renders right-to-left with translated headings', async () => {
    await post(saidAgent, '/lang', { lang: 'ar', next: '/table' });
    const res = await saidAgent.get('/table');
    assert.match(res.text, /<html lang="ar" dir="rtl">/);
    assert.match(res.text, /الجدول/);
    assert.match(res.text, /غير مُسندة/);
    assert.match(res.text, /تاريخ الاستحقاق/);
    await post(saidAgent, '/lang', { lang: 'en', next: '/table' });
  });

  test('pages keep the filters and sort', async () => {
    await q(`INSERT INTO tasks (title, creator_id) SELECT 'Bulk task ' || g, $1 FROM generate_series(1, 50) g`, [aisha.id]);
    const res = await saidAgent.get('/table?due=none&sort=title&dir=asc');
    assert.equal(order(res.text).length, 50);
    assert.match(res.text, /Tasks: 51/);
    assert.match(res.text, /href="\/table\?due=none&amp;sort=title&amp;dir=asc&amp;page=2"/);
    const page2 = await saidAgent.get('/table?due=none&sort=title&dir=asc&page=2');
    assert.equal(order(page2.text).length, 1);
  });
});
