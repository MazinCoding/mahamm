import { randomUUID } from 'node:crypto';
import { audit } from '../audit.js';
import { q, tx } from '../db.js';
import { translator } from '../i18n.js';
import { notifyBatch } from '../notify.js';
import { HttpError, applyEdit, assertTraineeAssigns, canEdit, getTask, lockTask, reviewersOf } from './tasks.js';
import { flagCloseMatch } from './matches.js';

// Tasks captured through the connector: created straight away from what a
// person said or typed, with a short Undo. The rules (agreed in the connector
// spec) are applied here, not left to the caller:
// - named people are assigned; the speaker is only the creator unless they
//   take the task themselves;
// - In progress only when the work has started, otherwise To do;
// - a name that matches nobody, or several people, assigns nobody and is
//   reported back so the person can be asked;
// - an In progress task with nobody assigned gets a "No assignee" flag.

export const UNDO_CREATED_SECONDS = 60;
const PRIORITY_IN = { high: 'high', medium: 'med', low: 'low' };
const PRIORITY_OUT = { high: 'high', med: 'medium', low: 'low' };
const STATUS_OUT = { backlog: 'backlog', todo: 'todo', progress: 'in_progress', review: 'review' };

// Names compare without case, accents, punctuation or common Arabic spelling
// variants (hamza on alef, final ya and ta marbuta, tatweel).
export function normaliseName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ـ/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// One person when the name is clear; otherwise "unknown" or a "clash" with
// everyone it could be. A full-name match wins; otherwise every word heard
// must appear in the person's name ("Ahmed" matches "Ahmed Al Balushi").
export function matchPerson(heard, people) {
  const h = normaliseName(heard);
  if (!h) return { status: 'unknown', candidates: [] };
  const exact = people.filter((p) => normaliseName(p.name) === h);
  if (exact.length === 1) return { status: 'matched', person: exact[0] };
  const words = h.split(' ');
  const partial = exact.length > 1 ? exact : people.filter((p) => {
    const name = normaliseName(p.name).split(' ');
    return words.every((w) => name.includes(w));
  });
  if (partial.length === 1) return { status: 'matched', person: partial[0] };
  if (partial.length > 1) return { status: 'clash', candidates: partial };
  return { status: 'unknown', candidates: [] };
}

// Everyone who can be assigned: active people, with or without an account.
export async function teamPeople(db = { query: q }) {
  const { rows } = await db.query(
    `SELECT id, name, (email IS NOT NULL) AS has_account FROM users WHERE status = 'active' ORDER BY name`,
  );
  return rows;
}

export function resolveNames(names, people) {
  const ids = [];
  const missing = [];
  for (const heard of names) {
    const m = matchPerson(heard, people);
    if (m.status === 'matched') {
      if (!ids.includes(m.person.id)) ids.push(m.person.id);
    } else if (m.status === 'clash') {
      missing.push({ heard, problem: 'several_people', could_be: m.candidates.map((c) => c.name) });
    } else {
      missing.push({ heard, problem: 'nobody_by_that_name' });
    }
  }
  return { ids, missing };
}

// Settles the automatic "No assignee" flag on a task once someone is assigned.
export async function settleNoAssignee(db, id, actor, ip, extra = {}) {
  const { rows: settled } = await db.query(
    `UPDATE flags f SET resolved_at = now(), resolved_by = $2, resolution = 'fixed'
     WHERE f.task_id = $1 AND f.resolved_at IS NULL AND EXISTS (
       SELECT 1 FROM audit_events e WHERE e.task_id = $1 AND e.action = 'task.flagged'
         AND e.details->>'auto' = 'no_assignee' AND (e.details->>'flag_id')::int = f.id)
     RETURNING f.id`,
    [id, actor.id],
  );
  for (const f of settled) {
    await audit(db, { actorId: actor.id, action: 'task.flag_resolved', taskId: id, details: { flag_id: f.id, resolution: 'fixed', ...extra }, ip });
  }
  return settled.length;
}

// Label names (English or Arabic) to label ids; unknown names are reported.
export function resolveLabels(names, labels) {
  const ids = [];
  const missing = [];
  for (const heard of names) {
    const h = normaliseName(heard);
    const hit = labels.find((l) => normaliseName(l.name_en) === h || normaliseName(l.name_ar) === h);
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else missing.push({ heard, problem: 'no_such_label' });
  }
  return { ids, missing };
}

export function summary(task, origin) {
  return {
    id: task.id,
    url: `${origin}/tasks/${task.id}`,
    title: task.title,
    status: task.closed_at ? 'done' : STATUS_OUT[task.status],
    priority: PRIORITY_OUT[task.priority],
    due_date: task.due_date || null,
    assignees: task.assignees.map((a) => a.name),
    team_task: task.team_task,
    flagged: task.open_flags > 0,
  };
}

// items: [{ title, description, labels: [names], assignees: [names], assign_to_me, started, team_task, priority, due_date }]
export async function captureTasks(items, actor, ip, { source = 'text', origin, extra = {} }) {
  const batch = randomUUID();
  const t = translator(actor.lang);
  const created = await tx(async (db) => {
    const people = await teamPeople(db);
    const labels = (await db.query('SELECT id, name_en, name_ar FROM labels')).rows;
    const out = [];
    const notices = [];
    for (const item of items) {
      const { ids, missing } = resolveNames(item.assignees, people);
      const tags = resolveLabels(item.labels || [], labels);
      missing.push(...tags.missing);
      if (item.assign_to_me && !ids.includes(actor.id)) ids.unshift(actor.id);
      assertTraineeAssigns(actor, [], ids);
      const status = item.started ? 'progress' : 'todo';
      const { rows } = await db.query(
        `INSERT INTO tasks (title, description, status, priority, due_date, creator_id, team_task)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, title`,
        [item.title, item.description || '', status, PRIORITY_IN[item.priority] || 'med', item.due_date || null, actor.id, item.team_task],
      );
      const task = rows[0];
      if (ids.length) await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $1, unnest($2::uuid[])', [task.id, ids]);
      if (tags.ids.length) await db.query('INSERT INTO task_labels (task_id, label_id) SELECT $1, unnest($2::int[])', [task.id, tags.ids]);
      await audit(db, {
        actorId: actor.id, action: 'task.created', taskId: task.id, details: { title: task.title, batch, via: 'connector', source, ...extra }, ip,
      });
      const closeMatch = await flagCloseMatch(db, task, actor, ip, { exclude: out.map((o) => o.id), batch, via: 'connector' });
      if (status === 'progress' && ids.length === 0) {
        const heard = missing.filter((m) => m.problem !== 'no_such_label').map((m) => m.heard);
        const note = heard.length
          ? t('connector.noAssigneeSuggested', { names: heard.join(t('common.listSep')), where: t(`connector.${source}`) })
          : t('connector.noAssignee');
        const f = (await db.query(
          `INSERT INTO flags (task_id, flagged_by, reason, note) VALUES ($1, $2, 'other', $3) RETURNING id`,
          [task.id, actor.id, note.slice(0, 1000)],
        )).rows[0];
        await audit(db, {
          actorId: actor.id, action: 'task.flagged', taskId: task.id,
          details: { flag_id: f.id, reason: 'other', note, batch, via: 'connector', auto: 'no_assignee' }, ip,
        });
      }
      notices.push({ task, userIds: ids });
      out.push({ id: task.id, missing, closeMatch });
    }
    await notifyBatch(db, { kind: 'assigned', actor, items: notices });
    return out;
  });
  const tasks = [];
  for (const c of created) {
    const row = { ...summary(await getTask(c.id), origin), missing: c.missing };
    if (c.closeMatch) Object.assign(row, { close_match_id: c.closeMatch.match, close_match_flag: c.closeMatch.flag_id });
    tasks.push(row);
  }
  return { batch, undo_until: new Date(Date.now() + UNDO_CREATED_SECONDS * 1000).toISOString(), tasks };
}

// Undo a capture: within a minute, only by the person who made it, and only
// for tasks nobody has touched since. Nothing is deleted: each task is closed
// as "Created by mistake", recorded as new history, and its flags are settled.
export async function undoCapture(batch, actor, ip) {
  return tx(async (db) => {
    const { rows: events } = await db.query(
      `SELECT id, task_id FROM audit_events
       WHERE actor_id = $1 AND action = 'task.created' AND details->>'batch' = $2
         AND at > now() - make_interval(secs => $3)
       ORDER BY id`,
      [actor.id, batch, UNDO_CREATED_SECONDS],
    );
    if (events.length === 0) return { expired: true, undone: [], changed: [] };
    const ids = events.map((e) => e.task_id);
    const { rows: locked } = await db.query('SELECT * FROM tasks WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    const tasks = new Map(locked.map((t) => [t.id, t]));
    const { rows: later } = await db.query(
      `SELECT task_id FROM audit_events
       WHERE task_id = ANY($1::int[]) AND id > $2 AND (details->>'batch') IS DISTINCT FROM $3`,
      [ids, events[0].id, batch],
    );
    const touched = new Set(later.map((l) => l.task_id));
    const undone = [];
    const changed = [];
    for (const id of ids) {
      const task = tasks.get(id);
      if (!task || task.closed_at || touched.has(id)) {
        changed.push(id);
        continue;
      }
      await db.query(
        `UPDATE tasks SET closed_at = now(), closed_by = $2, close_reason = 'mistake', updated_at = now() WHERE id = $1`,
        [id, actor.id],
      );
      await audit(db, {
        actorId: actor.id, action: 'task.closed', taskId: id,
        details: { reason: 'mistake', credited: [], duplicate_of: null, undo_of: batch, via: 'connector' }, ip,
      });
      const open = await db.query(
        `UPDATE flags SET resolved_at = now(), resolved_by = $2, resolution = 'closed' WHERE task_id = $1 AND resolved_at IS NULL RETURNING id`,
        [id, actor.id],
      );
      for (const f of open.rows) {
        await audit(db, { actorId: actor.id, action: 'task.flag_resolved', taskId: id, details: { flag_id: f.id, resolution: 'closed', undo_of: batch }, ip });
      }
      undone.push(id);
    }
    return { expired: false, undone, changed };
  });
}

// Follow-up changes, such as answering "which Ahmed?". Status is open to
// everyone (as on the board); other fields need the usual edit rights.
export async function updateCaptured(id, changes, actor, ip, { origin }) {
  const batch = randomUUID();
  const result = await tx(async (db) => {
    const current = await lockTask(db, id);
    if (current.closed_at) throw new HttpError(409, 'task closed');
    const assigned = (await db.query('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    const editing = changes.add_assignees.length > 0 || changes.due_date !== undefined || changes.priority !== undefined || changes.team_task !== undefined;
    if (editing && !canEdit(actor, { ...current, assignees: assigned.map((u) => ({ id: u })) })) throw new HttpError(403, 'not allowed');

    if (changes.status && changes.status !== current.status) {
      await db.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [id, changes.status]);
      await audit(db, { actorId: actor.id, action: 'task.moved', taskId: id, details: { from: current.status, to: changes.status, batch, via: 'connector' }, ip });
      if (changes.status === 'review') {
        await notifyBatch(db, { kind: 'review', actor, items: [{ task: current, userIds: reviewersOf(current) }] });
      }
    }

    const { ids: named, missing } = resolveNames(changes.add_assignees, await teamPeople(db));
    const added = named.filter((u) => !assigned.includes(u));
    if (editing) {
      const labels = (await db.query('SELECT label_id FROM task_labels WHERE task_id = $1', [id])).rows.map((r) => r.label_id);
      await applyEdit(db, current, {
        title: current.title,
        description: current.description,
        priority: changes.priority ? PRIORITY_IN[changes.priority] : current.priority,
        due_date: changes.due_date === undefined ? current.due_date : changes.due_date,
        labels,
        assignees: [...assigned, ...added],
        team_task: changes.team_task === undefined ? current.team_task : changes.team_task,
      }, actor, ip, { batch, via: 'connector' });
    }

    // Someone is assigned now, so the automatic "No assignee" flag is settled.
    if (added.length) await settleNoAssignee(db, id, actor, ip, { batch, via: 'connector' });
    return { missing };
  });
  return { ...summary(await getTask(id), origin), missing: result.missing };
}
