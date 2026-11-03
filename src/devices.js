import { hashToken, newToken } from './crypto.js';
import { one, q } from './db.js';

// How long a remembered device (and a "keep me signed in" session) lasts.
// Admins get a shorter period because their accounts can do more.
const DAY_MS = 24 * 60 * 60 * 1000;
export const REMEMBER_DAYS = { admin: 30, member: 90 };
export const rememberDays = (role) => (role === 'admin' ? REMEMBER_DAYS.admin : REMEMBER_DAYS.member);
export const rememberMs = (role) => rememberDays(role) * DAY_MS;

export const deviceCookieName = (config) => (config.isProd ? '__Host-mahamm.device' : 'mahamm.device');

function cookieOptions(config, maxAge) {
  return { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', maxAge };
}

// The raw token from the request's cookie header, if it looks like one of ours.
export function deviceTokenFrom(req, config) {
  const name = deviceCookieName(config);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

// A short, readable name such as "Chrome on Windows". Never shown unescaped.
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
            : /CrOS/.test(ua) ? 'ChromeOS'
              : /Linux/.test(ua) ? 'Linux' : '';
  return (os ? `${browser} · ${os}` : browser).slice(0, 100);
}

// Remembers this browser for the person and sets the cookie.
export async function rememberDevice(req, res, config, user) {
  const token = newToken();
  const ms = rememberMs(user.role);
  const device = await one(
    `INSERT INTO trusted_devices (user_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING id, label`,
    [user.id, hashToken(token), deviceLabel(req.headers['user-agent']), ms / 1000],
  );
  res.cookie(deviceCookieName(config), token, cookieOptions(config, ms));
  return device;
}

// The device row if this browser is remembered for this person and still valid.
// The period is checked against the person's current role, so an admin's
// device never lasts longer than the admin period.
export async function validDevice(req, config, user) {
  const token = deviceTokenFrom(req, config);
  if (!token) return null;
  return one(
    `UPDATE trusted_devices SET last_used_at = now()
     WHERE token_hash = $1 AND user_id = $2 AND forgotten_at IS NULL AND expires_at > now()
       AND created_at > now() - make_interval(secs => $3)
     RETURNING id, label`,
    [hashToken(token), user.id, rememberMs(user.role) / 1000],
  );
}

export async function listDevices(userId) {
  const { rows } = await q(
    `SELECT id, label, token_hash, created_at, last_used_at, expires_at FROM trusted_devices
     WHERE user_id = $1 AND forgotten_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC LIMIT 50`,
    [userId],
  );
  return rows;
}

export async function forgetDevice(userId, deviceId) {
  return one(
    'UPDATE trusted_devices SET forgotten_at = now() WHERE id = $1 AND user_id = $2 AND forgotten_at IS NULL RETURNING id, label',
    [deviceId, userId],
  );
}

export async function forgetAllDevices(userId) {
  const { rowCount } = await q('UPDATE trusted_devices SET forgotten_at = now() WHERE user_id = $1 AND forgotten_at IS NULL', [userId]);
  return rowCount;
}

export function clearDeviceCookie(res, config) {
  const { maxAge, ...opts } = cookieOptions(config, 0);
  res.clearCookie(deviceCookieName(config), opts);
}

export async function pruneDevices() {
  await q(`DELETE FROM trusted_devices WHERE expires_at < now() - interval '30 days' OR forgotten_at < now() - interval '30 days'`);
}
