import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { currentCode } from '../src/totp.js';
import { PASSWORD, createUser, csrfIn, post, resetLimits, setup, teardown } from './helpers.js';

let app;
before(async () => ({ app } = await setup()));
after(teardown);
beforeEach(resetLimits);

const DAY = 24 * 60 * 60;
const deviceCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('mahamm.device='));
const sessionCookie = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('mahamm.sid='));
// Seconds until the cookie expires, from Max-Age or, failing that, Expires.
const maxAge = (cookie) => {
  const m = cookie.match(/Max-Age=(\d+)/i);
  if (m) return Number(m[1]);
  const e = cookie.match(/Expires=([^;]+)/i);
  return e ? Math.round((Date.parse(e[1]) - Date.now()) / 1000) : 0;
};

// Each test signs in more than once within one 30-second code window; codes
// can't be replayed, so clear the last-used step to get a usable code again.
const freshCode = async (user) => {
  await q('UPDATE users SET totp_last_step = 0 WHERE id = $1', [user.id]);
  return currentCode(user.totpSecret);
};

// Password step only. Returns the response so tests can see where it leads.
async function passwordStep(agent, user, { keep = false, password = PASSWORD } = {}) {
  const page = await agent.get('/login');
  return agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: user.email, password, ...(keep ? { keep: 'on' } : {}) });
}

async function codeStep(agent, user, { remember = false } = {}) {
  const page = await agent.get('/login/two-factor');
  return agent.post('/login/two-factor').type('form')
    .send({ _csrf: csrfIn(page.text), code: await freshCode(user), ...(remember ? { remember: 'on' } : {}) });
}

async function signInRemembering(user, opts = {}) {
  const agent = request.agent(app);
  const first = await passwordStep(agent, user, opts);
  assert.equal(first.headers.location, '/login/two-factor');
  const done = await codeStep(agent, user, { remember: true });
  assert.equal(done.status, 302);
  return { agent, done };
}

async function signOut(agent) {
  await post(agent, '/logout', {}, '/settings');
}

describe('remember this device', () => {
  test('a remembered browser skips the code but not the password', async () => {
    const user = await createUser({ twoFactor: true });
    const { agent, done } = await signInRemembering(user);
    const cookie = deviceCookie(done);
    assert.ok(cookie, 'device cookie is set');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.equal(maxAge(cookie), 90 * DAY, 'members are remembered for 90 days');

    const token = cookie.split(';')[0].split('=')[1];
    const rows = (await q('SELECT token_hash, label FROM trusted_devices WHERE user_id = $1', [user.id])).rows;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, token, 'only a hash is stored');
    assert.ok(!rows[0].token_hash.includes(token));

    await signOut(agent);
    const wrong = await passwordStep(agent, user, { password: 'not-the-password-123' });
    assert.equal(wrong.status, 401, 'the password is still checked');
    const again = await passwordStep(agent, user);
    assert.equal(again.status, 302);
    assert.equal(again.headers.location, '/home', 'no code asked');
    assert.equal((await agent.get('/board')).status, 200);

    const ev = (await q(`SELECT action, details FROM audit_events WHERE subject_user_id = $1 AND action LIKE 'auth.%' ORDER BY id`, [user.id])).rows;
    assert.ok(ev.some((e) => e.action === 'auth.device_remembered'));
    assert.ok(ev.some((e) => e.action === 'auth.signed_in' && e.details.two_factor === 'remembered_device'));
  });

  test('without ticking the box the code is asked every time', async () => {
    const user = await createUser({ twoFactor: true });
    const agent = request.agent(app);
    await passwordStep(agent, user);
    const done = await codeStep(agent, user);
    assert.equal(done.status, 302);
    assert.equal(deviceCookie(done), undefined);
    await signOut(agent);
    assert.equal((await passwordStep(agent, user)).headers.location, '/login/two-factor');
  });

  test('admins are remembered for 30 days, and an older device asks again', async () => {
    const admin = await createUser({ role: 'admin', twoFactor: true });
    const { agent, done } = await signInRemembering(admin);
    assert.equal(maxAge(deviceCookie(done)), 30 * DAY);
    await signOut(agent);
    assert.equal((await passwordStep(agent, admin)).headers.location, '/home');

    // A device remembered while this person was a member doesn't outlast the admin period.
    await signOut(agent);
    await q(`UPDATE trusted_devices SET created_at = now() - interval '31 days', expires_at = now() + interval '59 days' WHERE user_id = $1`, [admin.id]);
    assert.equal((await passwordStep(agent, admin)).headers.location, '/login/two-factor');
  });

  test('a device remembered for someone else does not skip your code', async () => {
    const owner = await createUser({ twoFactor: true });
    const other = await createUser({ twoFactor: true });
    // Same browser, still holding the owner's device cookie.
    const { agent } = await signInRemembering(owner);
    await signOut(agent);
    assert.equal((await passwordStep(agent, other)).headers.location, '/login/two-factor');
    assert.equal((await passwordStep(agent, owner)).headers.location, '/home');
  });

  test('expired or tampered tokens ask for the code', async () => {
    const user = await createUser({ twoFactor: true });
    const { agent } = await signInRemembering(user);
    await signOut(agent);
    await q(`UPDATE trusted_devices SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);
    assert.equal((await passwordStep(agent, user)).headers.location, '/login/two-factor');

    // A cookie whose token matches nothing stored.
    await q(`UPDATE trusted_devices SET expires_at = now() + interval '1 day', token_hash = md5(token_hash) WHERE user_id = $1`, [user.id]);
    assert.equal((await passwordStep(agent, user)).headers.location, '/login/two-factor');
  });

  test('changing the password forgets every remembered device', async () => {
    const user = await createUser({ twoFactor: true });
    const { agent } = await signInRemembering(user);
    const { agent: phone } = await signInRemembering(user);
    const res = await post(agent, '/settings/password', { current: PASSWORD, password: 'a-brand-new-passphrase-9', confirm: 'a-brand-new-passphrase-9' }, '/settings');
    assert.equal(res.status, 302);
    await signOut(agent);
    assert.equal((await passwordStep(phone, user, { password: 'a-brand-new-passphrase-9' })).headers.location, '/login/two-factor');
    const left = (await q('SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = $1 AND forgotten_at IS NULL', [user.id])).rows[0].n;
    assert.equal(left, 0);
  });

  test('turning off two-step forgets the devices', async () => {
    const user = await createUser({ twoFactor: true });
    const { agent } = await signInRemembering(user);
    await q('UPDATE users SET totp_last_step = 0 WHERE id = $1', [user.id]);
    const res = await post(agent, '/settings/two-factor/disable', { password: PASSWORD, code: currentCode(user.totpSecret) }, '/settings');
    assert.equal(res.status, 302);
    const left = (await q('SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = $1 AND forgotten_at IS NULL', [user.id])).rows[0].n;
    assert.equal(left, 0);
  });

  test('people see and forget only their own devices', async () => {
    const user = await createUser({ twoFactor: true });
    const other = await createUser({ twoFactor: true });
    const { agent } = await signInRemembering(user);
    await signInRemembering(other);
    const theirs = (await q('SELECT id FROM trusted_devices WHERE user_id = $1', [other.id])).rows[0].id;

    const page = await agent.get('/settings');
    assert.equal(page.status, 200);
    assert.match(page.text, /Remembered devices/);
    assert.match(page.text, /This device/);
    assert.ok(!page.text.includes(theirs), 'someone else’s device is not listed');

    const denied = await post(agent, `/settings/devices/${theirs}/forget`, {}, '/settings');
    assert.equal(denied.status, 404);
    assert.equal((await q('SELECT forgotten_at FROM trusted_devices WHERE id = $1', [theirs])).rows[0].forgotten_at, null);
    assert.equal((await post(agent, '/settings/devices/not-an-id/forget', {}, '/settings')).status, 404);

    const mine = (await q('SELECT id FROM trusted_devices WHERE user_id = $1', [user.id])).rows[0].id;
    const res = await post(agent, `/settings/devices/${mine}/forget`, {}, '/settings');
    assert.equal(res.status, 302);
    assert.ok(deviceCookie(res), 'this browser’s cookie is cleared');
    const ev = (await q(`SELECT details FROM audit_events WHERE action = 'auth.device_forgotten' AND actor_id = $1`, [user.id])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].details.device, mine);
    await signOut(agent);
    assert.equal((await passwordStep(agent, user)).headers.location, '/login/two-factor');
  });

  test('forget all devices', async () => {
    const user = await createUser({ twoFactor: true });
    const { agent } = await signInRemembering(user);
    const { agent: phone } = await signInRemembering(user);
    const res = await post(agent, '/settings/devices/forget-all', {}, '/settings');
    assert.equal(res.status, 302);
    await signOut(phone);
    assert.equal((await passwordStep(phone, user)).headers.location, '/login/two-factor');
    const ev = (await q(`SELECT details FROM audit_events WHERE action = 'auth.devices_forgotten' AND actor_id = $1`, [user.id])).rows;
    assert.equal(ev[0].details.count, 2);
  });

  test('forgetting needs a CSRF token', async () => {
    const user = await createUser({ twoFactor: true });
    const { agent } = await signInRemembering(user);
    const res = await agent.post('/settings/devices/forget-all').type('form').send({});
    assert.equal(res.status, 403);
  });

  test('pages are in Arabic too', async () => {
    const user = await createUser({ twoFactor: true });
    const agent = request.agent(app);
    const lp = await agent.get('/login');
    await agent.post('/lang').type('form').send({ _csrf: csrfIn(lp.text), lang: 'ar', next: '/login' });
    const login = await agent.get('/login');
    assert.match(login.text, /dir="rtl"/);
    assert.match(login.text, /إبقائي مسجّلًا/);
    await passwordStep(agent, user);
    const two = await agent.get('/login/two-factor');
    assert.match(two.text, /تذكّر هذا الجهاز لمدة 90 يومًا/);
    await codeStep(agent, user, { remember: true });
    await post(agent, '/lang', { lang: 'ar', next: '/settings' }, '/settings');
    const settings = await agent.get('/settings');
    assert.match(settings.text, /الأجهزة المحفوظة/);
    assert.match(settings.text, /هذا الجهاز/);
  });
});

describe('keep me signed in', () => {
  test('the session lasts beyond a week only when ticked', async () => {
    const kept = await createUser();
    const plain = await createUser();

    const a = request.agent(app);
    const ra = await passwordStep(a, kept, { keep: true });
    assert.equal(ra.headers.location, '/home');
    assert.ok(maxAge(sessionCookie(ra)) >= 90 * DAY - 5, 'cookie outlives the browser');

    const b = request.agent(app);
    const rb = await passwordStep(b, plain);
    assert.ok(maxAge(sessionCookie(rb)) <= 12 * 60 * 60, 'unticked keeps the 12-hour idle timeout');

    // Eight days later: the kept session continues, the other has ended.
    const ago = Date.now() - 8 * DAY * 1000;
    await q(`UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{createdAt}', to_jsonb($2::bigint))::json WHERE sess->>'userId' IN ($1, $3)`,
      [kept.id, ago, plain.id]);
    assert.equal((await a.get('/board')).status, 200);
    assert.equal((await b.get('/board')).status, 302);
  });

  test('admins are kept for 30 days at most', async () => {
    const admin = await createUser({ role: 'admin', twoFactor: true });
    const agent = request.agent(app);
    await passwordStep(agent, admin, { keep: true });
    const done = await codeStep(agent, admin);
    assert.ok(maxAge(sessionCookie(done)) <= 30 * DAY);
    assert.ok(maxAge(sessionCookie(done)) >= 30 * DAY - 5);
    const ago = Date.now() - 31 * DAY * 1000;
    await q(`UPDATE "session" SET sess = jsonb_set(sess::jsonb, '{createdAt}', to_jsonb($2::bigint))::json WHERE sess->>'userId' = $1`, [admin.id, ago]);
    assert.equal((await agent.get('/board')).status, 302);
  });
});
