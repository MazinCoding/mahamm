import { randomUUID } from 'node:crypto';
import { audit } from '../audit.js';
import { q, tx } from '../db.js';
import { translator } from '../i18n.js';
import { notify } from '../notify.js';
import { normaliseName } from './capture.js';
import { HttpError, UNDO_MINUTES, addComment, assertCanClose, canEdit, canResolveFlags, lockTask } from './tasks.js';

// Close matches: a new task whose title says nearly the same as an older task
// that is open or was closed in the last few days. The new task is still added
// (capture first); it gets a "Duplicate" flag pointing to the older one, and
// whoever added it (or an admin) can merge it into that task or dismiss the flag.

export const RECENT_DAYS = 7;
export const CLOSE = 0.75;

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'our', 'need', 'needs', 'some', 'all']);
export const titleWords = (s) => [...new Set(normaliseName(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))];

// How alike two titles are, from 0 to 1: the share of words they have in
// common (counting words of three letters or more), and 0 unless at least two
// are shared.
export function alike(title, other) {
  const a = titleWords(title);
  const b = titleWords(other);
  if (a.length < 2 || b.length < 2) return 0;
  const inB = new Set(b);
  const shared = a.filter((w) => inB.has(w)).length;
  return shared >= 2 ? (2 * shared) / (a.length + b.length) : 0;
}

// The older task a new one most closely matches: open, or closed in the last
// RECENT_DAYS days (not as a mistake or a duplicate). Ties go to the newest.
export async function closeMatch(db, task, exclude = []) {
  const { rows } = await db.query(
    `SELECT id, title FROM tasks
     WHERE id < $1 AND NOT (id = ANY($2::int[]))
       AND (closed_at IS NULL OR (closed_at > now() - make_interval(days => $3) AND close_reason NOT IN ('mistake', 'duplicate')))
     ORDER BY id DESC LIMIT 2000`,
    [task.id, exclude, RECENT_DAYS],
  );
  let best = null;
  for (const r of rows) {
    const score = alike(task.title, r.title);
    if (score >= CLOSE && (!best || score > best.score)) best = { id: r.id, title: r.title, score };
  }
  return best;
}

// Flags a new task that closely matches an older one. `exclude`: tasks added
// in the same go, which aren't matched with each other.
export async function flagCloseMatch(db, task, actor, ip, { exclude = [], ...extra } = {}) {
  const match = await closeMatch(db, task, exclude);
  if (!match) return null;
  const note = translator(actor.lang)('match.flagNote', { n: `#${match.id}`, title: match.title }).slice(0, 1000);
  const flag = (await db.query(
    `INSERT INTO flags (task_id, flagged_by, reason, note) VALUES ($1, $2, 'duplicate', $3) RETURNING id`,
    [task.id, actor.id, note],
  )).rows[0];
  await audit(db, {
    actorId: actor.id, action: 'task.flagged', taskId: task.id,
    details: { flag_id: flag.id, reason: 'duplicate', note, auto: 'close_match', match: match.id, ...extra }, ip,
  });
  return { flag_id: flag.id, match: match.id };
}

// A task's open close-match flag and the older task it points to.
export async function openCloseMatch(taskId, db = { query: q }) {
  const { rows } = await db.query(
    `SELECT f.id AS flag_id, (e.details->>'match')::int AS match_id
     FROM flags f
     JOIN audit_events e ON e.task_id = f.task_id AND e.action = 'task.flagged'
       AND e.details->>'auto' = 'close_match' AND (e.details->>'flag_id')::int = f.id
     WHERE f.task_id = $1 AND f.resolved_at IS NULL
     ORDER BY f.id DESC LIMIT 1`,
    [taskId],
  );
  return rows[0] || null;
}

// Merges a new task into the older task it closely matches. Nothing is
// deleted: the new task is closed as a duplicate of the older one, its people
// join the older one (only the person merging, if they can't edit it; nobody,
// if it's closed), and what the new task said is posted there as a comment,
// mentioning anyone who wasn't added. One batch, so Undo takes it all back.
// Allowed for the new task's creator or an admin, as settling its flag is.
export async function mergeIntoMatch(newId, actor, ip, extra = {}) {
  assertCanClose(actor);
  const batch = randomUUID();
  const tag = { batch, ...extra };
  const merged = await tx(async (db) => {
    const task = await lockTask(db, newId);
    if (task.closed_at) throw new HttpError(409, 'task closed');
    if (!canResolveFlags(actor, task)) throw new HttpError(403, 'creator or admin only');
    const found = await openCloseMatch(newId, db);
    if (!found) throw new HttpError(409, 'no close match');
    const target = await lockTask(db, found.match_id);
    const people = (await db.query(
      `SELECT ta.user_id AS id, u.name FROM task_assignees ta JOIN users u ON u.id = ta.user_id
       WHERE ta.task_id = $1 AND u.status = 'active' ORDER BY u.name`,
      [newId],
    )).rows;
    const already = (await db.query('SELECT user_id FROM task_assignees WHERE task_id = $1', [target.id])).rows.map((r) => r.user_id);
    const newcomers = people.filter((p) => !already.includes(p.id));
    let added = [];
    if (!target.closed_at) {
      const editable = canEdit(actor, { ...target, assignees: already.map((id) => ({ id })) });
      added = newcomers.filter((p) => editable || p.id === actor.id);
      if (added.length) {
        await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $1, unnest($2::uuid[])', [target.id, added.map((p) => p.id)]);
        await db.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [target.id]);
        await audit(db, {
          actorId: actor.id, action: 'task.edited', taskId: target.id,
          details: { changes: { assignees: { added: added.map((p) => p.id), removed: [] } }, ...tag }, ip,
        });
        await notify(db, { kind: 'assigned', taskId: target.id, task: target, actor, userIds: added.map((p) => p.id) });
      }
    }
    const mentioned = newcomers.filter((p) => !added.includes(p));
    await db.query(
      `UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = 'duplicate', duplicate_of = $3, updated_at = now() WHERE id = $1`,
      [newId, actor.id, target.id],
    );
    await audit(db, {
      actorId: actor.id, action: 'task.closed', taskId: newId,
      details: { reason: 'duplicate', credited: [], duplicate_of: target.id, merged: true, ...tag }, ip,
    });
    const settled = await db.query(
      `UPDATE flags SET resolved_at = now(), resolved_by = $2, resolution = 'closed' WHERE task_id = $1 AND resolved_at IS NULL RETURNING id`,
      [newId, actor.id],
    );
    for (const f of settled.rows) {
      await audit(db, { actorId: actor.id, action: 'task.flag_resolved', taskId: newId, details: { flag_id: f.id, resolution: 'closed', ...tag }, ip });
    }
    return { task, target, added, mentioned };
  });

  // What the new task said goes to the older one as a comment.
  const t = translator(actor.lang);
  const { task, target, added, mentioned } = merged;
  const labels = (await q(
    `SELECT l.name_en, l.name_ar FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = $1 ORDER BY l.id`,
    [newId],
  )).rows.map((l) => (actor.lang === 'ar' ? l.name_ar : l.name_en));
  const lines = [t('match.mergedComment', { n: `#${newId}`, title: task.title })];
  if (task.description?.trim()) lines.push(task.description.trim());
  if (labels.length) lines.push(t('match.labels', { names: labels.join(t('common.listSep')) }));
  if (task.due_date) lines.push(t('match.due', { date: task.due_date }));
  if (mentioned.length) lines.push(t('match.alsoOnIt', { names: mentioned.map((p) => `@${p.name}`).join(' ') }));
  await addComment(target.id, lines.join('\n').slice(0, 5000), actor, ip, tag);

  return {
    merged: true,
    from: newId,
    into: target.id,
    into_closed: !!target.closed_at,
    added: added.map((p) => p.name),
    mentioned: mentioned.map((p) => p.name),
    batch,
    undo_until: new Date(Date.now() + UNDO_MINUTES * 60 * 1000).toISOString(),
  };
}
