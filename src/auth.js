import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { csrfSync } from 'csrf-sync';
import { getPool, q } from './db.js';

const ABSOLUTE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // sign in again at least weekly
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // or after 12 hours without activity

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

// Multipart bodies are only parsed on upload routes, which check the token
// themselves right after parsing. Everything else is checked here.
export function csrfUnlessMultipart(req, res, next) {
  if (req.is('multipart/form-data')) return next();
  return csrfProtection(req, res, next);
}

const USER_COLUMNS = 'id, email, name, role, status, lang, email_notifications, totp_enabled, password_changed_at, last_seen_at';

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
export async function startSession(req, user) {
  const lang = req.session?.lang;
  await regenerate(req);
  req.session.userId = user.id;
  req.session.pwv = new Date(user.password_changed_at).toISOString();
  req.session.createdAt = Date.now();
  req.session.lang = lang;
  await save(req);
}

// Used before the second sign-in step: password is right, code not yet given.
export async function startPendingSession(req, user) {
  const lang = req.session?.lang;
  await regenerate(req);
  req.session.pendingUserId = user.id;
  req.session.pendingAt = Date.now();
  req.session.lang = lang;
  await save(req);
}

export async function signOutEverywhere(userId, exceptSid = null) {
  await q(`DELETE FROM "session" WHERE sess->>'userId' = $1 AND sid IS DISTINCT FROM $2`, [userId, exceptSid]);
}

export function loadUser() {
  return async function load(req, res, next) {
    const id = req.session?.userId;
    if (!id) return next();
    const user = await findUserById(id);
    const tooOld = !req.session.createdAt || Date.now() - req.session.createdAt > ABSOLUTE_LIFETIME_MS;
    const stale = !user || req.session.pwv !== new Date(user.password_changed_at).toISOString();
    if (!user || user.status !== 'active' || tooOld || stale) {
      await destroySession(req);
      return next();
    }
    req.user = user;
    if (!req.session.seenAt || Date.now() - req.session.seenAt > 5 * 60 * 1000) {
      req.session.seenAt = Date.now();
      await q('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
    }
    return next();
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
  if (req.user?.role === 'admin') return next();
  const err = new Error('admins only');
  err.status = 403;
  return next(err);
}

// Admins must turn on two-step verification before they can do anything else.
const ADMIN_2FA_ALLOWED = [/^\/settings\/two-factor/, /^\/logout$/, /^\/lang$/];
export function enforceAdminTwoFactor(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || req.user.totp_enabled) return next();
  if (ADMIN_2FA_ALLOWED.some((re) => re.test(req.path))) return next();
  if (req.method === 'GET') return res.redirect('/settings/two-factor');
  const err = new Error('two-step verification required');
  err.status = 403;
  return next(err);
}

export function clientIp(req) {
  return req.ip || null;
}
