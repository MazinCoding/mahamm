import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import request from 'supertest';
import { csvCell } from '../src/routes/admin.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { q } from '../src/db.js';
import { isBreached, passwordProblem } from '../src/passwords.js';
import { safeLocalPath } from '../src/security.js';
import { createUser, makeTask, post, resetLimits, setup, signIn, teardown, testEnv, tokenFor } from './helpers.js';

let app;
let admin; let member; let other;
let adminAgent; let memberAgent; let otherAgent;

before(async () => {
  ({ app } = await setup());
  admin = await createUser({ role: 'admin', twoFactor: true });
  member = await createUser();
  other = await createUser();
  adminAgent = await signIn(app, admin);
  memberAgent = await signIn(app, member);
  otherAgent = await signIn(app, other);
});
after(teardown);
beforeEach(resetLimits);

// A real, minimal 1x1 PNG.
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('headers', () => {
  test('security headers are set and the framework is not advertised', async () => {
    const res = await request(app).get('/login');
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.match(res.headers['permissions-policy'], /camera=\(\)/);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS');
  });

  test('templates contain no inline scripts or styles', async () => {
    const pages = ['/board', '/tasks', '/tasks/new', '/audit', '/settings', '/notifications'];
    for (const p of pages) {
      const html = (await memberAgent.get(p)).text;
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `inline script on ${p}`);
      assert.ok(!/\sstyle="/i.test(html), `inline style on ${p}`);
      assert.ok(!/\son[a-z]+="/i.test(html), `inline handler on ${p}`);
    }
  });

  test('errors are generic and do not leak stack traces', async () => {
    const res = await memberAgent.get('/tasks/999999');
    assert.equal(res.status, 404);
    assert.ok(!/at .*\.js:\d+/.test(res.text));
    const bad = await memberAgent.get('/tasks/abc');
    assert.equal(bad.status, 404);
  });
});

describe('uploads', () => {
  test('files are checked by content, not by name', async () => {
    const id = await makeTask(memberAgent, { title: 'Upload test' });
    let token = await tokenFor(memberAgent, `/tasks/${id}`);
    const fake = await memberAgent.post(`/tasks/${id}/attachments`).field('_csrf', token)
      .attach('file', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'invoice.pdf', contentType: 'application/pdf' });
    assert.equal(fake.status, 302);
    assert.equal((await q('SELECT count(*)::int AS n FROM attachments WHERE task_id = $1', [id])).rows[0].n, 0);

    token = await tokenFor(memberAgent, `/tasks/${id}`);
    const real = await memberAgent.post(`/tasks/${id}/attachments`).field('_csrf', token)
      .attach('file', png(), { filename: '../../etc/evil name.exe', contentType: 'application/octet-stream' });
    assert.equal(real.status, 302);
    const file = (await q('SELECT id, filename, mime FROM attachments WHERE task_id = $1', [id])).rows[0];
    assert.equal(file.mime, 'image/png');
    assert.equal(file.filename, 'evil name.png');

    const dl = await otherAgent.get(`/attachments/${file.id}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers['content-disposition'], /^attachment;/);
    assert.equal(dl.headers['x-content-type-options'], 'nosniff');
    assert.match(dl.headers['content-security-policy'], /sandbox/);
  });

  test('uploads need a CSRF token and only go to upload routes', async () => {
    const id = await makeTask(memberAgent, { title: 'No token upload' });
    const res = await memberAgent.post(`/tasks/${id}/attachments`).attach('file', png(), 'a.png');
    assert.equal(res.status, 403);
    const token = await tokenFor(memberAgent);
    const elsewhere = await memberAgent.post(`/tasks/${id}/comments`).field('_csrf', token).field('body', 'hi').attach('file', png(), 'a.png');
    assert.equal(elsewhere.status, 415);
  });

  test('only the uploader or an admin can remove a file, and it stays in the audit log', async () => {
    const id = await makeTask(memberAgent, { title: 'Remove file' });
    const token = await tokenFor(memberAgent, `/tasks/${id}`);
    await memberAgent.post(`/tasks/${id}/attachments`).field('_csrf', token).attach('file', png(), 'photo.png');
    const file = (await q('SELECT id FROM attachments WHERE task_id = $1', [id])).rows[0];
    const denied = await post(otherAgent, `/tasks/${id}/attachments/${file.id}/remove`, {}, `/tasks/${id}`);
    assert.equal(denied.status, 403);
    const ok = await post(memberAgent, `/tasks/${id}/attachments/${file.id}/remove`, {}, `/tasks/${id}`);
    assert.equal(ok.status, 302);
    assert.equal((await memberAgent.get(`/attachments/${file.id}`)).status, 404);
    const actions = (await q('SELECT action FROM audit_events WHERE task_id = $1', [id])).rows.map((r) => r.action);
    assert.ok(actions.includes('task.attachment_added') && actions.includes('task.attachment_removed'));
  });
});

describe('audit log', () => {
  test('the database refuses to change or delete audit entries', async () => {
    await makeTask(memberAgent, { title: 'Audit me' });
    await assert.rejects(() => q(`UPDATE audit_events SET action = 'x'`), /append-only/);
    await assert.rejects(() => q('DELETE FROM audit_events'), /append-only/);
    await assert.rejects(() => q('TRUNCATE audit_events'), /append-only/);
  });

  test('members see task history only; admins also see account events', async () => {
    const memberView = await memberAgent.get('/audit?group=account');
    assert.ok(!memberView.text.includes('Signed in'));
    const adminView = await adminAgent.get('/audit?group=account');
    assert.ok(adminView.text.includes('Signed in'));
  });

  test('CSV export neutralises spreadsheet formulas', async () => {
    assert.equal(csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
    assert.equal(csvCell('+1'), '"\'+1"');
    assert.equal(csvCell('normal'), '"normal"');
    await makeTask(memberAgent, { title: '=cmd|calc!A1' });
    const res = await adminAgent.get('/audit.csv');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('",=cmd'));
  });
});

describe('helpers', () => {
  test('config fails fast and names the missing variables only', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (err) => err instanceof ConfigError && /DATABASE_URL/.test(err.message) && /SESSION_SECRET/.test(err.message));
    assert.throws(() => loadConfig({ ...testEnv, NODE_ENV: 'production', APP_URL: 'http://plain.example.com' }), /https/);
    assert.throws(() => loadConfig({ ...testEnv, SMTP_HOST: 'smtp.gmail.com' }), /SMTP_PASS/);
    const secret = 'super-secret-value-that-must-not-leak';
    try {
      loadConfig({ ...testEnv, SESSION_SECRET: 'short', DATA_ENCRYPTION_KEY: secret.slice(0, 5) });
    } catch (err) {
      assert.ok(!err.message.includes(secret.slice(0, 5)));
    }
  });

  test('redirect targets must be local paths', () => {
    assert.equal(safeLocalPath('/board'), '/board');
    assert.equal(safeLocalPath('//evil.com'), '/');
    assert.equal(safeLocalPath('https://evil.com'), '/');
    assert.equal(safeLocalPath('/\\evil.com'), '/');
  });

  test('password policy', async () => {
    assert.equal(await passwordProblem('short'), 'password.tooShort');
    assert.equal(await passwordProblem('password1234'), 'password.common');
    assert.equal(await passwordProblem('aaaaaaaaaaaaaa'), 'password.common');
    assert.equal(await passwordProblem('fatma-rocks-2026', { name: 'Fatma Al-Harthi' }), 'password.personal');
    assert.equal(await passwordProblem('correct-horse-battery-42'), null);
  });

  test('breach check sends only a hash prefix and fails open', async () => {
    let calledUrl = '';
    const fakeFetch = async (url) => {
      calledUrl = url;
      return { ok: true, text: async () => '1E4C9B93F3F0682250B6CF8331B7EE68FD8:3\r\n0000000000000000000000000000000000A:0' };
    };
    assert.equal(await isBreached('password', fakeFetch), true);
    assert.match(calledUrl, /\/range\/5BAA6$/);
    assert.equal(await isBreached('password', async () => { throw new Error('down'); }), false);
  });
});
