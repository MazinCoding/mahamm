import { createHash } from 'node:crypto';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { one, q, tx } from '../db.js';

export const OPEN_STATUSES = ['backlog', 'todo', 'progress', 'review'];
export const CLOSE_REASONS = ['completed', 'notneeded', 'duplicate', 'mistake'];
export const FLAG_REASONS = ['mistake', 'wrong', 'duplicate', 'other'];
export const PRIORITIES = ['high', 'med', 'low'];

export class HttpError extends Error {
  constructor(status, message = 'error') {
    super(message);
    this.status = status;
  }
}

// Shared column list for cards and rows: people, labels and counts as JSON.
const CARD_COLUMNS = `
  t.id, t.title, t.status, t.priority, t.due_date, t.created_at, t.closed_at, t.close_reason, t.creator_id, t.imported,
  cu.name AS creator_name, cb.name AS closed_by_name, t.closed_by,
  COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
            FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id), '[]') AS assignees,
  COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY u.name)
            FROM task_credits tc JOIN users u ON u.id = tc.user_id WHERE tc.task_id = t.id), '[]') AS credits,
  COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name_en', l.name_en, 'name_ar', l.name_ar, 'color', l.color) ORDER BY l.id)
            FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id), '[]') AS labels,
  (SELECT count(*)::int FROM comments c WHERE c.task_id = t.id) AS comment_count,
  (SELECT count(*)::int FROM attachments a WHERE a.task_id = t.id AND a.removed_at IS NULL) AS file_count,
  (SELECT count(*)::int FROM flags f WHERE f.task_id = t.id AND f.resolved_at IS NULL) AS open_flags`;

const CARD_FROM = `FROM tasks t JOIN users cu ON cu.id = t.creator_id LEFT JOIN users cb ON cb.id = t.closed_by`;

export async function boardTasks({ onlyUserId = null } = {}) {
  const params = [];
  let mine = '';
  if (onlyUserId) {
    params.push(onlyUserId);
    mine = `AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $1)
            OR EXISTS (SELECT 1 FROM task_credits tc WHERE tc.task_id = t.id AND tc.user_id = $1)
            OR t.creator_id = $1)`;
  }
  const { rows } = await q(
    `SELECT ${CARD_COLUMNS} ${CARD_FROM}
     WHERE (t.closed_at IS NULL OR t.closed_at > now() - interval '14 days') ${mine}
     ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.id DESC
     LIMIT 1000`,
    params,
  );
  return rows;
}

export async function boardStats(wipLimit, timezone) {
  return one(
    `SELECT
       count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
       count(*) FILTER (WHERE closed_at IS NULL AND status = 'progress')::int AS progress,
       count(*) FILTER (WHERE closed_at IS NULL AND due_date < (now() AT TIME ZONE $2)::date)::int AS overdue,
       count(*) FILTER (WHERE closed_at > now() - interval '7 days')::int AS closed7,
       round(avg(EXTRACT(EPOCH FROM closed_at - created_at) / 86400)
             FILTER (WHERE close_reason = 'completed' AND closed_at > now() - interval '30 days')::numeric, 1) AS cycle_days,
       $1::int AS wip_limit
     FROM tasks`,
    [wipLimit, timezone],
  );
}

export const PAGE_SIZE = 50;

// Filters shared by the list and the table. Values always go in as parameters.
function filterClauses({ q: search = '', label = null, person = null, priority = null, flagged = false }, add) {
  const where = [];
  if (label) where.push(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ${add(label)})`);
  if (priority) where.push(`t.priority = ${add(priority)}`);
  if (person) {
    const p = add(person);
    where.push(`(EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${p})
               OR EXISTS (SELECT 1 FROM task_credits tc WHERE tc.task_id = t.id AND tc.user_id = ${p}))`);
  }
  if (flagged) where.push('EXISTS (SELECT 1 FROM flags f WHERE f.task_id = t.id AND f.resolved_at IS NULL)');
  const term = String(search || '').trim().replace(/^#/, '');
  if (term) {
    if (/^\d{1,9}$/.test(term)) where.push(`(t.id = ${add(Number(term))} OR t.title ILIKE ${add(`%${escapeLike(term)}%`)})`);
    else where.push(`t.title ILIKE ${add(`%${escapeLike(term)}%`)}`);
  }
  return where;
}

function paramList() {
  const params = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  return { params, add };
}

export async function listTasks({ state = 'open', q: search = '', label = null, person = null, priority = null, flagged = false, page = 1 }) {
  const { params, add } = paramList();
  const where = filterClauses({ q: search, label, person, priority, flagged }, add);
  const base = where.length ? `AND ${where.join(' AND ')}` : '';
  const counts = await one(
    `SELECT count(*) FILTER (WHERE t.closed_at IS NULL)::int AS open, count(*) FILTER (WHERE t.closed_at IS NOT NULL)::int AS closed
     FROM tasks t WHERE true ${base}`,
    params,
  );
  const stateSql = state === 'closed' ? 't.closed_at IS NOT NULL' : 't.closed_at IS NULL';
  const order = state === 'closed' ? 't.closed_at DESC' : 't.id DESC';
  const limit = add(PAGE_SIZE);
  const offset = add((Math.max(1, page) - 1) * PAGE_SIZE);
  const { rows } = await q(
    `SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${stateSql} ${base} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows, counts };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Table view. Sort keys map to fixed SQL; nothing from the request is interpolated.
export const TABLE_SORTS = {
  id: { sql: 't.id', dir: 'desc' },
  title: { sql: 'lower(t.title)', dir: 'asc' },
  status: { sql: `CASE t.status WHEN 'backlog' THEN 0 WHEN 'todo' THEN 1 WHEN 'progress' THEN 2 ELSE 3 END`, dir: 'asc' },
  priority: { sql: `CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END`, dir: 'asc' },
  due: { sql: 't.due_date', dir: 'asc' },
  updated: { sql: 't.updated_at', dir: 'desc' },
};
export const TABLE_DUE = ['overdue', 'week', 'none'];
export const RECENTLY_CLOSED_DAYS = 14;

export async function tableTasks({
  q: search = '', status = null, label = null, person = null, priority = null, due = null, flagged = false,
  closed = false, sort = null, dir = null, page = 1, timezone = 'UTC',
}) {
  const { params, add } = paramList();
  const where = filterClauses({ q: search, label, person, priority, flagged }, add);
  // Open tasks always; closed ones only when asked for, and only recent ones.
  if (status === 'done') where.push(`t.closed_at > now() - interval '${RECENTLY_CLOSED_DAYS} days'`);
  else if (status) where.push(`t.closed_at IS NULL AND t.status = ${add(status)}`);
  else if (closed) where.push(`(t.closed_at IS NULL OR t.closed_at > now() - interval '${RECENTLY_CLOSED_DAYS} days')`);
  else where.push('t.closed_at IS NULL');
  if (due) {
    const today = `(now() AT TIME ZONE ${add(timezone)})::date`;
    if (due === 'overdue') where.push(`t.closed_at IS NULL AND t.due_date < ${today}`);
    if (due === 'week') where.push(`t.due_date BETWEEN ${today} AND ${today} + 6`);
    if (due === 'none') where.push('t.due_date IS NULL');
  }
  const whereSql = where.join(' AND ');
  const { total } = await one(`SELECT count(*)::int AS total FROM tasks t WHERE ${whereSql}`, params);

  // Open tasks come before closed ones; missing due dates go last either way.
  let order = `CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END ASC, t.id DESC`;
  const s = TABLE_SORTS[sort];
  if (s) {
    const d = (dir || s.dir) === 'asc' ? 'ASC' : 'DESC';
    order = `${s.sql} ${d}${sort === 'due' ? ' NULLS LAST' : ''}${sort === 'id' ? '' : ', t.id DESC'}`;
  }
  const limit = add(PAGE_SIZE);
  const offset = add((Math.max(1, page) - 1) * PAGE_SIZE);
  const { rows } = await q(
    `SELECT ${CARD_COLUMNS}, t.updated_at ${CARD_FROM}
     WHERE ${whereSql}
     ORDER BY (t.closed_at IS NOT NULL), ${order}
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { rows, total };
}

export async function getTask(id) {
  const { rows } = await q(`SELECT ${CARD_COLUMNS}, t.description, t.duplicate_of ${CARD_FROM} WHERE t.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function taskDetail(id) {
  const task = await getTask(id);
  if (!task) return null;
  const [comments, files, flags, events] = await Promise.all([
    q(`SELECT c.id, c.body, c.created_at, c.author_id, u.name AS author_name
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.task_id = $1 ORDER BY c.created_at, c.id`, [id]),
    q(`SELECT a.id, a.filename, a.size_bytes, a.created_at, a.uploader_id, u.name AS uploader_name
       FROM attachments a JOIN users u ON u.id = a.uploader_id WHERE a.task_id = $1 AND a.removed_at IS NULL ORDER BY a.created_at`, [id]),
    q(`SELECT f.id, f.reason, f.note, f.created_at, f.flagged_by, u.name AS flagged_by_name, f.resolved_at, f.resolution
       FROM flags f JOIN users u ON u.id = f.flagged_by WHERE f.task_id = $1 ORDER BY f.created_at`, [id]),
    q(`SELECT e.id, e.at, e.actor_id, e.action, e.details, e.subject_user_id, u.name AS actor_name
       FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.task_id = $1 AND e.action <> 'task.commented' ORDER BY e.at, e.id`, [id]),
  ]);
  return { task, comments: comments.rows, files: files.rows, flags: flags.rows, events: events.rows };
}

export function canEdit(user, task) {
  if (!user) return false;
  if (user.role === 'admin' || task.creator_id === user.id) return true;
  return (task.assignees || []).some((a) => a.id === user.id);
}

export function canResolveFlags(user, task) {
  return !!user && (user.role === 'admin' || task.creator_id === user.id);
}

// Only active people can be assigned or credited; anything else is dropped.
async function activeIds(db, ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await db.query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'`, [ids]);
  return rows.map((r) => r.id);
}

async function existingLabelIds(db, ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await db.query('SELECT id FROM labels WHERE id = ANY($1::int[])', [ids]);
  return rows.map((r) => r.id);
}

export async function createTask(data, actor, ip, file = null) {
  return tx(async (db) => {
    const assignees = await activeIds(db, data.assignees);
    const labels = await existingLabelIds(db, data.labels);
    const { rows } = await db.query(
      `INSERT INTO tasks (title, description, status, priority, due_date, creator_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title`,
      [data.title, data.description, data.status, data.priority, data.due_date || null, actor.id],
    );
    const task = rows[0];
    if (assignees.length) await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $1, unnest($2::uuid[])', [task.id, assignees]);
    if (labels.length) await db.query('INSERT INTO task_labels (task_id, label_id) SELECT $1, unnest($2::int[])', [task.id, labels]);
    await audit(db, { actorId: actor.id, action: 'task.created', taskId: task.id, details: { title: task.title }, ip });
    if (file) await insertAttachment(db, task.id, file, actor, ip);
    await notify(db, { kind: 'assigned', taskId: task.id, task, actor, userIds: assignees });
    return task;
  });
}

export async function updateTask(id, data, actor, ip) {
  return tx(async (db) => {
    const current = await lockTask(db, id);
    const changes = {};
    for (const field of ['title', 'description', 'priority']) {
      if (data[field] !== current[field]) changes[field] = { from: current[field], to: data[field] };
    }
    const due = data.due_date || null;
    if (due !== (current.due_date || null)) changes.due_date = { from: current.due_date || null, to: due };

    const before = (await db.query('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    // New assignees must be active; people already assigned stay if still ticked, even if since disabled.
    const keep = before.filter((u) => data.assignees.includes(u));
    const finalAssignees = [...new Set([...keep, ...(await activeIds(db, data.assignees))])];
    const added = finalAssignees.filter((u) => !before.includes(u));
    const removed = before.filter((u) => !finalAssignees.includes(u));
    if (added.length || removed.length) changes.assignees = { added, removed };

    const labelsBefore = (await db.query('SELECT label_id FROM task_labels WHERE task_id = $1', [id])).rows.map((r) => r.label_id);
    const labelsAfter = await existingLabelIds(db, data.labels);
    const lAdded = labelsAfter.filter((l) => !labelsBefore.includes(l));
    const lRemoved = labelsBefore.filter((l) => !labelsAfter.includes(l));
    if (lAdded.length || lRemoved.length) changes.labels = { added: lAdded, removed: lRemoved };

    if (Object.keys(changes).length === 0) return { changed: false };

    await db.query(
      `UPDATE tasks SET title = $2, description = $3, priority = $4, due_date = $5, updated_at = now() WHERE id = $1`,
      [id, data.title, data.description, data.priority, due],
    );
    if (removed.length) await db.query('DELETE FROM task_assignees WHERE task_id = $1 AND user_id = ANY($2::uuid[])', [id, removed]);
    if (added.length) await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $1, unnest($2::uuid[])', [id, added]);
    if (lRemoved.length) await db.query('DELETE FROM task_labels WHERE task_id = $1 AND label_id = ANY($2::int[])', [id, lRemoved]);
    if (lAdded.length) await db.query('INSERT INTO task_labels (task_id, label_id) SELECT $1, unnest($2::int[])', [id, lAdded]);
    if (changes.description) changes.description = { changed: true, from_length: current.description.length, to_length: data.description.length, previous: current.description };
    await audit(db, { actorId: actor.id, action: 'task.edited', taskId: id, details: { changes }, ip });
    if (added.length) await notify(db, { kind: 'assigned', taskId: id, task: { title: data.title }, actor, userIds: added });
    return { changed: true };
  });
}

async function lockTask(db, id) {
  const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new HttpError(404, 'task not found');
  return rows[0];
}

async function reopenInside(db, task, actor, ip, toStatus) {
  await db.query(
    `UPDATE tasks SET closed_at = NULL, closed_by = NULL, close_reason = NULL, duplicate_of = NULL, status = $2, updated_at = now() WHERE id = $1`,
    [task.id, toStatus],
  );
  await db.query('DELETE FROM task_credits WHERE task_id = $1', [task.id]);
  await audit(db, { actorId: actor.id, action: 'task.reopened', taskId: task.id, ip });
}

export async function moveTask(id, to, actor, ip) {
  if (!OPEN_STATUSES.includes(to)) throw new HttpError(400, 'bad status');
  return tx(async (db) => {
    const task = await lockTask(db, id);
    const from = task.closed_at ? 'done' : task.status;
    if (from === to) return { changed: false };
    if (task.closed_at) await reopenInside(db, task, actor, ip, to);
    else await db.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [id, to]);
    await audit(db, { actorId: actor.id, action: 'task.moved', taskId: id, details: { from, to }, ip });
    if (to === 'review') await notify(db, { kind: 'review', taskId: id, task, actor, userIds: [task.creator_id] });
    return { changed: true };
  });
}

export async function closeTask(id, { reason, credited = [], duplicateOf = null }, actor, ip) {
  if (!CLOSE_REASONS.includes(reason)) throw new HttpError(400, 'bad reason');
  return tx(async (db) => {
    const task = await lockTask(db, id);
    if (task.closed_at) throw new HttpError(409, 'already closed');
    let credits = [];
    if (reason === 'completed') {
      credits = await activeIds(db, credited);
      if (credits.length === 0) throw new HttpError(400, 'credit required');
    }
    let dup = null;
    if (reason === 'duplicate' && duplicateOf) {
      if (Number(duplicateOf) === id) throw new HttpError(400, 'duplicate of itself');
      const exists = await db.query('SELECT id FROM tasks WHERE id = $1', [duplicateOf]);
      if (!exists.rows[0]) throw new HttpError(400, 'duplicate target missing');
      dup = Number(duplicateOf);
    }
    await db.query(
      `UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = $3, duplicate_of = $4, updated_at = now() WHERE id = $1`,
      [id, actor.id, reason, dup],
    );
    if (credits.length) await db.query('INSERT INTO task_credits (task_id, user_id) SELECT $1, unnest($2::uuid[])', [id, credits]);
    await audit(db, { actorId: actor.id, action: 'task.closed', taskId: id, details: { reason, credited: credits, duplicate_of: dup }, ip });
    // Closing a task as a mistake or duplicate settles any open flags on it.
    if (reason === 'mistake' || reason === 'duplicate') {
      const open = await db.query(
        `UPDATE flags SET resolved_at = now(), resolved_by = $2, resolution = 'closed' WHERE task_id = $1 AND resolved_at IS NULL RETURNING id`,
        [id, actor.id],
      );
      for (const f of open.rows) {
        await audit(db, { actorId: actor.id, action: 'task.flag_resolved', taskId: id, details: { flag_id: f.id, resolution: 'closed' }, ip });
      }
    }
    if (credits.length) await notify(db, { kind: 'credited', taskId: id, task, actor, userIds: credits });
    return { credits };
  });
}

export async function reopenTask(id, actor, ip) {
  return tx(async (db) => {
    const task = await lockTask(db, id);
    if (!task.closed_at) return { changed: false };
    await reopenInside(db, task, actor, ip, 'todo');
    return { changed: true };
  });
}

export async function addComment(id, body, actor, ip) {
  return tx(async (db) => {
    const task = await lockTask(db, id);
    const { rows } = await db.query(
      'INSERT INTO comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [id, actor.id, body],
    );
    await audit(db, { actorId: actor.id, action: 'task.commented', taskId: id, details: { comment_id: rows[0].id, excerpt: body.slice(0, 120) }, ip });
    const mentioned = await findMentions(db, body);
    await notify(db, { kind: 'mentioned', taskId: id, task, actor, userIds: mentioned });
    const followers = (await db.query('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    followers.push(task.creator_id);
    await notify(db, { kind: 'commented', taskId: id, task, actor, userIds: followers.filter((u) => !mentioned.includes(u)) });
    return rows[0];
  });
}

// "@Full Name" always matches; "@First" matches when only one active person has that first name.
export async function findMentions(db, body) {
  if (!body.includes('@')) return [];
  const { rows } = await db.query(`SELECT id, name FROM users WHERE status = 'active'`);
  const text = body.toLowerCase();
  const firstCounts = {};
  for (const u of rows) {
    const first = u.name.split(/\s+/)[0].toLowerCase();
    firstCounts[first] = (firstCounts[first] || 0) + 1;
  }
  const hits = [];
  for (const u of rows) {
    const full = u.name.toLowerCase();
    const first = full.split(/\s+/)[0];
    const boundary = (needle) => {
      let from = 0;
      for (;;) {
        const at = text.indexOf(needle, from);
        if (at < 0) return false;
        const next = text.charAt(at + needle.length);
        if (!next || !/[\p{L}\p{N}]/u.test(next)) return true;
        from = at + 1;
      }
    };
    if (boundary(`@${full}`) || (firstCounts[first] === 1 && boundary(`@${first}`))) hits.push(u.id);
  }
  return hits;
}

export async function insertAttachment(db, taskId, file, actor, ip) {
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO attachments (task_id, uploader_id, filename, mime, size_bytes, sha256, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, filename`,
    [taskId, actor.id, file.filename, file.mime, file.buffer.length, sha256, file.buffer],
  );
  await audit(db, { actorId: actor.id, action: 'task.attachment_added', taskId, details: { attachment_id: rows[0].id, file: rows[0].filename, size: file.buffer.length, sha256 }, ip });
  return rows[0];
}

export async function addAttachment(taskId, file, actor, ip) {
  return tx(async (db) => {
    await lockTask(db, taskId);
    const count = await db.query('SELECT count(*)::int AS n FROM attachments WHERE task_id = $1 AND removed_at IS NULL', [taskId]);
    if (count.rows[0].n >= 20) throw new HttpError(400, 'too many files');
    return insertAttachment(db, taskId, file, actor, ip);
  });
}

// Attachments are hidden, not destroyed, so the audit trail still makes sense.
export async function removeAttachment(attachmentId, taskId, actor, ip) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'SELECT id, uploader_id, filename FROM attachments WHERE id = $1 AND task_id = $2 AND removed_at IS NULL FOR UPDATE',
      [attachmentId, taskId],
    );
    const file = rows[0];
    if (!file) throw new HttpError(404, 'file not found');
    if (actor.role !== 'admin' && file.uploader_id !== actor.id) throw new HttpError(403, 'not allowed');
    await db.query('UPDATE attachments SET removed_at = now(), removed_by = $2 WHERE id = $1', [attachmentId, actor.id]);
    await audit(db, { actorId: actor.id, action: 'task.attachment_removed', taskId, details: { attachment_id: attachmentId, file: file.filename }, ip });
  });
}

export async function getAttachment(attachmentId) {
  return one(
    'SELECT id, task_id, filename, mime, size_bytes, data FROM attachments WHERE id = $1 AND removed_at IS NULL',
    [attachmentId],
  );
}

export async function flagTask(id, { reason, note }, actor, ip) {
  if (!FLAG_REASONS.includes(reason)) throw new HttpError(400, 'bad reason');
  return tx(async (db) => {
    const task = await lockTask(db, id);
    const { rows } = await db.query(
      'INSERT INTO flags (task_id, flagged_by, reason, note) VALUES ($1, $2, $3, $4) RETURNING id', [id, actor.id, reason, note],
    );
    await audit(db, { actorId: actor.id, action: 'task.flagged', taskId: id, details: { flag_id: rows[0].id, reason, note }, ip });
    // Tell whoever created the task; if they flagged it themselves, tell the admins.
    let recipients = [task.creator_id];
    if (task.creator_id === actor.id) {
      recipients = (await db.query(`SELECT id FROM users WHERE role = 'admin' AND status = 'active'`)).rows.map((r) => r.id);
    }
    await notify(db, { kind: 'flagged', taskId: id, task, actor, userIds: recipients });
    return rows[0];
  });
}

export async function resolveFlag(taskId, flagId, resolution, actor, ip) {
  if (!['fixed', 'dismissed'].includes(resolution)) throw new HttpError(400, 'bad resolution');
  return tx(async (db) => {
    const task = await lockTask(db, taskId);
    if (actor.role !== 'admin' && task.creator_id !== actor.id) throw new HttpError(403, 'not allowed');
    const { rows } = await db.query(
      `UPDATE flags SET resolved_at = now(), resolved_by = $3, resolution = $4
       WHERE id = $1 AND task_id = $2 AND resolved_at IS NULL RETURNING id`,
      [flagId, taskId, actor.id, resolution],
    );
    if (!rows[0]) throw new HttpError(404, 'flag not found');
    await audit(db, { actorId: actor.id, action: 'task.flag_resolved', taskId, details: { flag_id: flagId, resolution }, ip });
  });
}
