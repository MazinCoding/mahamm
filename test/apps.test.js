import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { signOutEverywhere } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { q } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { verifyAccessToken } from '../src/oauth.js';
import { createUser, post, resetLimits, setup, signIn, teardown, testEnv } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
let app;
let config;
before(async () => ({ app, config } = await setup({ OAUTH_REDIRECT_URIS: RETURN })));
after(teardown);
beforeEach(resetLimits);

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const register = (body = { client_name: 'Test app', redirect_uris: [RETURN] }) => request(app).post('/oauth/register').send(body);
const token = (body) => request(app).post('/oauth/token').type('form').send(body);

function authorizeUrl(clientId, challenge, extra = {}) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: RETURN,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'tasks offline_access',
    resource: config.oauth.resource,
    ...extra,
  });
  return `/oauth/authorize?${p}`;
}

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Hidden fields of the consent form only (not the language switcher).
function consentFields(html) {
  const form = html.slice(html.indexOf('action="/oauth/authorize"'));
  const out = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[m[1]] = unescape(m[2]);
  return out;
}

async function newClient() {
  const res = await register();
  assert.equal(res.status, 201);
  return res.body.client_id;
}

// The whole approval in the browser: returns the code sent back to the app.
async function approve(agent, clientId) {
  const { verifier, challenge } = pkce();
  const page = await agent.get(authorizeUrl(clientId, challenge));
  assert.equal(page.status, 200);
  const res = await agent.post('/oauth/authorize').type('form').send({ ...consentFields(page.text), decision: 'allow' });
  assert.equal(res.status, 303);
  const back = new URL(res.headers.location);
  return { back, code: back.searchParams.get('code'), verifier };
}

async function connect(user) {
  const agent = await signIn(app, user);
  const clientId = await newClient();
  const { code, verifier } = await approve(agent, clientId);
  const res = await token({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: RETURN, code_verifier: verifier });
  assert.equal(res.status, 200, res.text);
  return { agent, clientId, tokens: res.body };
}

describe('connected apps: setup and discovery', () => {
  test('off unless return addresses are set', async () => {
    const plain = loadConfig(testEnv);
    const off = createApp(plain, createLogger(plain));
    assert.equal(plain.oauth.enabled, false);
    assert.equal((await request(off).get('/.well-known/oauth-authorization-server')).status, 404);
    assert.equal((await request(off).get('/oauth/authorize?client_id=x')).status, 404);
  });

  test('a return address must be https', () => {
    assert.throws(() => loadConfig({ ...testEnv, OAUTH_REDIRECT_URIS: 'http://app.example.test/cb' }), /OAUTH_REDIRECT_URIS/);
  });

  test('metadata describes the sign-in endpoints', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    assert.equal(res.status, 200);
    assert.equal(res.body.issuer, config.origin);
    assert.equal(res.body.token_endpoint, `${config.origin}/oauth/token`);
    assert.deepEqual(res.body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(res.body.token_endpoint_auth_methods_supported, ['none']);
    assert.ok(res.body.scopes_supported.includes('offline_access'));
  });

  test('apps can register only the allowed return addresses', async () => {
    const ok = await register();
    assert.equal(ok.status, 201);
    assert.match(ok.body.client_id, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(ok.body.token_endpoint_auth_method, 'none');
    assert.equal(ok.headers['cache-control'], 'no-store');

    const elsewhere = await register({ client_name: 'Other', redirect_uris: ['https://evil.example.test/cb'] });
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.error, 'invalid_redirect_uri');

    const secret = await register({ client_name: 'X', redirect_uris: [RETURN], token_endpoint_auth_method: 'client_secret_basic' });
    assert.equal(secret.body.error, 'invalid_client_metadata');

    const form = await request(app).post('/oauth/register').type('form').send({ client_name: 'X', redirect_uris: RETURN });
    assert.equal(form.status, 400);
  });
});

describe('connected apps: approving', () => {
  test('signed-out people are sent to sign in first, then back', async () => {
    const res = await request(app).get(authorizeUrl(await newClient(), pkce().challenge));
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login\?next=%2Foauth%2Fauthorize/);
  });

  test('an unknown app or return address shows an error here, never redirects', async () => {
    const agent = await signIn(app, await createUser());
    const unknown = await agent.get(authorizeUrl('nosuchclient000000000000', pkce().challenge));
    assert.equal(unknown.status, 400);
    const clientId = await newClient();
    const wrongReturn = await agent.get(authorizeUrl(clientId, pkce().challenge, { redirect_uri: 'https://app.example.test/other' }));
    assert.equal(wrongReturn.status, 400);
    assert.equal(wrongReturn.headers.location, undefined);
  });

  test('the consent page names the app safely and allows only its return address', async () => {
    const agent = await signIn(app, await createUser({ name: 'Salma Al Harthi' }));
    const reg = await register({ client_name: '<b>Tasks helper</b>', redirect_uris: [RETURN] });
    const page = await agent.get(authorizeUrl(reg.body.client_id, pkce().challenge));
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('&lt;b&gt;Tasks helper&lt;/b&gt;'));
    assert.ok(!page.text.includes('<b>Tasks helper</b>'));
    assert.ok(page.text.includes('app.example.test'));
    assert.ok(page.text.includes('Salma Al Harthi'));
    assert.match(page.headers['content-security-policy'], /form-action 'self' https:\/\/app\.example\.test(;|$)/);
  });

  test('the consent page is in Arabic, right to left, for Arabic users', async () => {
    const user = await createUser();
    await q("UPDATE users SET lang = 'ar' WHERE id = $1", [user.id]);
    const agent = await signIn(app, user);
    const page = await agent.get(authorizeUrl(await newClient(), pkce().challenge));
    assert.match(page.text, /<html lang="ar" dir="rtl">/);
    assert.ok(page.text.includes('ربط تطبيق'));
  });

  test('bad requests go back to the app with an error and the state', async () => {
    const agent = await signIn(app, await createUser());
    const clientId = await newClient();
    const noPkce = await agent.get(authorizeUrl(clientId, pkce().challenge, { code_challenge_method: 'plain' }));
    assert.equal(noPkce.status, 302);
    const back = new URL(noPkce.headers.location);
    assert.equal(back.origin + back.pathname, RETURN);
    assert.equal(back.searchParams.get('error'), 'invalid_request');
    assert.equal(back.searchParams.get('state'), 'xyz');

    const otherResource = await agent.get(authorizeUrl(clientId, pkce().challenge, { resource: 'https://elsewhere.example.test/x' }));
    assert.equal(new URL(otherResource.headers.location).searchParams.get('error'), 'invalid_target');

    const badScope = await agent.get(authorizeUrl(clientId, pkce().challenge, { scope: 'admin' }));
    assert.equal(new URL(badScope.headers.location).searchParams.get('error'), 'invalid_scope');
  });

  test('cancelling tells the app the person said no', async () => {
    const agent = await signIn(app, await createUser());
    const page = await agent.get(authorizeUrl(await newClient(), pkce().challenge));
    const res = await agent.post('/oauth/authorize').type('form').send({ ...consentFields(page.text), decision: 'deny' });
    const back = new URL(res.headers.location);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('code'), null);
  });

  test('an admin without two-step verification must turn it on first', async () => {
    const admin = await createUser({ role: 'admin' });
    const agent = await signIn(app, admin);
    const res = await agent.get(authorizeUrl(await newClient(), pkce().challenge));
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/settings/two-factor');
  });
});

describe('connected apps: tokens', () => {
  test('a code becomes tokens once, with PKCE, and the connection is audited', async () => {
    const user = await createUser();
    const agent = await signIn(app, user);
    const clientId = await newClient();
    const { back, code, verifier } = await approve(agent, clientId);
    assert.equal(back.searchParams.get('state'), 'xyz');
    assert.equal(back.searchParams.get('iss'), config.origin);

    const wrongVerifier = await token({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: RETURN, code_verifier: pkce().verifier });
    assert.equal(wrongVerifier.status, 400);
    assert.equal(wrongVerifier.body.error, 'invalid_grant');

    const ok = await token({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: RETURN, code_verifier: verifier });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal(ok.body.token_type, 'Bearer');
    assert.ok(ok.body.refresh_token);
    const who = await verifyAccessToken(ok.body.access_token);
    assert.equal(who.user.id, user.id);

    const stored = await q('SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash = $1', [ok.body.access_token]);
    assert.equal(stored.rows[0].n, 0, 'raw tokens are never stored');

    const events = await q("SELECT details FROM audit_events WHERE action = 'auth.app_connected' AND actor_id = $1", [user.id]);
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].details.app, 'Test app');

    // Using the same code again ends the connection it created.
    const replay = await token({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: RETURN, code_verifier: verifier });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal(await verifyAccessToken(ok.body.access_token), null);
  });

  test('a code only works for the app and return address it was made for', async () => {
    const agent = await signIn(app, await createUser());
    const clientId = await newClient();
    const other = await newClient();
    const first = await approve(agent, clientId);
    const wrongApp = await token({ grant_type: 'authorization_code', client_id: other, code: first.code, redirect_uri: RETURN, code_verifier: first.verifier });
    assert.equal(wrongApp.body.error, 'invalid_grant');
    const second = await approve(agent, clientId);
    const wrongReturn = await token({ grant_type: 'authorization_code', client_id: clientId, code: second.code, redirect_uri: `${RETURN}x`, code_verifier: second.verifier });
    assert.equal(wrongReturn.body.error, 'invalid_grant');
    const unknownApp = await token({ grant_type: 'authorization_code', client_id: 'nosuchclient000000000000', code: second.code, redirect_uri: RETURN, code_verifier: second.verifier });
    assert.equal(unknownApp.status, 401);
    assert.equal(unknownApp.body.error, 'invalid_client');
    const badGrant = await token({ grant_type: 'password', client_id: clientId });
    assert.equal(badGrant.body.error, 'unsupported_grant_type');
  });

  test('refresh tokens rotate, and a replayed one ends the connection', async () => {
    const { clientId, tokens } = await connect(await createUser());
    const next = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    assert.equal(next.status, 200);
    assert.notEqual(next.body.refresh_token, tokens.refresh_token);
    assert.ok(await verifyAccessToken(next.body.access_token));

    const replay = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal(await verifyAccessToken(next.body.access_token), null);
    const afterReplay = await token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: next.body.refresh_token });
    assert.equal(afterReplay.body.error, 'invalid_grant');
  });

  test('a disabled account or a password change stops the app at once', async () => {
    const disabled = await createUser();
    const a = await connect(disabled);
    await q("UPDATE users SET status = 'disabled' WHERE id = $1", [disabled.id]);
    assert.equal(await verifyAccessToken(a.tokens.access_token), null);
    const refresh = await token({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.tokens.refresh_token });
    assert.equal(refresh.body.error, 'invalid_grant');

    const changed = await createUser();
    const b = await connect(changed);
    await signOutEverywhere(changed.id);
    assert.equal(await verifyAccessToken(b.tokens.access_token), null);
  });
});

describe('connected apps: settings', () => {
  test('people see and disconnect their own apps, audited', async () => {
    const user = await createUser();
    const { agent, tokens } = await connect(user);
    const page = await agent.get('/settings');
    assert.match(page.text, /id="apps"/);
    assert.ok(page.text.includes('Test app'));
    const grant = (await q('SELECT id FROM oauth_grants WHERE user_id = $1 AND revoked_at IS NULL', [user.id])).rows[0];

    const res = await post(agent, `/settings/apps/${grant.id}/disconnect`, {}, '/settings');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/settings#apps');
    assert.equal(await verifyAccessToken(tokens.access_token), null);
    const events = await q("SELECT details FROM audit_events WHERE action = 'auth.app_disconnected' AND actor_id = $1", [user.id]);
    assert.equal(events.rows[0].details.grant, grant.id);
  });

  test("nobody can disconnect someone else's app", async () => {
    const owner = await createUser();
    const { tokens } = await connect(owner);
    const grant = (await q('SELECT id FROM oauth_grants WHERE user_id = $1', [owner.id])).rows[0];
    const other = await signIn(app, await createUser());
    const res = await post(other, `/settings/apps/${grant.id}/disconnect`, {}, '/settings');
    assert.equal(res.status, 404);
    assert.ok(await verifyAccessToken(tokens.access_token));
  });

  test('disconnect all ends every connection', async () => {
    const user = await createUser();
    const one = await connect(user);
    const agent = one.agent;
    const clientId = await newClient();
    const second = await approve(agent, clientId);
    const two = await token({ grant_type: 'authorization_code', client_id: clientId, code: second.code, redirect_uri: RETURN, code_verifier: second.verifier });
    const res = await post(agent, '/settings/apps/disconnect-all', {}, '/settings');
    assert.equal(res.status, 302);
    assert.equal(await verifyAccessToken(one.tokens.access_token), null);
    assert.equal(await verifyAccessToken(two.body.access_token), null);
    const events = await q("SELECT details FROM audit_events WHERE action = 'auth.apps_disconnected' AND actor_id = $1", [user.id]);
    assert.equal(events.rows[0].details.count, 2);
  });
});
