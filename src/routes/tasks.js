import express from 'express';
import { describe } from '../audit.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { q } from '../db.js';
import { limiter } from '../ratelimit.js';
import { safeLocalPath } from '../security.js';
import { MAX_ATTACHMENT_BYTES, checkAttachment, uploadThenCsrf } from '../uploads.js';
import {
  HttpError, OPEN_STATUSES, PAGE_SIZE, PRIORITIES, TABLE_DUE, TABLE_SORTS, addAttachment, addComment, boardStats, boardTasks,
  UNDO_MINUTES, bulkApply, bulkClose, canEdit, canResolveFlags, closeTask, createTask, flagTask, getAttachment, getTask, joinTask, listTasks, saveDetails,
  moveTask, removeAttachment, reopenTask, resolveFlag, tableTasks, taskDetail, tasksToClose, undoBatch, updateTask,
} from '../services/tasks.js';

const TABLE_COLORS = ['status', 'priority', 'label', 'none'];
import { getWipLimit, inProgressCount, setWipLimit } from '../services/settings.js';
import { activePeople, allPeopleNames } from '../services/users.js';
import {
  bulkCloseSchema, bulkIdsSchema, bulkSchema, closeSchema, commentSchema, detailsSchema, mineSchema, quickAddSchema, undoSchema, wipLimitSchema, editTaskSchema, flagSchema, idParam, moveSchema, newTaskSchema, parse, uuidParam,
} from '../validation.js';

async function allLabels() {
  return (await q('SELECT id, name_en, name_ar, color FROM labels ORDER BY id')).rows;
}

function taskId(req) {
  const id = idParam(req.params.id);
  if (!id) throw new HttpError(404, 'not found');
  return id;
}

async function loadTask(req) {
  const task = await getTask(taskId(req));
  if (!task) throw new HttpError(404, 'not found');
  return task;
}

const flash = (req, text, type = 'ok', undo = null) => {
  req.session.flash = undo ? { type, text, undo } : { type, text };
};

export default function taskRoutes(config) {
  const r = express.Router();
  const writeLimit = limiter({ name: 'writes', limit: 120, windowSeconds: 60 });

  r.get('/board', requireAuth, async (req, res) => {
    const mine = req.query.mine === '1';
    const wipLimit = await getWipLimit(config.wipLimit);
    const [tasks, stats] = await Promise.all([boardTasks({ onlyUserId: mine ? req.user.id : null }), boardStats(wipLimit, config.timezone)]);
    const columns = [...OPEN_STATUSES, 'done'].map((key) => ({
      key,
      tasks: tasks.filter((t) => (key === 'done' ? !!t.closed_at : !t.closed_at && t.status === key)),
    }));
    const done = columns.find((c) => c.key === 'done');
    done.tasks.sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    res.render('board.njk', { columns, stats, mine, today, wipLimit });
  });

  r.get('/tasks', requireAuth, async (req, res) => {
    const filters = {
      state: req.query.state === 'closed' ? 'closed' : 'open',
      q: String(req.query.q || '').slice(0, 100),
      label: idParam(req.query.label),
      person: uuidParam(req.query.person),
      priority: ['high', 'med', 'low'].includes(req.query.priority) ? req.query.priority : null,
      flagged: req.query.flagged === '1',
      page: Math.min(idParam(req.query.page) || 1, 10000),
    };
    const [{ rows, counts }, labels, people] = await Promise.all([listTasks(filters), allLabels(), allPeopleNames()]);
    const total = filters.state === 'closed' ? counts.closed : counts.open;
    const query = (extra) => {
      const p = new URLSearchParams();
      const merged = { ...filters, ...extra };
      if (merged.state === 'closed') p.set('state', 'closed');
      if (merged.q) p.set('q', merged.q);
      if (merged.label) p.set('label', merged.label);
      if (merged.person) p.set('person', merged.person);
      if (merged.priority) p.set('priority', merged.priority);
      if (merged.flagged) p.set('flagged', '1');
      if (merged.page > 1) p.set('page', merged.page);
      const s = p.toString();
      return s ? `/tasks?${s}` : '/tasks';
    };
    res.render('list.njk', {
      rows, counts, labels, people, filters, total,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      openUrl: query({ state: 'open', page: 1 }),
      closedUrl: query({ state: 'closed', page: 1 }),
      prevUrl: filters.page > 1 ? query({ page: filters.page - 1 }) : null,
      nextUrl: filters.page * PAGE_SIZE < total ? query({ page: filters.page + 1 }) : null,
      hasFilters: !!(filters.q || filters.label || filters.person || filters.priority || filters.flagged),
    });
  });

  // Spreadsheet-style table. Every option comes from a fixed list; anything else is ignored.
  r.get('/table', requireAuth, async (req, res) => {
    const pick = (v, allowed) => (allowed.includes(v) ? v : null);
    const closed = req.query.closed === '1';
    const filters = {
      q: String(req.query.q || '').slice(0, 100),
      status: pick(req.query.status, closed ? [...OPEN_STATUSES, 'done'] : OPEN_STATUSES),
      label: idParam(req.query.label),
      person: uuidParam(req.query.person),
      priority: pick(req.query.priority, PRIORITIES),
      due: pick(req.query.due, TABLE_DUE),
      flagged: req.query.flagged === '1',
      closed,
      sort: pick(req.query.sort, Object.keys(TABLE_SORTS)),
      dir: pick(req.query.dir, ['asc', 'desc']),
      color: pick(req.query.color, TABLE_COLORS) || 'status',
      page: Math.min(idParam(req.query.page) || 1, 10000),
    };
    const [{ rows, total }, labels, people, assignable, wipLimit, wipCount] = await Promise.all([
      tableTasks({ ...filters, timezone: config.timezone }), allLabels(), allPeopleNames(), activePeople(),
      getWipLimit(config.wipLimit), inProgressCount(),
    ]);
    for (const row of rows) row.editable = !row.closed_at && canEdit(req.user, row);
    const query = (extra = {}) => {
      const m = { ...filters, ...extra };
      const p = new URLSearchParams();
      for (const key of ['q', 'status', 'label', 'person', 'priority', 'due', 'sort', 'dir']) if (m[key]) p.set(key, m[key]);
      if (m.flagged) p.set('flagged', '1');
      if (m.closed) p.set('closed', '1');
      if (m.color !== 'status') p.set('color', m.color);
      if (m.page > 1) p.set('page', m.page);
      const s = p.toString();
      return s ? `/table?${s}` : '/table';
    };
    // Header links: same column flips the direction, a new column starts at its natural one.
    const sortLinks = Object.fromEntries(Object.entries(TABLE_SORTS).map(([key, s]) => {
      const current = filters.sort === key ? (filters.dir || s.dir) : null;
      const next = current ? (current === 'asc' ? 'desc' : 'asc') : s.dir;
      return [key, { url: query({ sort: key, dir: next, page: 1 }), current }];
    }));
    res.render('table.njk', {
      rows, total, labels, people, assignable, filters, sortLinks, wip: { count: wipCount, limit: wipLimit },
      today: new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date()),
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      prevUrl: filters.page > 1 ? query({ page: filters.page - 1 }) : null,
      nextUrl: filters.page * PAGE_SIZE < total ? query({ page: filters.page + 1 }) : null,
      clearUrl: query({ q: '', status: null, label: null, person: null, priority: null, due: null, flagged: false, page: 1 }),
      hasFilters: !!(filters.q || filters.status || filters.label || filters.person || filters.priority || filters.due || filters.flagged),
    });
  });

  // Table ribbon: one value applied to the selected rows. JSON from the page script,
  // or a normal form post (with a redirect back) when JavaScript is off.
  r.post('/tasks/bulk', requireAuth, writeLimit, async (req, res) => {
    const json = req.is('application/json');
    const back = tableBack(req.body.back);
    const refuse = (key) => {
      if (json) return res.status(400).json({ ok: false, message: req.t(key) });
      flash(req, req.t(key), 'warn');
      return res.redirect(back);
    };
    // "Done" always goes through the close page, so someone is credited for each task.
    if (String(req.body.apply ?? '') === 'close') {
      const picked = parse(bulkIdsSchema, req.body);
      if (picked.errors) return refuse('table.selectFirst');
      const p = new URLSearchParams();
      for (const id of picked.data.ids) p.append('ids', String(id));
      p.set('back', back);
      const url = `/table/close?${p}`;
      return json ? res.json({ ok: true, redirect: url }) : res.redirect(url);
    }
    const result = parse(bulkSchema, req.body);
    if (result.errors) return refuse(result.errors.ids ? 'table.selectFirst' : 'table.invalid');
    const { ids, op, value } = result.data;
    let outcome;
    try {
      outcome = await bulkApply(ids, { op, value }, req.user, req.ip);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) return refuse('table.invalid');
      throw err;
    }
    let text = await bulkMessage(req, op, value, outcome);
    // Going over the in-progress limit is allowed, but said out loud.
    if (op === 'status' && value === 'progress' && outcome.updated.length) {
      const [count, limit] = await Promise.all([inProgressCount(), getWipLimit(config.wipLimit)]);
      if (count > limit) text += ` ${req.t('table.result.overWip', { n: count, limit })}`;
    }
    flash(req, text, outcome.updated.length ? 'ok' : 'warn', outcome.updated.length ? outcome.batch : null);
    if (json) return res.json({ ok: true, updated: outcome.updated, skipped: outcome.skipped });
    return res.redirect(back);
  });

  // "Done" for several tasks: a short page to pick the reason and, for Completed, who did each one.
  const renderBulkClose = async (req, res, { ids, back, values, errors = {}, status = 200 }) => {
    const tasks = await tasksToClose(ids);
    const open = tasks.filter((t) => !t.closed_at);
    if (open.length === 0) {
      flash(req, req.t('bulkClose.nothing'), 'warn');
      return res.redirect(back);
    }
    const people = await activePeople();
    return res.status(status).render('tasks/bulk-close.njk', {
      tasks: open, alreadyClosed: tasks.filter((t) => t.closed_at).map((t) => `#${t.id}`).join(req.t('common.listSep')),
      people, back, values, errors,
    });
  };

  r.get('/table/close', requireAuth, async (req, res) => {
    const back = tableBack(req.query.back);
    const picked = parse(bulkIdsSchema, { ids: req.query.ids });
    if (picked.errors) {
      flash(req, req.t('table.selectFirst'), 'warn');
      return res.redirect(back);
    }
    return renderBulkClose(req, res, { ids: picked.data.ids, back, values: { reason: 'completed', credit: {} } });
  });

  r.post('/tasks/bulk/close', requireAuth, writeLimit, async (req, res) => {
    const back = tableBack(req.body.back);
    const result = parse(bulkCloseSchema, req.body);
    const ids = parse(bulkIdsSchema, req.body);
    if (ids.errors) {
      flash(req, req.t('table.selectFirst'), 'warn');
      return res.redirect(back);
    }
    const order = [].concat(req.body.ids || []).map(Number);
    const sent = [].concat(req.body.credit ?? []);
    const values = {
      reason: ['completed', 'notneeded', 'mistake'].includes(req.body.reason) ? req.body.reason : 'completed',
      credit: Object.fromEntries(order.map((id, i) => [id, String(sent[i] ?? '')])),
    };
    if (result.errors) return renderBulkClose(req, res, { ids: ids.data.ids, back, values, errors: { form: true }, status: 400 });
    const credits = {};
    result.data.ids.forEach((id, i) => {
      if (result.data.credit[i]) credits[id] = result.data.credit[i];
    });
    let outcome;
    try {
      outcome = await bulkClose(ids.data.ids, { reason: result.data.reason, credits }, req.user, req.ip);
    } catch (err) {
      if (err instanceof HttpError && err.missing) {
        return renderBulkClose(req, res, { ids: ids.data.ids, back, values, errors: { missing: err.missing }, status: 400 });
      }
      throw err;
    }
    const list = (xs) => xs.map((id) => `#${id}`).join(req.t('common.listSep'));
    const parts = [req.t('table.result.closedN', { n: outcome.updated.length })];
    if (outcome.skipped.closed.length) parts.push(req.t('table.result.closed', { list: list(outcome.skipped.closed) }));
    if (outcome.skipped.missing.length) parts.push(req.t('table.result.missing', { list: list(outcome.skipped.missing) }));
    flash(req, parts.join(' '), outcome.updated.length ? 'ok' : 'warn', outcome.updated.length ? outcome.batch : null);
    return res.redirect(back);
  });

  // Undo the last table action (the flash message carries its batch id).
  r.post('/tasks/bulk/undo', requireAuth, writeLimit, async (req, res) => {
    const back = tableBack(req.body.back);
    const result = parse(undoSchema, req.body);
    const out = result.errors ? { expired: true } : await undoBatch(result.data.batch, req.user, req.ip);
    if (out.expired) {
      flash(req, req.t('undo.gone', { m: UNDO_MINUTES }), 'warn');
      return res.redirect(back);
    }
    const list = (xs) => xs.map((id) => `#${id}`).join(req.t('common.listSep'));
    const parts = [out.undone.length ? req.t('undo.done', { n: out.undone.length }) : req.t('undo.none')];
    if (out.changed.length) parts.push(req.t('undo.changed', { list: list(out.changed) }));
    flash(req, parts.join(' '), out.undone.length ? 'ok' : 'warn');
    return res.redirect(back);
  });

  // Quick-add row at the bottom of the table: just a title; the rest is painted on afterwards.
  r.post('/tasks/quick', requireAuth, writeLimit, async (req, res) => {
    const back = tableBack(req.body.back);
    const result = parse(quickAddSchema, req.body);
    if (result.errors) {
      const tooLong = String(req.body.title ?? '').trim().length > 200;
      flash(req, req.t(tooLong ? 'table.quickTooLong' : 'table.quickEmpty'), 'warn');
      req.session.flash.focus = 'quick-add';
      return res.redirect(back);
    }
    const task = await createTask({
      title: result.data.title, description: '', status: result.data.status, priority: 'med', due_date: '', labels: [], assignees: [],
    }, req.user, req.ip);
    flash(req, req.t('table.quickAdded', { n: `#${task.id}` }));
    req.session.flash.focus = 'quick-add';
    return res.redirect(back);
  });

  // Home composer: "what are you working on?" The task starts In progress and
  // assigned to you; Home then offers the table's buttons to add details.
  r.post('/tasks/mine', requireAuth, writeLimit, async (req, res) => {
    const result = parse(mineSchema, req.body);
    if (result.errors) {
      const typed = String(req.body.title ?? '');
      flash(req, req.t(typed.trim().length > 200 ? 'table.quickTooLong' : 'table.quickEmpty'), 'warn');
      req.session.flash.draft = typed.slice(0, 1000);
      return res.redirect('/home');
    }
    const task = await createTask({
      title: result.data.title, description: '', status: 'progress', priority: 'med', due_date: '', labels: [], assignees: [req.user.id],
    }, req.user, req.ip);
    let text = req.t('home.added', { n: `#${task.id}` });
    const [count, limit] = await Promise.all([inProgressCount(), getWipLimit(config.wipLimit)]);
    if (count > limit) text += ` ${req.t('table.result.overWip', { n: count, limit })}`;
    flash(req, text, count > limit ? 'warn' : 'ok');
    return res.redirect(`/home?added=${task.id}`);
  });

  // Home details sheet after the composer: status, priority, labels, people and due
  // date, chosen first and saved together. Needs the usual edit rights.
  r.post('/tasks/:id/details', requireAuth, writeLimit, async (req, res) => {
    const task = await loadTask(req);
    if (!canEdit(req.user, task)) throw new HttpError(403, 'not allowed');
    const n = `#${task.id}`;
    if (task.closed_at) {
      flash(req, req.t('details.closed', { n }), 'warn');
      return res.redirect('/home');
    }
    const result = parse(detailsSchema, req.body);
    if (result.errors) {
      flash(req, req.t(result.errors.due_date ? 'details.pickDate' : 'details.invalid'), 'warn');
      return res.redirect(`/home?added=${task.id}`);
    }
    const d = result.data;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const due = { none: '', today, tomorrow: tomorrow.toISOString().slice(0, 10), date: d.due_date }[d.due_when];
    let out;
    try {
      out = await saveDetails(task.id, {
        status: d.status === 'done' ? null : d.status,
        priority: d.priority,
        labels: d.labels,
        assignees: d.add_assignee ? [...d.assignees, d.add_assignee] : d.assignees,
        due_date: due,
      }, req.user, req.ip);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        flash(req, req.t('details.closed', { n }), 'warn');
        return res.redirect('/home');
      }
      throw err;
    }
    // Done goes through the close page, so someone is credited, as everywhere else.
    if (d.status === 'done') {
      if (out.changed) flash(req, req.t('details.saved', { n }));
      return res.redirect(`/table/close?ids=${task.id}&back=%2Fhome`);
    }
    if (out.changed) flash(req, req.t('details.saved', { n }), 'ok', out.batch);
    else flash(req, req.t('task.noChanges'));
    return res.redirect('/home');
  });

  // Join a task from Home: adds you as an assignee. Anyone can join any open task.
  r.post('/tasks/:id/join', requireAuth, writeLimit, async (req, res) => {
    const id = taskId(req);
    const back = tableBack(req.body.back);
    const home = back.startsWith('/table') ? '/home' : back;
    let out;
    try {
      out = await joinTask(id, req.user, req.ip);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        flash(req, req.t('join.closed', { n: `#${id}` }), 'warn');
        return res.redirect(home);
      }
      throw err;
    }
    if (out.joined) flash(req, req.t('join.done', { n: `#${id}` }), 'ok', out.batch);
    else flash(req, req.t('join.already', { n: `#${id}` }), 'warn');
    return res.redirect(home);
  });

  // Admins set the in-progress limit. Going over it only warns; nothing is blocked.
  r.post('/board/wip-limit', requireAuth, requireAdmin, writeLimit, async (req, res) => {
    const back = req.body.back === 'table' ? '/table' : '/board';
    const result = parse(wipLimitSchema, req.body);
    if (result.errors) {
      flash(req, req.t('board.wipInvalid'), 'warn');
      return res.redirect(back);
    }
    const { changed } = await setWipLimit(result.data.limit, config.wipLimit, req.user, req.ip);
    flash(req, changed ? req.t('board.wipSaved', { n: result.data.limit }) : req.t('task.noChanges'));
    return res.redirect(back);
  });

  r.get('/tasks/new', requireAuth, async (req, res) => {
    const [labels, people] = await Promise.all([allLabels(), activePeople()]);
    res.render('tasks/form.njk', {
      mode: 'new', labels, people, errors: {},
      values: { title: '', description: '', status: req.query.status === 'backlog' ? 'backlog' : 'todo', priority: 'med', due_date: '', labels: [], assignees: [] },
    });
  });

  r.post('/tasks', requireAuth, writeLimit, ...uploadThenCsrf(MAX_ATTACHMENT_BYTES), async (req, res) => {
    const result = parse(newTaskSchema, req.body);
    let file = null;
    let fileError = null;
    try {
      file = await checkAttachment(req.file);
    } catch {
      fileError = req.t('file.badType');
    }
    if (result.errors || fileError) {
      const [labels, people] = await Promise.all([allLabels(), activePeople()]);
      const errors = { ...(result.errors || {}) };
      if (fileError) errors.file = fileError;
      return res.status(400).render('tasks/form.njk', { mode: 'new', labels, people, errors, values: formValues(req.body) });
    }
    const task = await createTask(result.data, req.user, req.ip, file);
    flash(req, req.t('task.created', { n: `#${task.id}` }));
    res.redirect(`/tasks/${task.id}`);
  });

  r.get('/tasks/:id', requireAuth, async (req, res) => {
    const detail = await taskDetail(taskId(req));
    if (!detail) throw new HttpError(404, 'not found');
    const [labels, people] = await Promise.all([allLabels(), allPeopleNames()]);
    const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
    const labelNames = Object.fromEntries(labels.map((l) => [l.id, req.lang === 'ar' ? l.name_ar : l.name_en]));
    const timeline = [
      ...detail.comments.map((c) => ({ kind: 'comment', at: c.created_at, id: `c${c.id}`, actorId: c.author_id, actorName: c.author_name, body: c.body })),
      ...detail.events.filter((e) => e.action !== 'task.created').map((e) => ({
        kind: 'event', at: e.at, id: `e${e.id}`, actorId: e.actor_id, actorName: e.actor_name || req.t('common.system'),
        action: e.action, text: describe(e, req.t, { names, labels: labelNames }), reason: e.details?.reason,
      })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at) || a.id.localeCompare(b.id));
    const { task } = detail;
    res.render('tasks/show.njk', {
      task,
      timeline,
      files: detail.files,
      openFlags: detail.flags.filter((f) => !f.resolved_at),
      canEdit: canEdit(req.user, task),
      canResolve: canResolveFlags(req.user, task),
      closeOpen: req.query.close === '1',
      today: new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date()),
    });
  });

  r.get('/tasks/:id/edit', requireAuth, async (req, res) => {
    const task = await loadTask(req);
    if (!canEdit(req.user, task)) throw new HttpError(403, 'not allowed');
    const [labels, people] = await Promise.all([allLabels(), activePeople()]);
    // Keep currently assigned people visible even if their account was disabled.
    for (const a of task.assignees) if (!people.some((p) => p.id === a.id)) people.push({ id: a.id, name: a.name });
    res.render('tasks/form.njk', {
      mode: 'edit', task, labels, people, errors: {},
      values: {
        title: task.title, description: task.description, priority: task.priority, due_date: task.due_date || '',
        labels: task.labels.map((l) => String(l.id)), assignees: task.assignees.map((a) => a.id),
      },
    });
  });

  r.post('/tasks/:id/edit', requireAuth, writeLimit, async (req, res) => {
    const task = await loadTask(req);
    if (!canEdit(req.user, task)) throw new HttpError(403, 'not allowed');
    const result = parse(editTaskSchema, req.body);
    if (result.errors) {
      const [labels, people] = await Promise.all([allLabels(), activePeople()]);
      return res.status(400).render('tasks/form.njk', { mode: 'edit', task, labels, people, errors: result.errors, values: formValues(req.body) });
    }
    const { changed } = await updateTask(task.id, result.data, req.user, req.ip);
    flash(req, changed ? req.t('task.saved') : req.t('task.noChanges'));
    res.redirect(`/tasks/${task.id}`);
  });

  // Used by the board's drag-and-drop (JSON) and the task page's status menu (form).
  r.post('/tasks/:id/move', requireAuth, writeLimit, async (req, res) => {
    const id = taskId(req);
    const json = req.is('application/json');
    if (req.body.status === 'done') {
      if (json) return res.json({ ok: true, redirect: `/tasks/${id}/close` });
      return res.redirect(`/tasks/${id}/close`);
    }
    const result = parse(moveSchema, req.body);
    if (result.errors) throw new HttpError(400, 'bad status');
    await moveTask(id, result.data.status, req.user, req.ip);
    if (json) return res.json({ ok: true });
    flash(req, req.t('task.moved', { n: `#${id}`, s: req.t(`status.${result.data.status}`) }));
    res.redirect(`/tasks/${id}`);
  });

  r.get('/tasks/:id/close', requireAuth, async (req, res) => {
    const task = await loadTask(req);
    if (task.closed_at) return res.redirect(`/tasks/${task.id}`);
    const people = await activePeople();
    const defaults = task.assignees.filter((a) => people.some((p) => p.id === a.id)).map((a) => a.id);
    res.render('tasks/close.njk', { task, people, values: { reason: 'completed', credited: defaults.length ? defaults : [req.user.id], duplicate_of: '' }, errors: {} });
  });

  r.post('/tasks/:id/close', requireAuth, writeLimit, async (req, res) => {
    const task = await loadTask(req);
    if (task.closed_at) return res.redirect(`/tasks/${task.id}`);
    const result = parse(closeSchema, req.body);
    const again = async (errors) => {
      const people = await activePeople();
      const values = { reason: String(req.body.reason || 'completed'), credited: [].concat(req.body.credited || []), duplicate_of: String(req.body.duplicate_of || '').slice(0, 12) };
      return res.status(400).render('tasks/close.njk', { task, people, values, errors });
    };
    if (result.errors) return again(result.errors);
    try {
      const { credits } = await closeTask(task.id, {
        reason: result.data.reason, credited: result.data.credited, duplicateOf: result.data.duplicate_of ? Number(result.data.duplicate_of) : null,
      }, req.user, req.ip);
      const people = await allPeopleNames();
      const names = credits.map((id) => people.find((p) => p.id === id)?.name).filter(Boolean).join(req.t('common.listSep'));
      flash(req, names ? req.t('task.closedCredit', { n: `#${task.id}`, people: names }) : req.t('task.closed', { n: `#${task.id}` }));
      res.redirect(`/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        const key = err.message === 'credit required' ? { credited: req.t('close.needOne') } : { duplicate_of: req.t('close.badDuplicate') };
        return again(key);
      }
      throw err;
    }
  });

  r.post('/tasks/:id/reopen', requireAuth, writeLimit, async (req, res) => {
    const id = taskId(req);
    await reopenTask(id, req.user, req.ip);
    flash(req, req.t('task.reopened', { n: `#${id}` }));
    res.redirect(`/tasks/${id}`);
  });

  r.post('/tasks/:id/comments', requireAuth, writeLimit, async (req, res) => {
    const id = taskId(req);
    const result = parse(commentSchema, req.body);
    if (result.errors) {
      flash(req, req.t('comment.empty'), 'warn');
      return res.redirect(`/tasks/${id}#comment`);
    }
    await addComment(id, result.data.body, req.user, req.ip);
    res.redirect(`/tasks/${id}#comment`);
  });

  r.post('/tasks/:id/attachments', requireAuth, writeLimit, ...uploadThenCsrf(MAX_ATTACHMENT_BYTES), async (req, res) => {
    const id = taskId(req);
    let file;
    try {
      file = await checkAttachment(req.file);
    } catch {
      flash(req, req.t('file.badType'), 'warn');
      return res.redirect(`/tasks/${id}`);
    }
    if (!file) {
      flash(req, req.t('file.none'), 'warn');
      return res.redirect(`/tasks/${id}`);
    }
    try {
      await addAttachment(id, file, req.user, req.ip);
      flash(req, req.t('file.added', { f: file.filename }));
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
      flash(req, req.t('file.tooMany'), 'warn');
    }
    res.redirect(`/tasks/${id}`);
  });

  // Files are always downloaded, never rendered in the page.
  r.get('/attachments/:fileId', requireAuth, async (req, res) => {
    const fileId = uuidParam(req.params.fileId);
    const file = fileId ? await getAttachment(fileId) : null;
    if (!file) throw new HttpError(404, 'not found');
    const ascii = file.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.data.length));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(file.data);
  });

  r.post('/tasks/:id/attachments/:fileId/remove', requireAuth, writeLimit, async (req, res) => {
    const id = taskId(req);
    const fileId = uuidParam(req.params.fileId);
    if (!fileId) throw new HttpError(404, 'not found');
    await removeAttachment(fileId, id, req.user, req.ip);
    flash(req, req.t('file.removed'));
    res.redirect(`/tasks/${id}`);
  });

  r.get('/tasks/:id/flag', requireAuth, async (req, res) => {
    const task = await loadTask(req);
    res.render('tasks/flag.njk', { task, values: { reason: 'wrong', note: '' }, errors: {} });
  });

  r.post('/tasks/:id/flag', requireAuth, writeLimit, async (req, res) => {
    const task = await loadTask(req);
    const result = parse(flagSchema, req.body);
    if (result.errors) {
      return res.status(400).render('tasks/flag.njk', {
        task, values: { reason: String(req.body.reason || 'wrong'), note: String(req.body.note || '').slice(0, 1000) }, errors: result.errors,
      });
    }
    await flagTask(task.id, result.data, req.user, req.ip);
    flash(req, req.t('flag.sent'));
    res.redirect(`/tasks/${task.id}`);
  });

  r.post('/tasks/:id/flags/:flagId/resolve', requireAuth, writeLimit, async (req, res) => {
    const id = taskId(req);
    const flagId = idParam(req.params.flagId);
    if (!flagId) throw new HttpError(404, 'not found');
    const resolution = req.body.resolution === 'fixed' ? 'fixed' : 'dismissed';
    await resolveFlag(id, flagId, resolution, req.user, req.ip);
    flash(req, req.t('flag.resolved'));
    res.redirect(`/tasks/${id}`);
  });

  return r;
}

// Table actions only ever return to the table.
// Where table actions (and the same actions on Home) return to: the table, with
// its filters, Home, or the full list of suggested tasks. Anything else goes back to the table.
function tableBack(value) {
  const path = safeLocalPath(value, '/table');
  return /^\/table(\?|$)/.test(path) || /^\/(home|suggested(\?page=\d{1,4})?)$/.test(path) ? path : '/table';
}

// "Tasks updated: 3. Bug added. Skipped (you can't edit them): #12, #15."
async function bulkMessage(req, op, value, { updated, skipped, toggled }) {
  const t = req.t;
  const list = (ids) => ids.map((id) => `#${id}`).join(t('common.listSep'));
  const parts = [updated.length ? t('table.result.updated', { n: updated.length }) : t('table.result.none')];
  // One task moved (the usual case on Home): say where it went.
  if (op === 'status' && updated.length === 1) parts[0] = t('table.result.movedOne', { n: `#${updated[0]}`, status: t(`status.${value}`) });
  if (updated.length && toggled) {
    let name = '';
    if (op === 'label') {
      const label = (await allLabels()).find((l) => l.id === Number(value));
      name = label ? (req.lang === 'ar' ? label.name_ar : label.name_en) : '';
    } else {
      name = (await allPeopleNames()).find((p) => p.id === value)?.name || '';
    }
    parts.push(t(`table.result.${op}.${toggled}`, { name }));
  }
  if (skipped.locked.length) parts.push(t('table.result.locked', { list: list(skipped.locked) }));
  if (skipped.closed.length) parts.push(t('table.result.closed', { list: list(skipped.closed) }));
  if (skipped.missing.length) parts.push(t('table.result.missing', { list: list(skipped.missing) }));
  return parts.join(' ');
}

function formValues(body) {
  const arr = (v) => (v === undefined ? [] : [].concat(v).map(String));
  return {
    title: String(body.title || '').slice(0, 200),
    description: String(body.description || '').slice(0, 10000),
    status: body.status === 'backlog' ? 'backlog' : 'todo',
    priority: ['high', 'med', 'low'].includes(body.priority) ? body.priority : 'med',
    due_date: String(body.due_date || '').slice(0, 10),
    labels: arr(body.labels),
    assignees: arr(body.assignees),
  };
}
