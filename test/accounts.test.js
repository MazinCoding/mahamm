import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { signOutEverywhere } from '../src/auth.js';
import { currentCode } from '../src/totp.js';
import { ORG1, PASSWORD, createUser, csrfIn, inOrg, makeTask, q, resetLimits, setup, signIn, teardown } from './helpers.js';

const ORG2 = '00000000-0000-4000-8000-000000000002';
let app;
let alice; let bob; let carol;

before(async () => {
  ({ app } = await setup());
  await q(`INSERT INTO organizations (id, name) VALUES ($1, 'Second Company')`, [ORG2]);
  await q(`UPDATE organizations SET name = 'First Company' WHERE id = $1`, [ORG1]);
  alice = await createUser({ name: 'Alice First' });
  bob = await createUser({ name: 'Bob Second', org: ORG2 });
  carol = await createUser({ name: 'Carol Admin', role: 'admin', twoFactor: true, org: ORG2 });
  const a = await signIn(app, alice);
  await makeTask(a, { title: 'Task of the first company' });
  const b = await signIn(app, bob);
  await makeTask(b, { title: 'Task of the second company' });
});
after(teardown);
beforeEach(resetLimits);

const whoIs = async (agent) => {
  const res = await agent.get('/home');
  if (res.status !== 200) return null;
  return res.text.match(/<span class="me-name">([^<]+)<\/span>/)?.[1] ?? null;
};
const send = async (agent, path, body, from = '/home') => {
  const page = await agent.get(from);
  return agent.post(path).type('form').send({ _csrf: csrfIn(page.text), ...body });
};
// Adds an account through the "Add another account" sign-in.
async function addAccount(agent, user) {
  assert.equal((await agent.get('/accounts/add')).headers.location, '/login?add=1');
  const res = await send(agent, '/login', { email: user.email, password: PASSWORD, add: '1' }, '/login?add=1');
  if (res.headers.location === '/login/two-factor') {
    const page = await agent.get('/login/two-factor');
    await new Promise((r) => setTimeout(r, 5));
    return agent.post('/login/two-factor').type('form').send({ _csrf: csrfIn(page.text), code: currentCode(user.totpSecret) });
  }
  return res;
}

describe('signed in to several accounts', () => {
  test('adding an account keeps the first, and each works in its own company', async () => {
    const agent = await signIn(app, alice);
    const page = await agent.get('/login?add=1');
    assert.match(page.text, /Add another account/);
    assert.equal((await addAccount(agent, bob)).headers.location, '/home');
    assert.equal(await whoIs(agent), 'Bob Second');
    const board = await agent.get('/board');
    assert.match(board.text, /Task of the second company/);
    assert.doesNotMatch(board.text, /Task of the first company/);
    const home = await agent.get('/home');
    assert.match(home.text, /Switch to/);
    assert.match(home.text, /Alice First/);
    assert.match(home.text, /First Company/);

    assert.equal((await send(agent, '/accounts/switch', { to: alice.id })).headers.location, '/home');
    assert.equal(await whoIs(agent), 'Alice First');
    const back = await agent.get('/board');
    assert.match(back.text, /Task of the first company/);
    assert.doesNotMatch(back.text, /Task of the second company/);
  });

  test('a page left open from one account can\'t act as the other after switching', async () => {
    const agent = await signIn(app, alice);
    await addAccount(agent, bob);
    const old = csrfIn((await agent.get('/home')).text);
    await agent.post('/accounts/switch').type('form').send({ _csrf: old, to: alice.id });
    const res = await agent.post('/lang').type('form').send({ _csrf: old, lang: 'ar', next: '/home' });
    assert.equal(res.status, 403);
  });

  test('adding an account with two-step asks for its code and still keeps the first', async () => {
    const agent = await signIn(app, alice);
    const done = await addAccount(agent, carol);
    assert.equal(done.status, 302);
    assert.equal(await whoIs(agent), 'Carol Admin');
    assert.equal((await agent.get('/people')).status, 200, 'works as an admin in her own company');
    await send(agent, '/accounts/switch', { to: alice.id });
    assert.equal(await whoIs(agent), 'Alice First');
  });

  test('signing out of one account leaves the others; signing out of all ends them all', async () => {
    const agent = await signIn(app, alice);
    await addAccount(agent, bob);
    await send(agent, '/logout', {});
    assert.equal(await whoIs(agent), 'Alice First');
    assert.match((await agent.get('/home')).text, /Signed out of Bob Second/);
    await addAccount(agent, bob);
    await send(agent, '/logout/all', {});
    assert.equal(await whoIs(agent), null);
    assert.equal((await agent.get('/home')).headers.location, '/login?next=%2Fhome');
  });

  test('switching to an account that isn\'t signed in here does nothing', async () => {
    const agent = await signIn(app, alice);
    const res = await send(agent, '/accounts/switch', { to: bob.id });
    assert.equal(res.headers.location, '/home');
    assert.equal(await whoIs(agent), 'Alice First');
    assert.match((await agent.get('/home')).text, /isn’t signed in here/);
  });

  test('at most five accounts', async () => {
    const agent = await signIn(app, alice);
    for (let i = 0; i < 4; i += 1) {
      const extra = await createUser({ name: `Extra Person${i}`, org: ORG2 });
      assert.equal((await addAccount(agent, extra)).headers.location, '/home');
    }
    const res = await agent.get('/login?add=1');
    assert.equal(res.headers.location, '/home');
    assert.match((await agent.get('/home')).text, /5 accounts at most/);
  });
});

describe('when one account ends', () => {
  test('a password change drops only that account in this browser', async () => {
    const dave = await createUser({ name: 'Dave Changes' });
    const agent = await signIn(app, bob);
    await addAccount(agent, dave);
    assert.equal(await whoIs(agent), 'Dave Changes');
    await q('UPDATE users SET password_changed_at = now() WHERE id = $1', [dave.id]);
    await inOrg(ORG1, () => signOutEverywhere(dave.id));
    assert.equal(await whoIs(agent), 'Bob Second', 'Bob is still signed in');
    assert.doesNotMatch((await agent.get('/home')).text, /Dave Changes/);
  });

  test('a suspended company drops only its accounts', async () => {
    const agent = await signIn(app, alice);
    await addAccount(agent, bob);
    await q(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [ORG2]);
    try {
      assert.equal(await whoIs(agent), 'Alice First');
      assert.match((await agent.get('/home')).text, /still signed in to the others|One of your accounts/);
    } finally {
      await q(`UPDATE organizations SET status = 'active' WHERE id = $1`, [ORG2]);
    }
  });

  test('a disabled account can\'t be switched to', async () => {
    const erin = await createUser({ name: 'Erin Leaves' });
    const agent = await signIn(app, bob);
    await addAccount(agent, erin);
    await send(agent, '/accounts/switch', { to: bob.id });
    await q(`UPDATE users SET status = 'disabled' WHERE id = $1`, [erin.id]);
    await send(agent, '/accounts/switch', { to: erin.id });
    assert.equal(await whoIs(agent), 'Bob Second');
  });
});

describe('the menu in Arabic', () => {
  test('shows the accounts and the actions', async () => {
    const agent = await signIn(app, alice);
    await addAccount(agent, bob);
    await send(agent, '/lang', { lang: 'ar', next: '/home' });
    const page = await agent.get('/home');
    assert.match(page.text, /التبديل إلى/);
    assert.match(page.text, /الخروج من هذا الحساب/);
    assert.match(page.text, /First Company/);
  });
});

describe('not signed in', () => {
  test('adding an account needs a signed-in account first', async () => {
    const guest = request.agent(app);
    assert.equal((await guest.get('/accounts/add')).headers.location, '/login');
    const page = await guest.get('/login?add=1');
    assert.doesNotMatch(page.text, /name="add"/);
  });
});
