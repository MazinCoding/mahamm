import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { currentCode } from '../src/totp.js';
import { ORG1, PASSWORD, connectApp, createUser, csrfIn, makeTask, post, q, resetLimits, setup, signIn, teardown } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
const TOKEN = randomBytes(18).toString('hex');
const ADMIN = { email: 'platform.admin@example.com', name: 'Platform Person' };

let app;
let owner; let ownerAgent;
let platform; // the signed-in platform agent
let secret;
let recovery;

before(async () => {
  ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN, PLATFORM_SETUP_TOKEN: TOKEN }));
  owner = await createUser({ name: 'Company Owner', role: 'superadmin', twoFactor: true });
  ownerAgent = await signIn(app, owner);
  await makeTask(ownerAgent, { title: 'Private company plan' });
});
after(teardown);
beforeEach(resetLimits);

const companyStatus = async () => (await q('SELECT status, plan, name FROM organizations WHERE id = $1', [ORG1])).rows[0];
const send = async (agent, path, body, from) => {
  const page = await agent.get(from);
  return agent.post(path).type('form').send({ _csrf: csrfIn(page.text), ...body });
};

describe('setting up the platform admin', () => {
  test('nobody can use the platform pages before set-up, and the token is required', async () => {
    const guest = request.agent(app);
    assert.equal((await guest.get('/platform/login')).headers.location, '/platform/setup');
    assert.equal((await guest.get('/platform')).headers.location, '/platform/login');
    const wrong = await send(guest, '/platform/setup', { setup_token: 'x'.repeat(36), ...ADMIN, password: PASSWORD, confirm: PASSWORD }, '/platform/setup');
    assert.equal(wrong.status, 403);
    assert.equal((await q('SELECT count(*)::int AS n FROM platform_admins')).rows[0].n, 0);
  });

  test('set-up, then two-step before anything else, then recovery codes', async () => {
    platform = request.agent(app);
    const res = await send(platform, '/platform/setup', { setup_token: TOKEN, ...ADMIN, password: PASSWORD, confirm: PASSWORD }, '/platform/setup');
    assert.equal(res.headers.location, '/platform/two-step');
    assert.equal((await platform.get('/platform')).headers.location, '/platform/login', 'not signed in until two-step is set up');
    const page = await platform.get('/platform/two-step');
    secret = page.text.match(/<code dir="ltr">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
    const done = await platform.post('/platform/two-step').type('form').send({ _csrf: csrfIn(page.text), code: currentCode(secret) });
    assert.equal(done.status, 200);
    recovery = [...done.text.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((m) => m[1]);
    assert.equal(recovery.length, 8);
    assert.equal((await platform.get('/platform')).status, 200);
    assert.equal((await platform.get('/platform/setup')).status, 404, 'set-up only works once');
  });
});

describe('signing in', () => {
  test('password, then always a code; a recovery code works once', async () => {
    await q('UPDATE platform_admins SET totp_last_step = 0');
    const agent = request.agent(app);
    const login = await send(agent, '/platform/login', { email: ADMIN.email, password: PASSWORD }, '/platform/login');
    assert.equal(login.headers.location, '/platform/code');
    assert.equal((await agent.get('/platform')).headers.location, '/platform/login');
    const wrong = await send(agent, '/platform/code', { code: '000000' }, '/platform/code');
    assert.equal(wrong.status, 401);
    const ok = await send(agent, '/platform/code', { code: recovery[0] }, '/platform/code');
    assert.equal(ok.headers.location, '/platform');
    const again = request.agent(app);
    await send(again, '/platform/login', { email: ADMIN.email, password: PASSWORD }, '/platform/login');
    assert.equal((await send(again, '/platform/code', { code: recovery[0] }, '/platform/code')).status, 401);
  });

  test('a wrong password is refused', async () => {
    const agent = request.agent(app);
    const res = await send(agent, '/platform/login', { email: ADMIN.email, password: 'not the password at all' }, '/platform/login');
    assert.equal(res.status, 401);
  });

  test('company accounts and platform accounts are separate', async () => {
    assert.equal((await ownerAgent.get('/platform')).headers.location, '/platform/login', 'a company owner is not a platform admin');
    const res = await send(request.agent(app), '/platform/login', { email: owner.email, password: PASSWORD }, '/platform/login');
    assert.equal(res.status, 401);
    assert.equal((await platform.get('/board')).status, 302, 'the platform admin is not signed in to a company');
  });

  test('signing in to the platform in the same browser keeps the company sign-in', async () => {
    await q('UPDATE platform_admins SET totp_last_step = 0');
    await send(ownerAgent, '/platform/login', { email: ADMIN.email, password: PASSWORD }, '/platform/login');
    await send(ownerAgent, '/platform/code', { code: currentCode(secret) }, '/platform/code');
    assert.equal((await ownerAgent.get('/platform')).status, 200);
    assert.equal((await ownerAgent.get('/board')).status, 200);
    await send(ownerAgent, '/platform/logout', {}, '/platform');
    assert.equal((await ownerAgent.get('/platform')).headers.location, '/platform/login');
    assert.equal((await ownerAgent.get('/board')).status, 200);
  });

  test('the sign-in page in Arabic', async () => {
    const agent = request.agent(app);
    await send(agent, '/lang', { lang: 'ar', next: '/platform/login' }, '/platform/login');
    assert.match((await agent.get('/platform/login')).text, /دخول المنصة/);
  });
});

describe('companies', () => {
  test('the list shows names, plans and counts, never tasks', async () => {
    const list = await platform.get('/platform');
    assert.match(list.text, /Organization 1/);
    assert.doesNotMatch(list.text, /Private company plan/);
    const page = await platform.get(`/platform/companies/${ORG1}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /Private company plan|Company Owner/);
  });

  test('renaming is recorded for the platform and in the company\'s own history', async () => {
    await send(platform, `/platform/companies/${ORG1}/rename`, { name: 'Acme Test Co' }, `/platform/companies/${ORG1}`);
    assert.equal((await companyStatus()).name, 'Acme Test Co');
    const p = (await q(`SELECT action, details FROM platform_audit WHERE action = 'org.renamed'`)).rows[0];
    assert.deepEqual(p.details, { from: 'Organization 1', to: 'Acme Test Co' });
    const e = (await q(`SELECT org_id, actor_id, details FROM audit_events WHERE action = 'org.renamed'`)).rows[0];
    assert.equal(e.org_id, ORG1);
    assert.equal(e.actor_id, null);
    assert.equal(e.details.by, 'platform');
    const history = await ownerAgent.get('/audit');
    assert.match(history.text, /The Mahamm team/);
    assert.match(history.text, /renamed the company from Organization 1 to Acme Test Co/);
  });

  test('changing the plan', async () => {
    await send(platform, `/platform/companies/${ORG1}/plan`, { plan: 'enterprise' }, `/platform/companies/${ORG1}`);
    assert.equal((await companyStatus()).plan, 'enterprise');
    await send(platform, `/platform/companies/${ORG1}/plan`, { plan: 'gold' }, `/platform/companies/${ORG1}`);
    assert.equal((await companyStatus()).plan, 'enterprise');
  });

  test('only a waiting company can be approved', async () => {
    const res = await send(platform, `/platform/companies/${ORG1}/status`, { action: 'approve' }, `/platform/companies/${ORG1}`);
    assert.equal(res.status, 302);
    assert.equal((await companyStatus()).status, 'active');
    assert.match((await platform.get(`/platform/companies/${ORG1}`)).text, /isn’t possible/);
  });

  test('suspending signs the company out, blocks sign-in and the connector; reactivating opens it again', async () => {
    const member = await createUser({ name: 'Company Member' });
    const memberAgent = await signIn(app, member);
    const token = await connectApp(app, member, RETURN);
    const call = () => request(app).post('/connector').set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'my_work', arguments: {} } });

    await send(platform, `/platform/companies/${ORG1}/status`, { action: 'suspend' }, `/platform/companies/${ORG1}`);
    assert.equal((await companyStatus()).status, 'suspended');
    assert.equal((await memberAgent.get('/home')).status, 302, 'signed out');
    const login = await send(request.agent(app), '/login', { email: member.email, password: PASSWORD }, '/login');
    assert.equal(login.status, 403);
    assert.match(login.text, /suspended/);
    assert.equal((await call()).status, 401);

    await send(platform, `/platform/companies/${ORG1}/status`, { action: 'reactivate' }, `/platform/companies/${ORG1}`);
    assert.equal((await companyStatus()).status, 'active');
    assert.equal((await send(request.agent(app), '/login', { email: member.email, password: PASSWORD }, '/login')).status, 302);
    assert.equal((await call()).status, 200);
  });

  test('company people can\'t change companies through the platform routes', async () => {
    const res = await post(ownerAgent, `/platform/companies/${ORG1}/plan`, { plan: 'hobbyist' });
    assert.equal(res.headers.location, '/platform/login');
    assert.equal((await companyStatus()).plan, 'enterprise');
  });

  test('the platform log is append-only', async () => {
    await assert.rejects(q(`UPDATE platform_audit SET action = 'x'`), /append-only/);
    await assert.rejects(q('DELETE FROM platform_audit'), /append-only/);
  });
});
