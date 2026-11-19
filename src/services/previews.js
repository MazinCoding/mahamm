import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, tx } from '../db.js';
import { closeTasks, createFromPreview, updateTasks } from './connector.js';
import { getWipLimit, setWipLimit } from './settings.js';
import { HttpError } from './tasks.js';
import { addPerson } from './users.js';

// Changes from a connected app that wait for the person to confirm them (see
// migration 006). The app gets a secret for its Confirm button in data it
// doesn't show as text; Mahamm's own page needs no secret because the person
// is signed in there.

export const PREVIEW_MINUTES = 10;
const hash = (s) => createHash('sha256').update(s).digest('hex');

export async function createPreview(kind, payload, summary, actor, origin) {
  const secret = randomBytes(32).toString('base64url');
  const { rows } = await q(
    `INSERT INTO connector_previews (user_id, kind, payload, summary, secret_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6)) RETURNING id, expires_at`,
    [actor.id, kind, JSON.stringify(payload), JSON.stringify(summary), hash(secret), PREVIEW_MINUTES],
  );
  const { id, expires_at: expires } = rows[0];
  return { id, secret, expires_at: new Date(expires).toISOString(), confirm_url: `${origin}/previews/${id}`, ...summary };
}

// The person's own preview, for Mahamm's page.
export async function previewFor(id, actor) {
  const { rows } = await q(
    `SELECT id, kind, summary, created_at, expires_at, used_at, outcome, (expires_at > now()) AS live
     FROM connector_previews WHERE id = $1 AND user_id = $2`,
    [id, actor.id],
  );
  return rows[0] || null;
}

const sameSecret = (secret, stored) => {
  if (typeof secret !== 'string' || !secret) return false;
  const a = Buffer.from(hash(secret), 'hex');
  const b = Buffer.from(stored, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

// Marks the preview used, once. Returns it, or why it can't be used.
async function claim(id, actor, outcome, secret, needSecret) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT *, (expires_at > now()) AS live FROM connector_previews WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const p = rows[0];
    if (!p || p.user_id !== actor.id) throw new HttpError(404, 'preview not found');
    if (needSecret && !sameSecret(secret, p.secret_hash)) throw new HttpError(403, 'not confirmed by the person');
    if (p.used_at) return { gone: p.outcome };
    if (!p.live) return { gone: 'expired' };
    await db.query('UPDATE connector_previews SET used_at = now(), outcome = $2 WHERE id = $1', [id, outcome]);
    return { preview: p };
  });
}

// Carries out a confirmed preview, with the person's rights as they are now.
// `secret` is required from a connected app; the website passes `website: true`.
export async function confirmPreview(id, actor, ip, opts, { secret = null, website = false } = {}) {
  const claimed = await claim(id, actor, 'confirmed', secret, !website);
  if (claimed.gone) return { done: false, gone: claimed.gone };
  const { kind, payload } = claimed.preview;
  const run = { ...opts, confirmed: true, extra: { preview: id } };
  let result;
  if (kind === 'update') result = await updateTasks(payload, actor, ip, run);
  else if (kind === 'close') result = await closeTasks(payload, actor, ip, run);
  else if (kind === 'create') result = await createFromPreview(payload, actor, ip, run);
  else {
    if (actor.role !== 'admin') throw new HttpError(403, 'admins only');
    if (payload.action === 'add_person') {
      const person = await addPerson(payload.name, actor, ip);
      result = { changed: true, added_person: person.name };
    } else {
      const { changed, from } = await setWipLimit(payload.limit, opts.wipLimit, actor, ip);
      result = { changed, in_progress_limit: { from: changed ? from : payload.limit, to: payload.limit } };
    }
  }
  return { done: true, kind, ...result };
}

export async function cancelPreview(id, actor) {
  const claimed = await claim(id, actor, 'cancelled', null, false);
  return claimed.gone ? { cancelled: false, gone: claimed.gone } : { cancelled: true };
}

export async function adminPreview(input, actor, opts) {
  if (actor.role !== 'admin') throw new HttpError(403, 'admins only');
  if (input.action === 'add_person') {
    const taken = await q(`SELECT 1 FROM users WHERE status = 'active' AND lower(name) = lower($1)`, [input.name]);
    if (taken.rows[0]) throw new HttpError(409, 'name taken');
  }
  const summary = input.action === 'add_person'
    ? { kind: 'admin', action: 'add_person', name: input.name }
    : { kind: 'admin', action: 'set_in_progress_limit', from: await getWipLimit(opts.wipLimit), to: input.limit };
  return { changed: false, why: ['an admin change'], preview: await createPreview('admin', input, summary, actor, opts.origin) };
}

export async function prunePreviews() {
  await q(`DELETE FROM connector_previews WHERE expires_at < now() - interval '1 day'`);
}
