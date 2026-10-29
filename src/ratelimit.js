import { q } from './db.js';

// Fixed-window counters kept in Postgres, so limits hold across restarts
// and across more than one app instance.

export async function hit(key, windowSeconds) {
  const { rows } = await q(
    `INSERT INTO rate_limits (key, count, reset_at)
     VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + make_interval(secs => $2) ELSE rate_limits.reset_at END
     RETURNING count, reset_at`,
    [key, windowSeconds],
  );
  return { count: rows[0].count, resetAt: rows[0].reset_at };
}

export async function peek(key) {
  const { rows } = await q('SELECT count, reset_at FROM rate_limits WHERE key = $1 AND reset_at > now()', [key]);
  return rows[0] ? { count: rows[0].count, resetAt: rows[0].reset_at } : { count: 0, resetAt: null };
}

export async function clear(key) {
  await q('DELETE FROM rate_limits WHERE key = $1', [key]);
}

export async function pruneRateLimits() {
  await q('DELETE FROM rate_limits WHERE reset_at < now()');
}

export class RateLimited extends Error {
  constructor(retryAfterSeconds) {
    super('rate limited');
    this.status = 429;
    this.retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

// Throws RateLimited once `limit` hits have happened inside the window.
export async function enforce(key, limit, windowSeconds) {
  const { count, resetAt } = await hit(key, windowSeconds);
  if (count > limit) throw new RateLimited((new Date(resetAt).getTime() - Date.now()) / 1000);
}

// Middleware: limits by signed-in user when there is one, otherwise by IP.
export function limiter({ name, limit, windowSeconds, by = 'user-or-ip' }) {
  return async function rateLimit(req, res, next) {
    const who = by === 'ip' || !req.user ? `ip:${req.ip}` : `user:${req.user.id}`;
    try {
      await enforce(`${name}:${who}`, limit, windowSeconds);
      next();
    } catch (err) {
      next(err);
    }
  };
}
