import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { csrfSync } from 'csrf-sync';
import { asSystem, getPool, q, setOrg } from './db.js';
import { forgetAllDevices, rememberMs } from './devices.js';
import { revokeAllGrants } from './oauth.js';
import { isAdmin } from './roles.js';

const ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // sign in again at least weekly
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // or after 12 hours without activity
// "Keep me signed in" sessions last up to the remembered-device period for the
// person's current role (30 days for admins and above, 90 for members and trainees), renewed on use.
const lifetimeMs = (session, role) => (session.keep ? rememberMs(role) : ABSOLUTE_LIFETIME_MS);

export function sessionMiddleware(config) {
  const PgStore = connectPgSimple(session);
  return session({
    name: config.isProd ? '__Host-mahamm.sid' : 'mahamm.sid',
    secret: config.sessionSecrets,
    store: new PgStore({ pool: getPool(), tableName: 'session', createTableIfMissing: false, pruneSessionInterval: 15 * 60 }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: config.isProd,
    cookie: {
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: IDLE_TIMEOUT_MS,
    },
  });
}

const csrf = csrfSync({
  getTokenFromRequest: (req) => (req.body && req.body._csrf) || req.headers['x-csrf-token'],
});
export const csrfProtection = csrf.csrfSynchronisedProtection;
export const csrfToken = (req) => csrf.generateToken(req);
export const rotateCsrf = (req) => csrf.generateToken(req, true);

// Multipart bodies are only parsed on upload routes, which check the token
// themselves right after parsing. Everything else is checked here.
export function csrfUnlessMultipart(req, res, next) {
  if (req.is('multipart/form-data')) return next();
  return csrfProtection(req, res, next);
}

const USER_COLUMNS = `id, org_id, email, name, role, status, lang, email_notifications, totp_enabled, password_changed_at, last_seen_at,
  (SELECT o.status FROM organizations o WHERE o.id = users.org_id) AS org_status,
  (SELECT o.name FROM organizations o WHERE o.id = users.org_id) AS org_name`;

// One browser can be signed in to several accounts (each in its own company)
// and switch between them. The current account lives in the session's usual
// fields; the others wait in `others`, each with its own sign-in time, password
// version and keep-signed-in choice, and are checked again when switched to.
export const MAX_ACCOUNTS = 5;

function currentEntry(req) {
  const s = req.session;
  return {
    userId: s.userId, pwv: s.pwv, createdAt: s.createdAt, keep: !!s.keep,
    name: req.user?.name ?? null, email: req.user?.email ?? null, orgName: req.user?.org_name ?? null,
  };
}

function useEntry(req, entry) {
  req.session.userId = entry.userId;
  req.session.pwv = entry.pwv;
  req.session.createdAt = entry.createdAt;
  if (entry.keep) req.session.keep = true;
  else delete req.session.keep;
}

// Switch to another signed-in account. Returns false if it isn't one.
export function switchAccount(req, userId) {
  const others = req.session.others || [];
  const target = others.find((e) => e.userId === userId);
  if (!target) return false;
  req.session.others = [currentEntry(req), ...others.filter((e) => e.userId !== userId)];
  useEntry(req, target);
  return true;
}

// Sign out of the current account only. Returns false if it was the last one.
export function dropCurrentAccount(req) {
  const [next, ...rest] = req.session.others || [];
  if (!next) return false;
  req.session.others = rest;
  useEntry(req, next);
  return true;
}

export const otherAccounts = (req) => req.session?.others || [];

export async function findUserById(id) {
  const { rows } = await q(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}
function save(req) {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}
export function destroySession(req) {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

// New session id on every sign-in (prevents session fixation).
// With `keep`, the cookie outlives the browser and the idle timeout grows to
// the keep-signed-in period for the person's role.
// With `add`, the accounts already signed in stay signed in, and this one
// becomes the current account.
export async function startSession(req, user, { keep = false, add = false } = {}) {
  const lang = req.session?.lang;
  const kept = add && req.session?.userId
    ? [currentEntry(req), ...otherAccounts(req)].filter((e) => e.userId !== user.id).slice(0, MAX_ACCOUNTS - 1)
    : [];
  const keptMaxAge = kept.length ? req.session.cookie.maxAge : 0;
  await regenerate(req);
  req.session.userId = user.id;
  req.session.pwv = new Date(user.password_changed_at).toISOString();
  req.session.createdAt = Date.now();
  req.session.lang = lang;
  if (kept.length) req.session.others = kept;
  if (keep && user.role) {
    req.session.keep = true;
    req.session.cookie.maxAge = rememberMs(user.role);
  }
  // The cookie lasts as long as the longest-lasting account in it.
  if (keptMaxAge > (req.session.cookie.maxAge || 0)) req.session.cookie.maxAge = keptMaxAge;
  await save(req);
}

// Used before the second sign-in step: password is right, code not yet given.
// When adding an account, the accounts already signed in stay as they are.
export async function startPendingSession(req, user, { add = false } = {}) {
  const lang = req.session?.lang;
  if (!add) await regenerate(req);
  req.session.pendingUserId = user.id;
  req.session.pendingAt = Date.now();
  req.session.lang = lang;
  await save(req);
}

// Used on a password change or reset and when an account is disabled: every
// other session ends, every remembered device has to give a code again, and
// every connected app has to be approved again.
export async function signOutEverywhere(userId, exceptSid = null) {
  // Browsers signed in to other accounts too keep those: there, the password
  // change or the disabled account makes loadUser drop just this account.
  await q(
    `DELETE FROM "session" WHERE sess->>'userId' = $1 AND coalesce(json_array_length(sess->'others'), 0) = 0 AND sid IS DISTINCT FROM $2`,
    [userId, exceptSid],
  );
  await forgetAllDevices(userId);
  await revokeAllGrants(userId);
}

export function loadUser() {
  return async function load(req, res, next) {
    for (;;) {
      const id = req.session?.userId;
      if (!id) {
        // Between the password and the two-step code, the request works in that
        // person's organization so the code can be checked.
        const pending = req.session?.pendingUserId ? await asSystem(() => findUserById(req.session.pendingUserId)) : null;
        if (pending) setOrg(pending.org_id);
        return next();
      }
      // The account is found across all organizations; everything after this
      // runs in its organization only.
      const user = await asSystem(() => findUserById(id));
      const tooOld = !req.session.createdAt || !user || Date.now() - req.session.createdAt > lifetimeMs(req.session, user.role);
      const stale = !user || req.session.pwv !== new Date(user.password_changed_at).toISOString();
      // A company that is suspended or not yet approved signs its people out.
      const companyClosed = user && user.org_status !== 'active';
      if (!user || user.status !== 'active' || !user.email || tooOld || stale || companyClosed) {
        // Signed in to other accounts too: drop only this one and carry on with the next.
        if (dropCurrentAccount(req)) {
          req.session.flashKey = 'accounts.droppedOne';
          continue;
        }
        // Swap in a fresh, signed-out session (not none at all): later middleware
        // still needs one for the CSRF token and the chosen language.
        const lang = req.session.lang;
        await regenerate(req);
        req.session.lang = lang;
        return next();
      }
      req.user = user;
      setOrg(user.org_id);
      if (!req.session.seenAt || Date.now() - req.session.seenAt > 5 * 60 * 1000) {
        req.session.seenAt = Date.now();
        await q('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
      }
      return next();
    }
  };
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    const nextPath = req.originalUrl && req.originalUrl !== '/' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/login${nextPath}`);
  }
  const err = new Error('not signed in');
  err.status = 401;
  return next(err);
}

// Admin-only routes deny by default; the check runs on the server.
export function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  const err = new Error('admins only');
  err.status = 403;
  return next(err);
}

// Admins (and executives and the superadmin) must turn on two-step verification before they can do anything else.
const ADMIN_2FA_ALLOWED = [/^\/settings\/two-factor/, /^\/logout$/, /^\/lang$/];
export function enforceAdminTwoFactor(req, res, next) {
  if (!isAdmin(req.user) || req.user.totp_enabled) return next();
  if (ADMIN_2FA_ALLOWED.some((re) => re.test(req.path))) return next();
  if (req.method === 'GET') return res.redirect('/settings/two-factor');
  const err = new Error('two-step verification required');
  err.status = 403;
  return next(err);
}

export function clientIp(req) {
  return req.ip || null;
}
