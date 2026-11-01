import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { q } from '../src/db.js';
import { guessMapping, mapStatus, matchPeople, parseDate } from '../src/services/import.js';
import { createUser, csrfIn, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

let app;
let admin; let khalid; let aisha; let yousef;
let adminAgent;

before(async () => {
  ({ app } = await setup());
  admin = await createUser({ role: 'admin', name: 'Ahmed Al-Balushi', twoFactor: true });
  khalid = await createUser({ name: 'Khalid Al-Hinai', email: 'khalid@example.com' });
  aisha = await createUser({ name: 'Aisha Al-Lawati' });
  yousef = await createUser({ name: 'Yousef Al-Maskari' });
  adminAgent = await signIn(app, admin);
});
after(teardown);
beforeEach(resetLimits);

describe('reading spreadsheets', () => {
  test('guesses columns from English and Arabic headers', () => {
    const m = guessMapping(['Request', 'Location', 'Owner', 'Status', 'Done by', 'Date added', 'Notes']);
    assert.deepEqual(m, { title: 0, description: 1, assignee: 2, status: 3, completed_by: 4, created_date: 5, notes: 6 });
    assert.equal(guessMapping(['المهمة', 'الحالة']).title, 0);
  });

  test('maps status words, dates and names without guessing', () => {
    assert.deepEqual(mapStatus('Done'), { status: 'todo', closed: true });
    assert.deepEqual(mapStatus('منجز'), { status: 'todo', closed: true });
    assert.deepEqual(mapStatus('Ongoing'), { status: 'progress', closed: false });
    assert.deepEqual(mapStatus(''), { status: 'todo', closed: false });
    assert.deepEqual(parseDate('14/09/2026'), { value: '2026-09-14', bad: false });
    assert.deepEqual(parseDate('2026-02-30'), { value: null, bad: true });
    assert.deepEqual(parseDate(''), { value: null, bad: false });
    const people = [khalid, aisha, yousef].map((p) => ({ id: p.id, name: p.name, email: p.email }));
    assert.deepEqual(matchPeople('Khalid H.', people).ids, [khalid.id]);
    assert.deepEqual(matchPeople('Aisha, Yousef', people).ids, [aisha.id, yousef.id]);
    assert.deepEqual(matchPeople('Hamed', people), { ids: [], unmatched: ['Hamed'] });
    assert.deepEqual(matchPeople('khalid@example.com', people).ids, [khalid.id]);
  });
});

describe('import flow', () => {
  test('previews missing values explicitly and imports with an audit trail', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Requests');
    ws.addRow(['Request', 'Owner', 'Status', 'Done by', 'Date added', 'Notes']);
    ws.addRow(['Replace kitchen tap washer', 'Khalid H.', 'Done', 'Khalid', '14/09/2026', 'Washer size 1/2 inch']);
    ws.addRow(['Fix flickering light', 'Khalid', 'Ongoing', '', '22/09/2026', '']);
    ws.addRow(['', 'Aisha', 'Not started', '', '25/09/2026', '']);
    ws.addRow(['Weekly fridge clean-out', 'Yousef', 'Done', 'Aisha, Yousef', '', '']);
    ws.addRow(['Repaint the parking lines', 'Hamed', 'Not started', '', '10/10/2026', '']);
    ws.addRow(['Fix flickering light', 'Aisha', '', '', '', '']);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const token = await tokenFor(adminAgent, '/import');
    const up = await adminAgent.post('/import').field('_csrf', token).attach('file', buffer, 'facilities-requests.xlsx');
    assert.equal(up.status, 302);
    const jobUrl = up.headers.location;
    const review = await adminAgent.get(jobUrl);
    assert.equal(review.status, 200);
    assert.match(review.text, /Missing/);
    assert.match(review.text, /Skipped · no title/);
    assert.match(review.text, /Skipped · same title as row 3/);
    assert.match(review.text, /No account for: Hamed/);

    const runForm = review.text.match(/<form class="form-actions run-bar"[\s\S]*?<\/form>/)[0];
    const fields = Object.fromEntries([...runForm.matchAll(/name="(map_[a-z_]+)" value="(\d+)"/g)].map((m) => [m[1], m[2]]));
    const run = await adminAgent.post(`${jobUrl}/run`).type('form').send({ _csrf: csrfIn(review.text), ...fields });
    assert.equal(run.status, 302);

    const tasks = (await q('SELECT id, title, closed_at, imported, description FROM tasks ORDER BY id')).rows;
    assert.deepEqual(tasks.map((t) => t.title), ['Replace kitchen tap washer', 'Fix flickering light', 'Weekly fridge clean-out', 'Repaint the parking lines']);
    assert.ok(tasks.every((t) => t.imported));
    assert.ok(tasks[0].closed_at);
    assert.match(tasks[3].description, /Owner in the spreadsheet: Hamed/);
    const credits = (await q('SELECT user_id FROM task_credits WHERE task_id = $1', [tasks[0].id])).rows.map((r) => r.user_id);
    assert.deepEqual(credits, [khalid.id]);
    const audits = (await q(`SELECT action, actor_id FROM audit_events WHERE action IN ('task.imported', 'import.completed')`)).rows;
    assert.equal(audits.filter((a) => a.action === 'task.imported').length, 4);
    assert.ok(audits.every((a) => a.actor_id === admin.id));
    const comment = (await q('SELECT body FROM comments WHERE task_id = $1', [tasks[0].id])).rows[0];
    assert.match(comment.body, /Washer size/);
    assert.equal((await adminAgent.get(jobUrl)).status, 404, 'the uploaded rows are deleted after import');
  });

  test('another admin cannot open someone else\'s import', async () => {
    const other = await createUser({ role: 'admin', twoFactor: true });
    const otherAgent = await signIn(app, other);
    const token = await tokenFor(adminAgent, '/import');
    const up = await adminAgent.post('/import').field('_csrf', token)
      .attach('file', Buffer.from('Task,Owner\nSomething,Khalid\n'), { filename: 'tiny.csv', contentType: 'text/csv' });
    assert.equal(up.status, 302);
    assert.equal((await otherAgent.get(up.headers.location)).status, 404);
  });

  test('rejects files that are not spreadsheets', async () => {
    const token = await tokenFor(adminAgent, '/import');
    const res = await adminAgent.post('/import').field('_csrf', token).attach('file', Buffer.from('%PDF-1.4 not a sheet'), 'tasks.xlsx');
    assert.equal(res.headers.location, '/import');
  });
});
