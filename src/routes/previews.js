import express from 'express';
import { requireAuth } from '../auth.js';
import { limiter } from '../ratelimit.js';
import { localTime } from '../services/connector.js';
import { cancelPreview, confirmPreview, previewFor } from '../services/previews.js';
import { HttpError } from '../services/tasks.js';
import { uuidParam } from '../validation.js';

// Mahamm's own page for confirming a change asked for through a connected app
// (see services/previews.js). Only the person it was made for can see it.

const STATUS_KEY = { backlog: 'backlog', todo: 'todo', in_progress: 'progress', review: 'review' };
const PRIORITY_KEY = { high: 'high', medium: 'med', low: 'low' };
const REASON_KEY = { completed: 'completed', not_needed: 'notneeded', duplicate: 'duplicate', mistake: 'mistake' };

// The summary stored with the preview, as a heading, lines and tasks in the viewer's language.
export function previewView(s, t) {
  const list = (names) => names.join(t('common.listSep'));
  const lines = [];
  let heading = '';
  let tasks = [];
  if (s.kind === 'update') {
    heading = t('preview.update', { count: s.count });
    const c = s.changes || {};
    if (c.status) lines.push(t('preview.status', { value: t(`status.${STATUS_KEY[c.status]}`) }));
    if (c.priority) lines.push(t('preview.priority', { value: t(`priority.${PRIORITY_KEY[c.priority]}`) }));
    if (c.due_date !== undefined) lines.push(t('preview.due', { value: c.due_date || t('preview.noDueDate') }));
    if (c.add_assignees) lines.push(t('preview.addPeople', { names: list(c.add_assignees) }));
    if (c.remove_assignees) lines.push(t('preview.removePeople', { names: list(c.remove_assignees) }));
    if (c.add_labels) lines.push(t('preview.addLabels', { names: list(c.add_labels) }));
    if (c.remove_labels) lines.push(t('preview.removeLabels', { names: list(c.remove_labels) }));
    if (c.team_task !== undefined) lines.push(t(c.team_task ? 'preview.teamOn' : 'preview.teamOff'));
    if (c.title !== undefined) lines.push(t('preview.newTitle', { value: c.title }));
    if (c.description !== undefined) lines.push(t('preview.newDescription'));
    tasks = s.tasks;
  } else if (s.kind === 'close') {
    heading = t('preview.close', { count: s.count });
    lines.push(t('preview.reason', { value: t(`reason.${REASON_KEY[s.reason]}`) }));
    if (s.credit?.length) lines.push(t('preview.credit', { names: list(s.credit) }));
    else if (s.reason === 'completed') lines.push(t('preview.creditAssignees'));
    if (s.duplicate_of) lines.push(t('preview.duplicateOf', { n: `#${s.duplicate_of}` }));
    tasks = s.tasks;
  } else if (s.kind === 'create') {
    heading = t('preview.create', { count: s.count });
    tasks = s.tasks.map((x) => ({
      title: x.title,
      note: [
        t(`status.${STATUS_KEY[x.status]}`),
        t(`priority.${PRIORITY_KEY[x.priority]}`),
        x.assignees.length ? list(x.assignees) : t('preview.unassigned'),
        x.due_date || t('preview.noDueDate'),
      ].join(' · '),
    }));
  } else if (s.action === 'add_person') {
    heading = t('preview.addPerson', { name: s.name });
  } else {
    heading = t('preview.setLimit', { from: s.from, to: s.to });
  }
  return { heading, lines, tasks };
}

export default function previewRoutes(config) {
  const r = express.Router();
  const writeLimit = limiter({ name: 'writes', limit: 120, windowSeconds: 60 });
  const opts = { origin: config.origin, timezone: config.timezone, wipLimit: config.wipLimit };
  const flash = (req, text, type = 'ok') => { req.session.flash = { type, text }; };

  async function load(req) {
    const id = uuidParam(req.params.id);
    const preview = id ? await previewFor(id, req.user) : null;
    if (!preview) throw new HttpError(404, 'not found');
    return preview;
  }

  r.get('/previews/:id', requireAuth, async (req, res) => {
    const p = await load(req);
    const open = !p.used_at && p.live;
    res.render('preview.njk', {
      p,
      view: previewView(p.summary, req.t),
      open,
      gone: open ? null : (p.outcome || 'expired'),
      expires: localTime(p.expires_at, config.timezone).slice(11),
    });
  });

  r.post('/previews/:id/confirm', requireAuth, writeLimit, async (req, res) => {
    const p = await load(req);
    const result = await confirmPreview(p.id, req.user, req.ip, opts, { website: true });
    if (!result.done) return res.redirect(`/previews/${p.id}`);
    if (result.changed === false) flash(req, req.t('preview.nothingChanged'), 'warn');
    else flash(req, req.t('preview.done'));
    res.redirect('/home');
  });

  r.post('/previews/:id/cancel', requireAuth, writeLimit, async (req, res) => {
    const p = await load(req);
    const result = await cancelPreview(p.id, req.user);
    if (!result.cancelled) return res.redirect(`/previews/${p.id}`);
    flash(req, req.t('preview.cancelled'));
    res.redirect('/home');
  });

  return r;
}
