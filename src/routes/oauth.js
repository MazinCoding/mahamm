import express from 'express';
import { requireAuth } from '../auth.js';
import {
  OAuthError, SCOPES, createCode, exchangeCode, findClient, matchRedirect, normaliseScope, refreshTokens, registerClient,
} from '../oauth.js';
import { limiter } from '../ratelimit.js';
import { HttpError } from '../services/tasks.js';
import { authorizeSchema, parse, registerClientSchema, tokenSchema } from '../validation.js';

function oauthError(res, status, error, description) {
  res.status(status).json(description ? { error, error_description: description } : { error });
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

// Public client id from the body, or from HTTP Basic if the app sends it there.
function clientIdFrom(req) {
  if (typeof req.body?.client_id === 'string') return req.body.client_id;
  const m = String(req.headers.authorization || '').match(/^Basic ([A-Za-z0-9+/=]+)$/);
  if (!m) return '';
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  return decodeURIComponent(decoded.split(':')[0] || '');
}

// Endpoints apps call directly (no browser, no session). Mounted before the
// session and CSRF middleware; each has its own rate limit.
export function oauthApiRoutes(config) {
  const r = express.Router();
  if (!config.oauth.enabled) return r;
  const { issuer } = config.oauth;

  r.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    });
  });

  r.post('/oauth/register', limiter({ name: 'oauth-register', limit: 20, windowSeconds: 3600, by: 'ip' }), async (req, res) => {
    noStore(res);
    if (!req.is('application/json')) return oauthError(res, 400, 'invalid_client_metadata');
    const { data, errors } = parse(registerClientSchema, req.body || {});
    if (errors) return oauthError(res, 400, 'invalid_client_metadata');
    try {
      const client = await registerClient(config, { name: data.client_name, redirectUris: data.redirect_uris });
      req.log?.info({ client: client.id }, 'app registered');
      return res.status(201).json({
        client_id: client.id,
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
        client_name: client.name,
        redirect_uris: client.redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(res, 400, err.code);
      throw err;
    }
  });

  r.post('/oauth/token', limiter({ name: 'oauth-token', limit: 120, windowSeconds: 300, by: 'ip' }), async (req, res) => {
    noStore(res);
    if (!req.is('application/x-www-form-urlencoded')) return oauthError(res, 400, 'invalid_request');
    const grantType = req.body?.grant_type;
    if (!['authorization_code', 'refresh_token'].includes(grantType)) return oauthError(res, 400, 'unsupported_grant_type');
    const { data, errors } = parse(tokenSchema, { ...req.body, client_id: clientIdFrom(req) });
    if (errors) return oauthError(res, 400, 'invalid_request');
    const client = await findClient(data.client_id);
    if (!client) return oauthError(res, 401, 'invalid_client');
    try {
      const result = grantType === 'authorization_code'
        ? await exchangeCode({ clientId: client.id, code: data.code, redirectUri: data.redirect_uri, codeVerifier: data.code_verifier, ip: req.ip })
        : await refreshTokens({ clientId: client.id, refreshToken: data.refresh_token });
      return res.json(result);
    } catch (err) {
      if (err instanceof OAuthError) {
        req.log?.warn({ reason: err.message }, 'token request refused');
        return oauthError(res, err.status, err.code);
      }
      throw err;
    }
  });

  return r;
}

// Sends the person back to the app with the result. Only ever called with an
// address the app registered and the request matched.
function backToApp(res, redirectUri, params, status = 302) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  return res.redirect(status, url.toString());
}

// Checks an authorization request (query string or the consent form).
// Throws HttpError when the app or return address can't be trusted (shown as
// an error page here); otherwise returns either { error } for the app or the
// checked values.
async function checkRequest(config, input) {
  const client = await findClient(typeof input.client_id === 'string' ? input.client_id : '');
  const redirectUri = typeof input.redirect_uri === 'string' ? input.redirect_uri : '';
  if (!client || !matchRedirect(config, client.redirect_uris, redirectUri)) throw new HttpError(400, 'unknown app or return address');
  const state = typeof input.state === 'string' ? input.state.slice(0, 1000) : undefined;
  const { data, errors } = parse(authorizeSchema, input);
  if (errors) return { client, redirectUri, state, error: 'invalid_request' };
  const scope = normaliseScope(data.scope);
  if (!scope) return { client, redirectUri, state, error: 'invalid_scope' };
  if (data.resource && data.resource !== config.oauth.resource) return { client, redirectUri, state, error: 'invalid_target' };
  return { client, redirectUri, state, scope, codeChallenge: data.code_challenge, resource: data.resource || null };
}

// The consent page and its form. Needs a signed-in person (normal sign-in,
// including two-step for admins).
export function oauthConsentRoutes(config) {
  const r = express.Router();
  if (!config.oauth.enabled) return r;
  const iss = config.oauth.issuer;

  r.get('/oauth/authorize', requireAuth, async (req, res) => {
    const checked = await checkRequest(config, req.query);
    if (checked.error) return backToApp(res, checked.redirectUri, { error: checked.error, state: checked.state, iss });
    const target = new URL(checked.redirectUri);
    // The approve button sends the browser on to the app's address, so this
    // page's form-action must allow that one origin (and nothing else).
    const csp = String(res.getHeader('Content-Security-Policy') || '');
    res.setHeader('Content-Security-Policy', csp.replace("form-action 'self'", `form-action 'self' ${target.origin}`));
    res.render('oauth/consent.njk', {
      client: checked.client,
      host: target.host,
      loopback: target.protocol === 'http:',
      fields: {
        response_type: 'code',
        client_id: checked.client.id,
        redirect_uri: checked.redirectUri,
        code_challenge: checked.codeChallenge,
        code_challenge_method: 'S256',
        state: checked.state || '',
        scope: checked.scope,
        resource: checked.resource || '',
      },
    });
  });

  r.post('/oauth/authorize', requireAuth, limiter({ name: 'oauth-consent', limit: 30, windowSeconds: 900 }), async (req, res) => {
    const input = { ...req.body };
    for (const k of ['state', 'resource']) if (input[k] === '') delete input[k];
    const checked = await checkRequest(config, input);
    if (checked.error) return backToApp(res, checked.redirectUri, { error: checked.error, state: checked.state, iss }, 303);
    if (req.body.decision !== 'allow') {
      return backToApp(res, checked.redirectUri, { error: 'access_denied', state: checked.state, iss }, 303);
    }
    const code = await createCode({
      clientId: checked.client.id,
      userId: req.user.id,
      redirectUri: checked.redirectUri,
      codeChallenge: checked.codeChallenge,
      scope: checked.scope,
      resource: checked.resource,
    });
    return backToApp(res, checked.redirectUri, { code, state: checked.state, iss }, 303);
  });

  return r;
}
