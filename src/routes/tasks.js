import express from 'express';
import { describe } from '../audit.js';
import { requireAuth } from '../auth.js';
import { q } from '../db.js';
import { limiter } from '../ratelimit.js';
import { MAX_ATTACHMENT_BYTES, checkAttachment, uploadThenCsrf } from '../uploads.js';
import {
  HttpError, OPEN_STATUSES, PAGE_SIZE, addAttachment, addComment, boardStats, boardTasks, canEdit, canResolveFlags,
  closeTask, createTask, flagTask, getAttachment, getTask, listTasks, moveTask, removeAttachment, reopenTask, resolveFlag,
  taskDetail, updateTask,
} from '../services/tasks.js';
import { activePeople, allPeopleNames } from '../services/users.js';
import {
  closeSchema, commentSchema, editTaskSchema, flagSchema, idParam, moveSchema, newTaskSchema, parse, uuidParam,
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

const flash = (req, text, type = 'ok') => {
  req.session.flash = { type, text };
};

export default function taskRoutes(config) {
  const r = express.Router();
  const writeLimit = limiter({ name: 'writes', limit: 120, windowSeconds: 60 });

  r.get('/board', requireAuth, async (req, res) => {
    const mine = req.query.mine === '1';
    const [tasks, stats] = await Promise.all([boardTasks({ onlyUserId: mine ? req.user.id : null }), boardStats(config.wipLimit, config.timezone)]);
    const columns = [...OPEN_STATUSES, 'done'].map((key) => ({
      key,
      tasks: tasks.filter((t) => (key === 'done' ? !!t.closed_at : !t.closed_at && t.status === key)),
    }));
    const done = columns.find((c) => c.key === 'done');
    done.tasks.sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    res.render('board.njk', { columns, stats, mine, today, wipLimit: config.wipLimit });
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
