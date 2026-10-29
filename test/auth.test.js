import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { currentCode } from '../src/totp.js';
import { PASSWORD, createUser, csrfIn, post, resetLimits, setup, signIn, teardown, tokenFor } from './helpers.js';

let app;
let sent;
before(async () => ({ app, sent } = await setup()));
after(teardown);
beforeEach(resetLimits);

describe('first-run setup', () => {
  test('needs the setup token, creates one admin, then disappears', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/login');
    assert.equal(page.headers.location, '/setup');
    const form = await agent.get('/setup');
    assert.equal(form.status, 200);
    const bad = await agent.post('/setup').type('form').send({
      _csrf: csrfIn(form.text), setup_token: 'wrong-token-xxxxxxxxxxxxxxxx', name: 'First Admin', email: 'first@example.com', password: PASSWORD, confirm: PASSWORD,
    });
    assert.equal(bad.status, 403);
    const good = await agent.post('/setup').type('form').send({
      _csrf: csrfIn(bad.text), setup_token: 'setup-token-for-tests-0123456789', name: 'First Admin', email: 'First@Example.com', password: PASSWORD, confirm: PASSWORD,
    });
    assert.equal(good.status, 302);
    assert.equal(good.headers.location, '/settings/two-factor');
    const row = (await q(`SELECT role, email FROM users`)).rows;
    assert.deepEqual(row, [{ role: 'admin', email: 'first@example.com' }]);
    // Admin without two-step is held on the setup page.
    const board = await agent.get('/board');
    assert.equal(board.headers.location, '/settings/two-factor');
    const again = await request(app).get('/setup');
    assert.equal(again.status, 404);
    await q(`DELETE FROM "session"`);
  });
});

describe('sign-in', () => {
  test('protected pages redirect to sign-in', async () => {
    const res = await request(app).get('/board');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/login?next=%2Fboard');
  });

  test('wrong password and unknown email give the same answer', async () => {
    await createUser({ email: 'known@example.com' });
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const a = await agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: 'known@example.com', password: 'not-the-password-123' });
    const b = await agent.post('/login').type('form').send({ _csrf: csrfIn(a.text), email: 'nobody@example.com', password: 'not-the-password-123' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    const msg = (html) => html.match(/<div class="alert" role="alert">([^<]+)<\/div>/)[1];
    assert.equal(msg(a.text), msg(b.text));
  });

  test('five failures pause sign-in for that email and are audited', async () => {
    const user = await createUser({ email: 'target@example.com' });
    const agent = request.agent(app);
    let html = (await agent.get('/login')).text;
    let res;
    for (let i = 0; i < 5; i += 1) {
      res = await agent.post('/login').type('form').send({ _csrf: csrfIn(html), email: user.email, password: 'wrong-password-123' });
      html = res.text;
    }
    assert.equal(res.status, 429);
    const right = await agent.post('/login').type('form').send({ _csrf: csrfIn(html), email: user.email, password: PASSWORD });
    assert.equal(right.status, 429, 'correct password is still refused while paused');
    const ev = await q(`SELECT details FROM audit_events WHERE action = 'auth.signin_paused'`);
    assert.equal(ev.rows.length, 1);
    assert.equal(ev.rows[0].details.email, 'target@example.com');
  });

  test('session cookie is HttpOnly and SameSite, and the id changes at sign-in', async () => {
    const user = await createUser();
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const before = page.headers['set-cookie'][0].split(';')[0];
    const res = await agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: user.email, password: PASSWORD });
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.notEqual(cookie.split(';')[0], before);
  });

  test('posts without a CSRF token are refused', async () => {
    const user = await createUser();
    const agent = await signIn(app, user);
    const res = await agent.post('/tasks/new').type('form').send({ title: 'x' });
    assert.equal(res.status, 403);
    const res2 = await agent.post('/logout').type('form').send({});
    assert.equal(res2.status, 403);
  });

  test('cross-site form posts are refused even with a token', async () => {
    const user = await createUser();
    const agent = await signIn(app, user);
    const token = await tokenFor(agent);
    const res = await agent.post('/notifications/read-all').set('Origin', 'https://evil.example').type('form').send({ _csrf: token });
    assert.equal(res.status, 403);
  });

  test('sign-out ends the session', async () => {
    const user = await createUser();
    const agent = await signIn(app, user);
    const res = await post(agent, '/logout', {});
    assert.equal(res.headers.location, '/login');
    assert.equal((await agent.get('/board')).status, 302);
  });

  test('changing the password signs out other sessions', async () => {
    const user = await createUser();
    const first = await signIn(app, user);
    const second = await signIn(app, user);
    const res = await post(first, '/settings/password', { current: PASSWORD, password: 'a-brand-new-passphrase-9', confirm: 'a-brand-new-passphrase-9' }, '/settings');
    assert.equal(res.status, 302);
    assert.equal((await second.get('/board')).status, 302, 'other session is gone');
    assert.equal((await first.get('/board')).status, 200, 'this session continues');
  });
});

describe('two-step verification', () => {
  test('admins must set it up, codes cannot be replayed, recovery codes work once', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin2fa@example.com' });
    const agent = await signIn(app, admin);
    assert.equal((await agent.get('/board')).headers.location, '/settings/two-factor');
    const setupPage = await agent.get('/settings/two-factor');
    const secret = setupPage.text.match(/<code dir="ltr">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
    const enabled = await agent.post('/settings/two-factor').type('form').send({ _csrf: csrfIn(setupPage.text), code: currentCode(secret) });
    assert.equal(enabled.status, 200);
    const codes = [...enabled.text.matchAll(/<li><code>([A-Z0-9-]+)<\/code><\/li>/g)].map((m) => m[1]);
    assert.equal(codes.length, 8);
    const stored = (await q('SELECT totp_secret_enc, recovery_codes FROM users WHERE id = $1', [admin.id])).rows[0];
    assert.ok(!stored.totp_secret_enc.includes(secret), 'secret is encrypted at rest');
    assert.ok(!stored.recovery_codes.includes(codes[0]), 'recovery codes are hashed');

    // The same code that turned it on cannot be used to sign in.
    const fresh = request.agent(app);
    let page = await fresh.get('/login');
    let res = await fresh.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: admin.email, password: PASSWORD });
    assert.equal(res.headers.location, '/login/two-factor');
    page = await fresh.get('/login/two-factor');
    res = await fresh.post('/login/two-factor').type('form').send({ _csrf: csrfIn(page.text), code: currentCode(secret) });
    assert.equal(res.status, 401);

    res = await fresh.post('/login/two-factor').type('form').send({ _csrf: csrfIn(res.text), code: codes[0] });
    assert.equal(res.status, 302);
    assert.equal((await fresh.get('/board')).status, 200);

    const third = request.agent(app);
    page = await third.get('/login');
    await third.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: admin.email, password: PASSWORD });
    page = await third.get('/login/two-factor');
    res = await third.post('/login/two-factor').type('form').send({ _csrf: csrfIn(page.text), code: codes[0] });
    assert.equal(res.status, 401, 'a recovery code works only once');
  });
});

describe('invites and resets', () => {
  test('invite links work once, enforce the password policy and are stored hashed', async () => {
    const admin = await createUser({ role: 'admin', twoFactor: true });
    const agent = await signIn(app, admin);
    const res = await post(agent, '/people/invite', { email: 'New.Person@Example.com', role: 'member' }, '/people');
    assert.equal(res.status, 200);
    const link = res.text.match(/value="(http:\/\/localhost:3000\/invite\/[^"]+)"/)[1];
    const token = link.split('/').pop();
    const stored = (await q('SELECT token_hash, email FROM invites')).rows[0];
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.email, 'new.person@example.com');
    assert.equal(sent.at(-1).to, 'new.person@example.com');

    const guest = request.agent(app);
    const page = await guest.get(`/invite/${token}`);
    assert.equal(page.status, 200);
    const weak = await guest.post(`/invite/${token}`).type('form').send({ _csrf: csrfIn(page.text), name: 'New Person', password: 'password1234', confirm: 'password1234' });
    assert.equal(weak.status, 400);
    const ok = await guest.post(`/invite/${token}`).type('form').send({ _csrf: csrfIn(weak.text), name: 'New Person', password: PASSWORD, confirm: PASSWORD });
    assert.equal(ok.status, 302);
    assert.equal((await guest.get('/board')).status, 200);
    const reuse = await request(app).get(`/invite/${token}`);
    assert.equal(reuse.status, 410);
  });

  test('reset links work once and sign the person out everywhere', async () => {
    const admin = await createUser({ role: 'admin', twoFactor: true });
    const member = await createUser();
    const memberSession = await signIn(app, member);
    const agent = await signIn(app, admin);
    const res = await post(agent, `/people/${member.id}/reset-link`, {}, '/people');
    const token = res.text.match(/\/reset\/([A-Za-z0-9_-]+)"/)[1];
    const guest = request.agent(app);
    const page = await guest.get(`/reset/${token}`);
    const done = await guest.post(`/reset/${token}`).type('form').send({ _csrf: csrfIn(page.text), password: 'fresh-passphrase-for-me-7', confirm: 'fresh-passphrase-for-me-7' });
    assert.equal(done.status, 200);
    assert.equal((await memberSession.get('/board')).status, 302, 'old session ended');
    assert.equal((await request(app).get(`/reset/${token}`)).status, 410, 'link works once');
    await signIn(app, member, 'fresh-passphrase-for-me-7');
  });

  test('forgot-password gives the same answer for unknown emails', async () => {
    const before = sent.length;
    const agent = request.agent(app);
    const page = await agent.get('/forgot');
    const res = await agent.post('/forgot').type('form').send({ _csrf: csrfIn(page.text), email: 'ghost@example.com' });
    assert.equal(res.status, 200);
    assert.equal(sent.length, before);
    const member = await createUser();
    const page2 = await agent.get('/forgot');
    const res2 = await agent.post('/forgot').type('form').send({ _csrf: csrfIn(page2.text), email: member.email });
    assert.equal(res2.text.match(/<p>([^<]+)<\/p>/)[1], res.text.match(/<p>([^<]+)<\/p>/)[1]);
    assert.equal(sent.length, before + 1);
  });

  test('disabled people cannot sign in and lose their sessions', async () => {
    const admin = await createUser({ role: 'admin', twoFactor: true });
    const member = await createUser();
    const memberSession = await signIn(app, member);
    const agent = await signIn(app, admin);
    await post(agent, `/people/${member.id}/status`, { status: 'disabled' }, '/people');
    assert.equal((await memberSession.get('/board')).status, 302);
    await assert.rejects(() => signIn(app, member));
  });
});
