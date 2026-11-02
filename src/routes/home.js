import express from 'express';
import { requireAuth } from '../auth.js';
import { q } from '../db.js';
import { SUGGESTED_PAGE, canEdit, getTask, myTasks, suggestedTasks } from '../services/tasks.js';
import { activePeople } from '../services/users.js';
import { idParam } from '../validation.js';

// After the composer adds a task, Home offers its details buttons: only for an
// open task this person created and can still edit.
async function addedTask(req) {
  const id = idParam(req.query.added);
  if (!id) return null;
  const task = await getTask(id);
  if (!task || task.closed_at || task.creator_id !== req.user.id || !canEdit(req.user, task)) return null;
  return task;
}

// Every label, marked if the task has it, for the label buttons.
async function labelsFor(task) {
  const on = new Set(task.labels.map((l) => l.id));
  const { rows } = await q('SELECT id, name_en, name_ar, color FROM labels ORDER BY id');
  return rows.map((l) => ({ ...l, on: on.has(l.id) }));
}

// The phone-first start page and the menu behind the "Mahamm" tab.
export default function homeRoutes(config) {
  const r = express.Router();

  r.get('/home', requireAuth, async (req, res) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    const [mine, suggested, added] = await Promise.all([
      myTasks(req.user.id), suggestedTasks(req.user.id, { limit: 5 }), addedTask(req),
    ]);
    res.render('home.njk', {
      mine,
      suggested,
      added,
      labels: added ? await labelsFor(added) : [],
      // People who could be added: active, and not on the task already.
      others: added ? (await activePeople()).filter((p) => !added.assignees.some((a) => a.id === p.id)) : [],
      today,
      overdue: mine.filter((t) => t.due_date && t.due_date < today).length,
      firstName: String(req.user.name || '').trim().split(/\s+/)[0],
    });
  });

  // Every suggested task, a page at a time, in the same order as on Home.
  r.get('/suggested', requireAuth, async (req, res) => {
    const page = Math.min(idParam(req.query.page) || 1, 10000);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    const suggested = await suggestedTasks(req.user.id, { limit: SUGGESTED_PAGE, offset: (page - 1) * SUGGESTED_PAGE });
    const pages = Math.max(1, Math.ceil(suggested.total / SUGGESTED_PAGE));
    const url = (n) => (n > 1 ? `/suggested?page=${n}` : '/suggested');
    res.render('suggested.njk', {
      suggested, today, page, pages,
      back: url(page),
      prevUrl: page > 1 ? url(page - 1) : null,
      nextUrl: page < pages ? url(page + 1) : null,
    });
  });

  r.get('/mahamm', requireAuth, (req, res) => {
    res.render('mahamm.njk');
  });

  return r;
}
