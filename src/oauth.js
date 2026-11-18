import { createHash, randomBytes } from 'node:crypto';
import { audit } from './audit.js';
import { hashToken, newToken } from './crypto.js';
import { one, q, tx } from './db.js';
import { rememberMs } from './devices.js';

// Connected apps (OAuth 2.1 authorization code flow with PKCE, public clients).
// Codes and tokens are random 256-bit values; only their hashes are stored.

export const SCOPES = ['tasks', 'offline_access'];
const CODE_TTL_S = 5 * 60;
const ACCESS_TTL_S = 60 * 60;

export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description || code);
    this.code = code;
    this.status = status;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(url) {
  return url && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.hash;
}

// May an app register this address to send people back to?
export function allowedRedirect(config, uri) {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  if (config.oauth.redirectUris.includes(uri)) return true;
  return config.oauth.allowLoopback && isLoopback(parseUrl(uri));
}

// Does the address in a request match one the app registered? Exact match,
// except that apps on the person's own computer may use any port.
export function matchRedirect(config, registered, uri) {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  if (registered.includes(uri)) return allowedRedirect(config, uri);
  const asked = parseUrl(uri);
  if (!config.oauth.allowLoopback || !isLoopback(asked)) return false;
  return registered.some((r) => {
    const reg = parseUrl(r);
    return isLoopback(reg) && reg.hostname === asked.hostname && reg.pathname === asked.pathname && reg.search === asked.search;
  });
}

// RFC 7636 S256: BASE64URL(SHA256(verifier)) must equal the challenge.
export function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return createHash('sha256').update(verifier).digest('base64url') === challenge;
}

export function normaliseScope(scope) {
  const parts = [...new Set(String(scope || 'tasks').split(/\s+/).filter(Boolean))];
  if (!parts.length || parts.some((s) => !SCOPES.includes(s))) return null;
  if (!parts.includes('tasks')) parts.unshift('tasks');
  return parts.join(' ');
}

export async function registerClient(config, { name, redirectUris }) {
  if (!redirectUris.length || redirectUris.some((u) => !allowedRedirect(config, u))) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris not allowed');
  }
  const id = randomBytes(18).toString('base64url');
  return one(
    'INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, $3) RETURNING id, name, redirect_uris, created_at',
    [id, name, redirectUris],
  );
}

export function findClient(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  return one('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = $1', [id]);
}

export async function createCode({ clientId, userId, redirectUri, codeChallenge, scope, resource }) {
  const code = newToken();
  await q(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
    [hashToken(code), clientId, userId, redirectUri, codeChallenge, scope, resource, CODE_TTL_S],
  );
  return code;
}

// Only people with an active account can hold a connection.
const ACCOUNT_OK = "u.status = 'active' AND u.email IS NOT NULL";

async function issueTokens(db, grantId, role, withRefresh) {
  const access = newToken();
  await db.query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $2, 'access', now() + make_interval(secs => $3))`,
    [hashToken(access), grantId, ACCESS_TTL_S],
  );
  const out = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S };
  if (withRefresh) {
    // A connection lasts as long as "Keep me signed in" for the person's role,
    // renewed each time it is used.
    const refresh = newToken();
    await db.query(
      `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1, $2, 'refresh', now() + make_interval(secs => $3))`,
      [hashToken(refresh), grantId, rememberMs(role) / 1000],
    );
    out.refresh_token = refresh;
  }
  return out;
}

async function revokeGrantIn(db, grantId) {
  await db.query('UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [grantId]);
  await db.query('UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL', [grantId]);
}

export async function exchangeCode({ clientId, code, redirectUri, codeVerifier, ip }) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT c.*, u.role, u.status, u.email FROM oauth_codes c JOIN users u ON u.id = c.user_id
       WHERE c.code_hash = $1 FOR UPDATE OF c`,
      [hashToken(code)],
    );
    const row = rows[0];
    if (!row || row.client_id !== clientId) throw new OAuthError('invalid_grant', 'code not valid');
    if (row.used_at) {
      // A code used twice may have been stolen: end the connection it made.
      if (row.grant_id) await revokeGrantIn(db, row.grant_id);
      throw new OAuthError('invalid_grant', 'code already used');
    }
    if (new Date(row.expires_at) <= new Date()) throw new OAuthError('invalid_grant', 'code expired');
    if (row.redirect_uri !== redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    if (!pkceMatches(codeVerifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'code_verifier mismatch');
    if (row.status !== 'active' || !row.email) throw new OAuthError('invalid_grant', 'account not active');
    const grant = (await db.query(
      'INSERT INTO oauth_grants (client_id, user_id, scope, resource) VALUES ($1, $2, $3, $4) RETURNING id',
      [row.client_id, row.user_id, row.scope, row.resource],
    )).rows[0];
    await db.query('UPDATE oauth_codes SET used_at = now(), grant_id = $2 WHERE code_hash = $1', [row.code_hash, grant.id]);
    const client = (await db.query('SELECT name FROM oauth_clients WHERE id = $1', [row.client_id])).rows[0];
    await audit(db, {
      actorId: row.user_id, action: 'auth.app_connected', subjectUserId: row.user_id, details: { grant: grant.id, app: client.name }, ip,
    });
    const tokens = await issueTokens(db, grant.id, row.role, row.scope.split(' ').includes('offline_access'));
    return { ...tokens, scope: row.scope };
  });
}

export async function refreshTokens({ clientId, refreshToken }) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT t.token_hash, t.expires_at, t.revoked_at, g.id AS grant_id, g.client_id, g.scope, g.revoked_at AS grant_revoked, u.role,
              (${ACCOUNT_OK}) AS account_ok
       FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
       WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
      [hashToken(refreshToken)],
    );
    const row = rows[0];
    if (!row || row.client_id !== clientId) throw new OAuthError('invalid_grant', 'refresh token not valid');
    if (row.revoked_at) {
      // An old refresh token came back after it was replaced: it may have
      // been copied, so the whole connection ends.
      if (!row.grant_revoked) await revokeGrantIn(db, row.grant_id);
      throw new OAuthError('invalid_grant', 'refresh token not valid');
    }
    if (row.grant_revoked || !row.account_ok || new Date(row.expires_at) <= new Date()) {
      throw new OAuthError('invalid_grant', 'refresh token not valid');
    }
    await db.query('UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1', [row.token_hash]);
    await db.query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [row.grant_id]);
    const tokens = await issueTokens(db, row.grant_id, row.role, true);
    return { ...tokens, scope: row.scope };
  });
}

// The person an access token acts for, or null. Checked on every call, so a
// disconnected app, a disabled account or a password change stops it at once.
export async function verifyAccessToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await one(
    `SELECT g.id AS grant_id, g.scope, g.resource, g.last_used_at, u.id, u.email, u.name, u.role, u.status, u.lang
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN users u ON u.id = g.user_id
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()
       AND g.revoked_at IS NULL AND ${ACCOUNT_OK}`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_used_at).getTime() > 5 * 60 * 1000) {
    await q('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [row.grant_id]);
  }
  const { grant_id: grantId, scope, resource, last_used_at: _lastUsed, ...user } = row;
  return { user, grantId, scope, resource };
}

export async function listGrants(userId) {
  const { rows } = await q(
    `SELECT g.id, c.name, g.created_at, g.last_used_at FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.revoked_at IS NULL AND t.expires_at > now())
     ORDER BY g.last_used_at DESC LIMIT 50`,
    [userId],
  );
  return rows;
}

// Only the person's own connections can be ended.
export async function revokeGrant(userId, grantId) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT g.id, c.name FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
       WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL FOR UPDATE OF g`,
      [grantId, userId],
    );
    if (!rows[0]) return null;
    await revokeGrantIn(db, grantId);
    return rows[0];
  });
}

export async function revokeAllGrants(userId) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE oauth_grants SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
      [userId],
    );
    if (rows.length) {
      await db.query('UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = ANY($1) AND revoked_at IS NULL', [rows.map((r) => r.id)]);
    }
    return rows.length;
  });
}

export async function pruneOAuth() {
  await q(`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`);
  await q(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`);
  // Apps registered but never connected, after a month.
  await q(`DELETE FROM oauth_clients c WHERE c.created_at < now() - interval '30 days'
           AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = c.id)`);
}
