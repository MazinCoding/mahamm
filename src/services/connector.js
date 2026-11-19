import { randomUUID } from 'node:crypto';
import { TASK_ACTIONS, audit, describe } from '../audit.js';
import { q, tx } from '../db.js';
import { translator } from '../i18n.js';
import { notifyBatch } from '../notify.js';
import {
  captureTasks, matchPerson, normaliseName, resolveLabels, resolveNames, settleNoAssignee, teamPeople, undoCapture,
} from './capture.js';
import { alike, mergeIntoMatch, openCloseMatch } from './matches.js';
import { createPreview } from './previews.js';
import { getWipLimit, inProgressCount } from './settings.js';
import {
  CARD_COLUMNS, CARD_FROM, HttpError, UNDO_MINUTES, activeIds, addComment, applyEdit, canEdit, escapeLike, flagTask,
  joinTask, lockTask, myTasks, reopenInside, resolveFlag, reviewersOf, suggestedTasks, taskDetail, undoBatch,
} from './tasks.js';

// What the connector can read and change, beyond adding tasks (capture.js).
// Every function acts as the signed-in person, with exactly the rights the
// website gives them, and every change is audited with `via: 'connector'`.
// Names are matched with the same rules as when adding tasks; a name that
// matches nobody or several people is reported back and nothing is guessed.

export const PER_PAGE = 25;
// More tasks than this in one change, or taking someone else off a task,
// needs the person to confirm first; so does adding more than MAX_ADD tasks.
export const MAX_DIRECT = 5;
export const MAX_ADD = 10;
const VIA = 'connector';

const STATUS_IN = { backlog: 'backlog', todo: 'todo', in_progress: 'progress', review: 'review' };
const STATUS_OUT = { backlog: 'backlog', todo: 'todo', progress: 'in_progress', review: 'review' };
const PRIORITY_IN = { high: 'high', medium: 'med', low: 'low' };
const PRIORITY_OUT = { high: 'high', med: 'medium', low: 'low' };
const REASON_IN = { completed: 'completed', not_needed: 'notneeded', duplicate: 'duplicate', mistake: 'mistake' };
const REASON_OUT = { completed: 'completed', notneeded: 'not_needed', duplicate: 'duplicate', mistake: 'mistake' };
const KINDS = {
  created: ['task.created', 'task.imported'],
  moved: ['task.moved'],
  edited: ['task.edited'],
  closed: ['task.closed'],
  reopened: ['task.reopened'],
  commented: ['task.commented'],
  flagged: ['task.flagged', 'task.flag_resolved'],
  files: ['task.attachment_added', 'task.attachment_removed'],
};

// ---------- small helpers ----------

export function localToday(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(isoDay, n) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// "2026-11-18 14:05" in the team's time zone.
export function localTime(value, timezone) {
  if (!value) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function paramList() {
  const list = [];
  return { list, add: (v) => { list.push(v); return `$${list.length}`; } };
}

const labelName = (l, lang) => (lang === 'ar' ? l.name_ar : l.name_en);

// The compact form every tool uses for a task. Empty values stay empty
// (no due date is null, nobody assigned is []), so they can be shown as missing.
export function taskRow(t, lang, origin) {
  const row = {
    id: t.id,
    title: t.title,
    status: t.closed_at ? 'done' : STATUS_OUT[t.status],
    priority: PRIORITY_OUT[t.priority],
    due_date: t.due_date || null,
    assignees: (t.assignees || []).map((a) => a.name),
    labels: (t.labels || []).map((l) => labelName(l, lang)),
    team_task: !!t.team_task,
    flagged: t.open_flags > 0,
    url: `${origin}/tasks/${t.id}`,
  };
  if (t.reviewer_name) row.reviewer = t.reviewer_name;
  if (t.closed_at) row.closed_reason = REASON_OUT[t.close_reason];
  return row;
}

async function allLabels(db = { query: q }) {
  return (await db.query('SELECT id, name_en, name_ar FROM labels ORDER BY id')).rows;
}

const isMe = (heard) => ['me', 'myself', 'انا', 'أنا'].includes(String(heard).trim().toLowerCase());

// Names to people, where "me" is the person acting.
function resolvePeople(names, people, actor) {
  const r = resolveNames(names.filter((n) => !isMe(n)), people);
  if (names.some(isMe) && !r.ids.includes(actor.id)) r.ids.unshift(actor.id);
  return r;
}

// One person from a name, or "me". Problems are collected, never guessed.
function personResolver(actor, people, problems) {
  return (heard) => {
    if (isMe(heard)) return actor.id;
    const m = matchPerson(heard, people);
    if (m.status === 'matched') return m.person.id;
    problems.push(m.status === 'clash'
      ? { heard, problem: 'several_people', could_be: m.candidates.map((c) => c.name) }
      : { heard, problem: 'nobody_by_that_name' });
    return null;
  };
}

async function titles(ids) {
  return (await q('SELECT id, title FROM tasks WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows;
}

async function namesById(db = { query: q }) {
  return Object.fromEntries((await db.query('SELECT id, name FROM users')).rows.map((u) => [u.id, u.name]));
}

// ---------- reading ----------

const SORTS = {
  priority: `CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.due_date ASC NULLS LAST, t.id DESC`,
  due: 't.due_date ASC NULLS LAST, t.id DESC',
  updated: 't.updated_at DESC, t.id DESC',
  newest: 't.id DESC',
  oldest: 't.created_at ASC, t.id ASC',
};

export async function searchTasks(f, actor, { timezone, origin }) {
  const problems = [];
  const resolve = personResolver(actor, await teamPeople(), problems);
  const personId = f.person ? resolve(f.person) : null;
  const creatorId = f.creator ? resolve(f.creator) : null;
  const reviewerId = f.reviewer ? resolve(f.reviewer) : null;
  let labelIds = [];
  if (f.label) {
    const labels = await allLabels();
    const r = resolveLabels([f.label], labels);
    if (r.missing.length) problems.push({ ...r.missing[0], labels: labels.map((l) => labelName(l, actor.lang)) });
    labelIds = r.ids;
  }
  if (problems.length) return { total: 0, page: 1, pages: 0, per_page: PER_PAGE, tasks: [], missing: problems };

  const today = localToday(timezone);
  const { list, add } = paramList();
  const where = [];
  const statuses = f.status.length ? f.status : ['backlog', 'todo', 'in_progress', 'review'];
  const open = statuses.filter((s) => s !== 'done').map((s) => STATUS_IN[s]);
  const either = [];
  if (open.length) either.push(`(t.closed_at IS NULL AND t.status = ANY(${add(open)}::text[]))`);
  if (statuses.includes('done')) either.push(`(t.closed_at > now() - make_interval(days => ${add(f.closed_within_days)}))`);
  where.push(`(${either.join(' OR ')})`);
  if (personId) {
    const p = add(personId);
    where.push(`(EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = ${p}::uuid)
               OR EXISTS (SELECT 1 FROM task_credits tc WHERE tc.task_id = t.id AND tc.user_id = ${p}::uuid))`);
  }
  if (f.unassigned) where.push('NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)');
  if (creatorId) where.push(`t.creator_id = ${add(creatorId)}::uuid`);
  if (reviewerId) where.push(`t.reviewer_id = ${add(reviewerId)}::uuid`);
  if (labelIds.length) where.push(`EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ANY(${add(labelIds)}::int[]))`);
  if (f.priority.length) where.push(`t.priority = ANY(${add(f.priority.map((p) => PRIORITY_IN[p]))}::text[])`);
  if (f.due === 'overdue') where.push(`(t.closed_at IS NULL AND t.due_date < ${add(today)}::date)`);
  if (f.due === 'today') where.push(`t.due_date = ${add(today)}::date`);
  if (f.due === 'this_week') where.push(`t.due_date BETWEEN ${add(today)}::date AND ${add(addDays(today, 6))}::date`);
  if (f.due === 'none') where.push('t.due_date IS NULL');
  if (f.due_before) where.push(`t.due_date <= ${add(f.due_before)}::date`);
  if (f.team_task !== undefined) where.push(`t.team_task = ${add(f.team_task)}::boolean`);
  if (f.flagged !== undefined) where.push(`${f.flagged ? '' : 'NOT '}EXISTS (SELECT 1 FROM flags fl WHERE fl.task_id = t.id AND fl.resolved_at IS NULL)`);
  if (f.not_updated_for_days) where.push(`t.updated_at < now() - make_interval(days => ${add(f.not_updated_for_days)})`);
  if (f.words.length) {
    const ors = f.words.map((w) => {
      const p = add(`%${escapeLike(w)}%`);
      return `(t.title ILIKE ${p} OR t.description ILIKE ${p})`;
    });
    where.push(`(${ors.join(' OR ')})`);
  }
  const whereSql = where.join(' AND ');
  const total = (await q(`SELECT count(*)::int AS n FROM tasks t WHERE ${whereSql}`, list)).rows[0].n;
  const order = statuses.length === 1 && statuses[0] === 'done' ? 't.closed_at DESC, t.id DESC' : SORTS[f.sort];
  const limit = add(PER_PAGE);
  const offset = add((f.page - 1) * PER_PAGE);
  const { rows } = await q(
    `SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE ${whereSql}
     ORDER BY (t.closed_at IS NOT NULL), ${order} LIMIT ${limit} OFFSET ${offset}`,
    list,
  );
  return { total, page: f.page, pages: Math.ceil(total / PER_PAGE), per_page: PER_PAGE, tasks: rows.map((r) => taskRow(r, actor.lang, origin)) };
}

export async function taskInFull(id, actor, { timezone, origin }) {
  const d = await taskDetail(id);
  if (!d) throw new HttpError(404, 'task not found');
  const t = translator(actor.lang);
  const names = await namesById();
  const labels = Object.fromEntries((await allLabels()).map((l) => [l.id, labelName(l, actor.lang)]));
  const task = d.task;
  return {
    ...taskRow(task, actor.lang, origin),
    description: task.description || '',
    created_by: task.creator_name,
    created_at: localTime(task.created_at, timezone),
    closed: task.closed_at ? {
      at: localTime(task.closed_at, timezone),
      by: task.closed_by_name,
      reason: REASON_OUT[task.close_reason],
      credited: (task.credits || []).map((c) => c.name),
      duplicate_of: task.duplicate_of || null,
    } : null,
    comment_count: d.comments.length,
    comments: d.comments.slice(-20).map((c) => ({ id: c.id, by: c.author_name, at: localTime(c.created_at, timezone), text: c.body })),
    files: d.files.map((f) => ({ name: f.filename, size_bytes: f.size_bytes, url: `${origin}/attachments/${f.id}` })),
    flags: d.flags.map((f) => ({
      id: f.id, reason: f.reason, note: f.note, by: f.flagged_by_name, at: localTime(f.created_at, timezone), open: !f.resolved_at, resolution: f.resolution || null,
    })),
    history: d.events.slice(-30).map((e) => ({ at: localTime(e.at, timezone), who: e.actor_name || t('common.formerUser'), text: describe(e, t, { names, labels }) })),
    close_match: task.closed_at ? null : await closeMatchOf(id, actor, origin),
  };
}

export async function myWork(actor, { timezone, origin, wipLimit }) {
  const today = localToday(timezone);
  const weekEnd = addDays(today, 6);
  const mine = (await myTasks(actor.id)).slice(0, 50).map((r) => taskRow(r, actor.lang, origin));
  const waiting = (await q(
    `SELECT ${CARD_COLUMNS} ${CARD_FROM}
     WHERE t.closed_at IS NULL AND t.status = 'review'
       AND (t.reviewer_id = $1 OR (t.reviewer_id IS NULL AND t.creator_id = $1
            AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $1)))
     ORDER BY t.updated_at ASC LIMIT ${PER_PAGE}`,
    [actor.id],
  )).rows.map((r) => taskRow(r, actor.lang, origin));
  const unread = (await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [actor.id])).rows[0].n;
  const notes = (await q(
    `SELECT n.id, n.kind, n.task_id, t.title, u.name AS by, n.created_at
     FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = $1 AND n.read_at IS NULL ORDER BY n.created_at DESC, n.id DESC LIMIT 20`,
    [actor.id],
  )).rows;
  const ids = (pred) => mine.filter(pred).map((r) => r.id);
  const count = (s) => mine.filter((r) => r.status === s).length;
  return {
    you: actor.name,
    today,
    counts: {
      in_progress: count('in_progress'), review: count('review'), todo: count('todo'), backlog: count('backlog'),
      overdue: ids((r) => r.due_date && r.due_date < today).length,
      waiting_for_your_review: waiting.length,
      unread_notifications: unread,
    },
    team_in_progress: { now: await inProgressCount(), limit: await getWipLimit(wipLimit) },
    my_tasks: mine,
    overdue: ids((r) => r.due_date && r.due_date < today),
    due_today: ids((r) => r.due_date === today),
    due_this_week: ids((r) => r.due_date && r.due_date > today && r.due_date <= weekEnd),
    waiting_for_your_review: waiting,
    notifications: notes.map((n) => ({ id: Number(n.id), kind: n.kind, task_id: n.task_id, task: n.title, by: n.by, at: localTime(n.created_at, timezone) })),
  };
}

export async function workload(actor, { timezone, wipLimit }) {
  const today = localToday(timezone);
  const { rows } = await q(
    `SELECT u.name, (u.email IS NOT NULL) AS has_account,
       count(t.id) FILTER (WHERE t.status = 'progress')::int AS in_progress,
       count(t.id) FILTER (WHERE t.status = 'review')::int AS review,
       count(t.id) FILTER (WHERE t.status = 'todo')::int AS todo,
       count(t.id) FILTER (WHERE t.status = 'backlog')::int AS backlog,
       count(t.id) FILTER (WHERE t.due_date < $1::date)::int AS overdue,
       count(t.id) FILTER (WHERE t.due_date BETWEEN $1::date AND $2::date)::int AS due_this_week
     FROM users u
     LEFT JOIN task_assignees ta ON ta.user_id = u.id
     LEFT JOIN tasks t ON t.id = ta.task_id AND t.closed_at IS NULL
     WHERE u.status = 'active'
     GROUP BY u.id, u.name, u.email
     ORDER BY count(t.id) FILTER (WHERE t.status = 'progress') DESC, u.name`,
    [today, addDays(today, 6)],
  );
  const team = (await q(
    `SELECT count(*) FILTER (WHERE closed_at IS NULL)::int AS open,
            count(*) FILTER (WHERE closed_at IS NULL AND status = 'progress')::int AS in_progress,
            count(*) FILTER (WHERE closed_at IS NULL AND due_date < $1::date)::int AS overdue,
            count(*) FILTER (WHERE closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id))::int AS unassigned,
            count(*) FILTER (WHERE closed_at > now() - interval '7 days')::int AS closed_last_7_days
     FROM tasks`,
    [today],
  )).rows[0];
  return { today, team: { ...team, in_progress_limit: await getWipLimit(wipLimit) }, people: rows };
}

export async function activity(f, actor, { timezone }) {
  const problems = [];
  const resolve = personResolver(actor, await teamPeople(), problems);
  const personId = f.person ? resolve(f.person) : null;
  if (problems.length) return { events: [], missing: problems };
  const { list, add } = paramList();
  const actions = f.kinds.length ? f.kinds.flatMap((k) => KINDS[k]) : TASK_ACTIONS.filter((a) => a !== 'import.completed');
  const where = [`e.action = ANY(${add(actions)}::text[])`, 'e.task_id IS NOT NULL'];
  if (personId) {
    const p = add(personId);
    // What someone did, plus tasks closed with credit to them.
    where.push(`(e.actor_id = ${p}::uuid OR (e.action = 'task.closed' AND e.details->'credited' ? (${p}::text)))`);
  }
  if (f.task_id) where.push(`e.task_id = ${add(f.task_id)}::int`);
  const tz = f.from || f.to ? add(timezone) : null;
  if (f.from) where.push(`e.at >= (${add(f.from)}::date)::timestamp AT TIME ZONE ${tz}::text`);
  if (f.to) where.push(`e.at < ((${add(f.to)}::date) + 1)::timestamp AT TIME ZONE ${tz}::text`);
  const limit = add(f.limit);
  const { rows } = await q(
    `SELECT e.id, e.at, e.action, e.details, e.task_id, e.actor_id, e.subject_user_id, u.name AS actor_name, t.title
     FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN tasks t ON t.id = e.task_id
     WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ${limit}`,
    list,
  );
  const t = translator(actor.lang);
  const names = await namesById();
  const labels = Object.fromEntries((await allLabels()).map((l) => [l.id, labelName(l, actor.lang)]));
  return {
    events: rows.map((e) => {
      let text = describe(e, t, { names, labels });
      if (e.action === 'task.commented' && e.details?.excerpt) text += `: “${e.details.excerpt}”`;
      return { at: localTime(e.at, timezone), who: e.actor_name || t('common.formerUser'), task_id: e.task_id, task: e.title, text };
    }),
  };
}

// ---------- changing ----------

const undoUntil = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();

// Changes that need the person to confirm first. Empty when the change can go ahead.
function confirmationReasons({ count, removesOthers = false }) {
  const why = [];
  if (count > MAX_DIRECT) why.push(`more than ${MAX_DIRECT} tasks at once`);
  if (removesOthers) why.push('taking someone else off a task');
  return why;
}

// input: { task_ids, status, priority, due_date, add_assignees, remove_assignees, add_labels, remove_labels, title, description, team_task }
// opts.confirmed: the person confirmed this change (a preview); opts.extra: more audit details.
export async function updateTasks(input, actor, ip, opts) {
  const { origin } = opts;
  const people = await teamPeople();
  const adding = resolvePeople(input.add_assignees, people, actor);
  const removing = resolvePeople(input.remove_assignees, people, actor);
  const labels = await allLabels();
  const labelsIn = resolveLabels(input.add_labels, labels);
  const labelsOut = resolveLabels(input.remove_labels, labels);
  // The reviewer must have an account; null clears it.
  let reviewerId;
  const reviewerMissing = [];
  if (input.reviewer === null) reviewerId = null;
  else if (input.reviewer !== undefined) {
    const withAccounts = people.filter((p) => p.has_account);
    reviewerId = personResolver(actor, withAccounts, reviewerMissing)(input.reviewer);
  }
  const missing = [...adding.missing, ...removing.missing, ...labelsIn.missing, ...labelsOut.missing, ...reviewerMissing];
  // Nothing changes while a name or label is unclear: ask, then try again.
  if (missing.length) return { changed: false, missing };
  const why = confirmationReasons({ count: input.task_ids.length, removesOthers: removing.ids.some((u) => u !== actor.id) });
  if (why.length && !opts.confirmed) {
    const names = await namesById();
    const changes = {};
    for (const k of ['status', 'priority', 'due_date', 'title', 'description', 'team_task']) if (input[k] !== undefined) changes[k] = input[k];
    if (adding.ids.length) changes.add_assignees = adding.ids.map((u) => names[u]);
    if (removing.ids.length) changes.remove_assignees = removing.ids.map((u) => names[u]);
    const labelOut = (list) => list.map((lid) => labelName(labels.find((l) => l.id === lid), actor.lang));
    if (labelsIn.ids.length) changes.add_labels = labelOut(labelsIn.ids);
    if (labelsOut.ids.length) changes.remove_labels = labelOut(labelsOut.ids);
    if (reviewerId !== undefined) changes.reviewer = reviewerId ? names[reviewerId] : null;
    const summary = { kind: 'update', count: input.task_ids.length, tasks: await titles(input.task_ids), changes };
    return { changed: false, why, preview: await createPreview('update', input, summary, actor, origin) };
  }

  const editing = input.priority !== undefined || input.due_date !== undefined || input.title !== undefined
    || input.description !== undefined || input.team_task !== undefined || reviewerId !== undefined
    || adding.ids.length > 0 || removing.ids.length > 0 || labelsIn.ids.length > 0 || labelsOut.ids.length > 0;
  const batch = randomUUID();
  const tag = { batch, via: VIA, ...opts.extra };
  const skipped = { missing: [], not_allowed: [], closed: [] };
  const updated = [];
  await tx(async (db) => {
    const review = [];
    for (const id of input.task_ids) {
      const found = await db.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
      const current = found.rows[0];
      if (!current) { skipped.missing.push(id); continue; }
      const assigned = (await db.query('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
      let touched = false;

      if (input.status) {
        const to = STATUS_IN[input.status];
        if (current.closed_at) {
          // A status on a closed task reopens it, as moving it on the board does.
          await reopenInside(db, current, actor, ip, to, tag);
          await audit(db, { actorId: actor.id, action: 'task.moved', taskId: id, details: { from: 'done', to, ...tag }, ip });
          current.closed_at = null;
          touched = true;
        } else if (current.status !== to) {
          await db.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [id, to]);
          await audit(db, { actorId: actor.id, action: 'task.moved', taskId: id, details: { from: current.status, to, ...tag }, ip });
          touched = true;
        }
        if (touched && to === 'review') review.push({ task: current, userIds: [] });
      }

      if (editing) {
        if (current.closed_at) {
          skipped.closed.push(id);
        } else if (!canEdit(actor, { ...current, assignees: assigned.map((u) => ({ id: u })) })) {
          skipped.not_allowed.push(id);
        } else {
          const labelIds = (await db.query('SELECT label_id FROM task_labels WHERE task_id = $1', [id])).rows.map((r) => r.label_id);
          const nextAssignees = [...assigned.filter((u) => !removing.ids.includes(u)), ...adding.ids.filter((u) => !assigned.includes(u))];
          const changed = await applyEdit(db, current, {
            title: input.title ?? current.title,
            description: input.description ?? current.description,
            priority: input.priority ? PRIORITY_IN[input.priority] : current.priority,
            due_date: input.due_date === undefined ? current.due_date : input.due_date,
            labels: [...labelIds.filter((l) => !labelsOut.ids.includes(l)), ...labelsIn.ids.filter((l) => !labelIds.includes(l))],
            assignees: nextAssignees,
            team_task: input.team_task ?? current.team_task,
            reviewer_id: reviewerId,
          }, actor, ip, tag);
          if (changed && adding.ids.some((u) => !assigned.includes(u))) await settleNoAssignee(db, id, actor, ip, tag);
          touched = touched || changed;
        }
      }
      if (touched) updated.push(id);
    }
    // Told after any change of reviewer in the same call: the reviewer, or else the creator.
    for (const item of review) {
      const now = (await db.query('SELECT reviewer_id, creator_id FROM tasks WHERE id = $1', [item.task.id])).rows[0];
      item.userIds = reviewersOf(now);
    }
    await notifyBatch(db, { kind: 'review', actor, items: review });
  });
  const rows = updated.length
    ? (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = ANY($1::int[]) ORDER BY t.id`, [updated])).rows.map((r) => taskRow(r, actor.lang, origin))
    : [];
  return { changed: updated.length > 0, batch: updated.length ? batch : null, undo_until: updated.length ? undoUntil(UNDO_MINUTES) : null, tasks: rows, skipped };
}

// input: { task_ids, reason, credit: [names], duplicate_of }
export async function closeTasks(input, actor, ip, opts) {
  const { origin } = opts;
  const reason = REASON_IN[input.reason];
  if (reason === 'duplicate' && input.task_ids.length > 1) throw new HttpError(400, 'one duplicate at a time');
  const credit = resolvePeople(input.credit, await teamPeople(), actor);
  if (credit.missing.length) return { changed: false, missing: credit.missing };
  const why = confirmationReasons({ count: input.task_ids.length });
  if (why.length && !opts.confirmed) {
    const names = await namesById();
    const summary = {
      kind: 'close', count: input.task_ids.length, tasks: await titles(input.task_ids), reason: input.reason,
      credit: credit.ids.map((u) => names[u]), duplicate_of: input.duplicate_of ?? null,
    };
    return { changed: false, why, preview: await createPreview('close', input, summary, actor, origin) };
  }

  const batch = randomUUID();
  const tag = { batch, via: VIA, ...opts.extra };
  const result = await tx(async (db) => {
    const { rows: found } = await db.query('SELECT * FROM tasks WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [input.task_ids]);
    const foundIds = new Set(found.map((t) => t.id));
    const skipped = { missing: input.task_ids.filter((id) => !foundIds.has(id)), already_closed: found.filter((t) => t.closed_at).map((t) => t.id) };
    const open = found.filter((t) => !t.closed_at);
    let dup = null;
    if (reason === 'duplicate' && input.duplicate_of) {
      if (input.duplicate_of === input.task_ids[0]) throw new HttpError(400, 'duplicate of itself');
      if (!(await db.query('SELECT id FROM tasks WHERE id = $1', [input.duplicate_of])).rows[0]) throw new HttpError(404, 'duplicate target missing');
      dup = input.duplicate_of;
    }
    // Completed needs someone credited on every task: the people named, or else its assignees.
    const plan = new Map();
    const noCredit = [];
    const named = await activeIds(db, credit.ids);
    for (const t of open) {
      let people = [];
      if (reason === 'completed') {
        people = named.length ? named : (await db.query(
          `SELECT ta.user_id FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = $1 AND u.status = 'active' ORDER BY ta.user_id`,
          [t.id],
        )).rows.map((r) => r.user_id);
        if (people.length === 0) noCredit.push(t.id);
      }
      plan.set(t.id, people);
    }
    if (noCredit.length) return { changed: false, needs_credit: noCredit, skipped };
    const credited = [];
    for (const t of open) {
      const people = plan.get(t.id);
      await db.query(
        `UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = $3, duplicate_of = $4, updated_at = now() WHERE id = $1`,
        [t.id, actor.id, reason, dup],
      );
      if (people.length) await db.query('INSERT INTO task_credits (task_id, user_id) SELECT $1, unnest($2::uuid[])', [t.id, people]);
      await audit(db, { actorId: actor.id, action: 'task.closed', taskId: t.id, details: { reason, credited: people, duplicate_of: dup, ...tag }, ip });
      if (reason === 'mistake' || reason === 'duplicate') {
        const settled = await db.query(
          `UPDATE flags SET resolved_at = now(), resolved_by = $2, resolution = 'closed' WHERE task_id = $1 AND resolved_at IS NULL RETURNING id`,
          [t.id, actor.id],
        );
        for (const f of settled.rows) {
          await audit(db, { actorId: actor.id, action: 'task.flag_resolved', taskId: t.id, details: { flag_id: f.id, resolution: 'closed', ...tag }, ip });
        }
      }
      if (people.length) credited.push({ task: t, userIds: people });
    }
    await notifyBatch(db, { kind: 'credited', actor, items: credited });
    return { changed: open.length > 0, closed: open.map((t) => t.id), skipped };
  });
  if (!result.changed) return { ...result, batch: null };
  const rows = (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = ANY($1::int[]) ORDER BY t.id`, [result.closed])).rows;
  return {
    changed: true, batch, undo_until: undoUntil(UNDO_MINUTES), skipped: result.skipped,
    tasks: rows.map((r) => ({ ...taskRow(r, actor.lang, origin), credited: (r.credits || []).map((c) => c.name) })),
  };
}

export async function joinOne(id, actor, ip, { origin }) {
  const { joined, batch } = await joinTask(id, actor, ip, { via: VIA });
  const row = (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = $1`, [id])).rows[0];
  return { joined, already_on_it: !joined, batch, undo_until: joined ? undoUntil(UNDO_MINUTES) : null, task: taskRow(row, actor.lang, origin) };
}

// Mentions are added as "@Full Name" so the usual mention rules notify them.
// A nudge is a comment that mentions someone to move a task along: at most one per task per day.
export async function comment({ task_id: id, text, mention, nudge }, actor, ip, { origin }) {
  const named = resolveNames(mention, await teamPeople());
  if (named.missing.length) return { posted: false, missing: named.missing };
  if (nudge && named.ids.length === 0) throw new HttpError(400, 'a nudge needs someone to mention');
  const exists = (await q('SELECT id FROM tasks WHERE id = $1', [id])).rows[0];
  if (!exists) throw new HttpError(404, 'task not found');
  if (nudge) {
    const recent = await q(
      `SELECT 1 FROM audit_events WHERE task_id = $1 AND action = 'task.commented' AND details->>'nudge' = 'true' AND at > now() - interval '1 day' LIMIT 1`,
      [id],
    );
    if (recent.rows[0]) return { posted: false, nudge_limit: 'This task was already nudged in the last day.' };
  }
  const names = await namesById();
  const prefix = named.ids.map((u) => `@${names[u]}`).filter((m) => !text.toLowerCase().includes(m.toLowerCase())).join(' ');
  const body = `${prefix ? `${prefix} ` : ''}${text}`.slice(0, 5000);
  const row = await addComment(id, body, actor, ip, nudge ? { via: VIA, nudge: true } : { via: VIA });
  return { posted: true, comment_id: row.id, text: body, url: `${origin}/tasks/${id}` };
}

export async function flag(input, actor, ip) {
  if (input.action === 'raise') {
    const row = await flagTask(input.task_id, { reason: input.reason, note: input.note || '' }, actor, ip, { via: VIA });
    return { raised: true, flag_id: row.id };
  }
  let flagId = input.flag_id;
  if (!flagId) {
    const open = (await q('SELECT id, reason, note FROM flags WHERE task_id = $1 AND resolved_at IS NULL ORDER BY id', [input.task_id])).rows;
    if (open.length === 0) return { resolved: false, problem: 'no_open_flags' };
    if (open.length > 1) return { resolved: false, problem: 'several_open_flags', open_flags: open };
    flagId = open[0].id;
  }
  await resolveFlag(input.task_id, flagId, input.resolution, actor, ip, { via: VIA });
  return { resolved: true, flag_id: flagId };
}

// Undo by batch id: tasks just added (one minute), or any other change (ten minutes).
export async function undoAny(batch, actor, ip) {
  const created = (await q(
    `SELECT 1 FROM audit_events WHERE actor_id = $1 AND action = 'task.created' AND details->>'batch' = $2 LIMIT 1`,
    [actor.id, batch],
  )).rows[0];
  if (created) return { kind: 'added_tasks', ...(await undoCapture(batch, actor, ip)) };
  return { kind: 'changes', ...(await undoBatch(batch, actor, ip)) };
}

export async function markRead({ all, notification_ids: ids }, actor) {
  const { rowCount } = all
    ? await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [actor.id])
    : await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])', [actor.id, ids]);
  return { marked_read: rowCount };
}

// Who the person is, today, and the team's people and labels.
export async function teamOverview(actor, { timezone, wipLimit }) {
  const people = await teamPeople();
  return {
    you: actor.name,
    your_role: actor.role,
    your_language: actor.lang,
    your_skills: await skillsOf(actor),
    timezone,
    people: people.map((p) => ({ name: p.name, has_account: p.has_account })),
    labels: (await allLabels()).map((l) => ({ en: l.name_en, ar: l.name_ar })),
    in_progress: { now: await inProgressCount(), limit: await getWipLimit(wipLimit) },
  };
}

// ---------- adding tasks ----------

// For each new task, up to three open tasks with a similar title.
async function similarOpen(created, actor, origin) {
  const { rows } = await q(
    'SELECT id, title FROM tasks WHERE closed_at IS NULL AND NOT (id = ANY($1::int[])) ORDER BY id DESC LIMIT 2000',
    [created.map((c) => c.id)],
  );
  const picks = new Map();
  for (const c of created) {
    picks.set(c.id, rows.map((r) => ({ id: r.id, score: alike(c.title, r.title) }))
      .filter((m) => m.score >= 0.5 && m.id !== c.close_match_id).sort((x, y) => y.score - x.score || y.id - x.id).slice(0, 3).map((m) => m.id));
  }
  const ids = [...new Set([...picks.values()].flat())];
  if (ids.length === 0) return new Map();
  const full = new Map((await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = ANY($1::int[])`, [ids])).rows
    .map((r) => [r.id, taskRow(r, actor.lang, origin)]));
  return new Map([...picks].map(([id, list]) => [id, list.map((m) => full.get(m))]));
}

// data: { source, tasks } as validated. More than MAX_ADD tasks wait for confirmation.
export async function addTasks(data, actor, ip, opts) {
  const { origin } = opts;
  if (data.tasks.length > MAX_ADD && !opts.confirmed) {
    const people = await teamPeople();
    const names = await namesById();
    const summary = {
      kind: 'create',
      count: data.tasks.length,
      tasks: data.tasks.map((t) => {
        const who = resolveNames(t.assignees, people).ids;
        if (t.assign_to_me && !who.includes(actor.id)) who.unshift(actor.id);
        return {
          title: t.title, assignees: who.map((u) => names[u]), status: t.started ? 'in_progress' : 'todo', priority: t.priority, due_date: t.due_date ?? null,
        };
      }),
    };
    return { changed: false, why: [`more than ${MAX_ADD} new tasks at once`], preview: await createPreview('create', data, summary, actor, origin) };
  }
  const result = await captureTasks(data.tasks, actor, ip, { source: data.source, origin, extra: opts.extra || {} });
  const similar = await similarOpen(result.tasks, actor, origin);
  for (const t of result.tasks) {
    const list = similar.get(t.id) || [];
    if (list.length) t.similar = list;
    // A close match is flagged on the new task and shown in full, so the person can merge them.
    if (t.close_match_id) {
      const [row] = (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = $1`, [t.close_match_id])).rows;
      if (row) t.close_match = { flag_id: t.close_match_flag, task: closeMatchRow(row, actor, origin) };
    }
    delete t.close_match_id;
    delete t.close_match_flag;
  }
  if (result.tasks.some((t) => t.status === 'in_progress')) {
    const [count, limit] = await Promise.all([inProgressCount(), getWipLimit(opts.wipLimit)]);
    if (count > limit) result.warning = `In progress now has ${count} tasks, over the team's limit of ${limit}. The tasks were still added.`;
  }
  return result;
}

export const createFromPreview = (payload, actor, ip, opts) => addTasks(payload, actor, ip, opts);

// ---------- close matches ----------

function closeMatchRow(row, actor, origin) {
  const out = taskRow(row, actor.lang, origin);
  if (row.closed_at) out.closed_on = String(row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at).slice(0, 10);
  return out;
}

// The older task a task closely matches, while its close-match flag is open.
export async function closeMatchOf(taskId, actor, origin) {
  const found = await openCloseMatch(taskId);
  if (!found) return null;
  const [row] = (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = $1`, [found.match_id])).rows;
  return row ? { flag_id: found.flag_id, task: closeMatchRow(row, actor, origin) } : null;
}

export async function mergeTask(id, actor, ip, { origin }) {
  const result = await mergeIntoMatch(id, actor, ip, { via: VIA });
  const [row] = (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = $1`, [result.into])).rows;
  return { ...result, task: taskRow(row, actor.lang, origin) };
}

// ---------- skills, suggestions and taking a task ----------

export async function skillsOf(actor) {
  return (await q('SELECT skills FROM users WHERE id = $1', [actor.id])).rows[0]?.skills || [];
}

// mode: add (default), remove or replace.
export async function setSkills({ skills, mode }, actor) {
  const current = await skillsOf(actor);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  let next;
  if (mode === 'replace') next = skills;
  else if (mode === 'remove') next = current.filter((s) => !skills.some((x) => same(x, s)));
  else next = [...current, ...skills.filter((x) => !current.some((s) => same(x, s)))];
  if (next.length > 20) throw new HttpError(400, 'at most 20 skills');
  await q('UPDATE users SET skills = $2 WHERE id = $1', [actor.id, next]);
  return { your_skills: next };
}

const PRIORITY_WEIGHT = { high: 3, med: 2, low: 1 };
const contains = (text, phrase) => {
  const p = normaliseName(phrase);
  return p.length > 1 && ` ${text} `.includes(` ${p} `);
};

// Open tasks the person isn't on, ranked by how well they fit: priority, their
// saved skills (matched in titles, descriptions and labels), labels of work they
// were credited for in the last 90 days, team tasks, due dates and waiting time.
// Each comes with the reasons and what is unknown, so nothing is guessed.
export async function suggest({ limit }, actor, { timezone, origin, wipLimit }) {
  const today = localToday(timezone);
  const skills = await skillsOf(actor);
  const recent = (await q(
    `SELECT l.id, l.name_en, l.name_ar, count(*)::int AS n
     FROM task_credits tc JOIN tasks t ON t.id = tc.task_id JOIN task_labels tl ON tl.task_id = t.id JOIN labels l ON l.id = tl.label_id
     WHERE tc.user_id = $1 AND t.closed_at > now() - interval '90 days'
     GROUP BY l.id ORDER BY n DESC, l.id`,
    [actor.id],
  )).rows;
  const { rows, total } = await suggestedTasks(actor.id, { limit: 60 });
  const descriptions = new Map(rows.length
    ? (await q('SELECT id, description FROM tasks WHERE id = ANY($1::int[])', [rows.map((r) => r.id)])).rows.map((r) => [r.id, r.description])
    : []);
  const ranked = rows.map((r, order) => {
    const description = descriptions.get(r.id) || '';
    const text = normaliseName([r.title, description, ...r.labels.flatMap((l) => [l.name_en, l.name_ar])].join(' '));
    const skillHits = skills.filter((sk) => contains(text, sk));
    const labelHits = recent.filter((l) => r.labels.some((x) => x.id === l.id)).map((l) => labelName(l, actor.lang));
    const overdue = !!r.due_date && r.due_date < today;
    const dueSoon = !!r.due_date && !overdue && r.due_date <= addDays(today, 7);
    const waitingDays = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
    const score = PRIORITY_WEIGHT[r.priority] + 2 * skillHits.length + labelHits.length + (r.team_task ? 1 : 0)
      + (overdue ? 2 : dueSoon ? 1 : 0) + (waitingDays > 14 ? 0.5 : 0) - (r.status === 'backlog' ? 0.5 : 0);
    const unknown = [];
    if (!r.due_date) unknown.push('due_date');
    if (!description.trim()) unknown.push('description');
    return {
      order,
      score,
      task: {
        ...taskRow(r, actor.lang, origin),
        why: {
          skills: skillHits, like_work_you_finished: labelHits, team_task: !!r.team_task, others_on_it: r.assignees.map((a) => a.name),
          overdue, due_soon: dueSoon, waiting_days: waitingDays,
        },
        unknown,
        score,
      },
    };
  }).sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    skills_saved: skills.length > 0,
    your_skills: skills,
    your_recent_labels: recent.slice(0, 5).map((l) => labelName(l, actor.lang)),
    your_in_progress: (await q(
      `SELECT count(*)::int AS n FROM tasks t WHERE t.closed_at IS NULL AND t.status = 'progress'
         AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = $1)`,
      [actor.id],
    )).rows[0].n,
    team_in_progress: { now: await inProgressCount(), limit: await getWipLimit(wipLimit) },
    open_tasks_you_are_not_on: total,
    candidates: ranked.slice(0, limit).map((x) => x.task),
  };
}

// Join a task and move it to In progress in one go (one Undo).
export async function takeTask(id, actor, ip, { origin, wipLimit }) {
  const batch = randomUUID();
  const tag = { batch, via: VIA };
  await tx(async (db) => {
    const task = await lockTask(db, id);
    if (task.closed_at) throw new HttpError(409, 'task closed');
    const { rowCount } = await db.query('INSERT INTO task_assignees (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, actor.id]);
    if (rowCount) {
      await audit(db, { actorId: actor.id, action: 'task.edited', taskId: id, details: { changes: { assignees: { added: [actor.id], removed: [] } }, ...tag }, ip });
      await settleNoAssignee(db, id, actor, ip, tag);
    }
    if (task.status !== 'progress') {
      await db.query(`UPDATE tasks SET status = 'progress' WHERE id = $1`, [id]);
      await audit(db, { actorId: actor.id, action: 'task.moved', taskId: id, details: { from: task.status, to: 'progress', ...tag }, ip });
    }
    await db.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [id]);
  });
  const row = (await q(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.id = $1`, [id])).rows[0];
  const result = { taken: true, batch, undo_until: undoUntil(UNDO_MINUTES), task: taskRow(row, actor.lang, origin) };
  const [count, limit] = await Promise.all([inProgressCount(), getWipLimit(wipLimit)]);
  if (count > limit) result.warning = `In progress now has ${count} tasks, over the team's limit of ${limit}.`;
  return result;
}

// ---------- the board ----------

const BOARD_LIMIT = 400;

// Open tasks for the full-screen board (most urgent first), and which are the
// person's own or waiting for their review.
export async function boardSnapshot(actor, { timezone, origin, wipLimit }) {
  const { rows } = await q(
    `SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE t.closed_at IS NULL
     ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END, t.due_date ASC NULLS LAST, t.id DESC
     LIMIT ${BOARD_LIMIT}`,
  );
  const on = (r) => r.assignees.some((a) => a.id === actor.id);
  const counts = Object.fromEntries((await q(
    `SELECT status, count(*)::int AS n FROM tasks WHERE closed_at IS NULL GROUP BY status`,
  )).rows.map((r) => [STATUS_OUT[r.status], r.n]));
  return {
    you: actor.name,
    today: localToday(timezone),
    in_progress_limit: await getWipLimit(wipLimit),
    counts: { backlog: counts.backlog || 0, todo: counts.todo || 0, in_progress: counts.in_progress || 0, review: counts.review || 0 },
    shown: rows.length,
    tasks: rows.map((r) => taskRow(r, actor.lang, origin)),
    mine: rows.filter(on).map((r) => r.id),
    review: rows.filter((r) => r.status === 'review'
      && (r.reviewer_id === actor.id || (!r.reviewer_id && r.creator_id === actor.id && !on(r)))).map((r) => r.id),
  };
}
