import express from 'express';
import { requireAuth } from '../auth.js';
import { SUGGESTED_PAGE, myTasks, suggestedTasks } from '../services/tasks.js';
import { idParam } from '../validation.js';

// The phone-first start page and the menu behind the "Mahamm" tab.
export default function homeRoutes(config) {
  const r = express.Router();

  r.get('/home', requireAuth, async (req, res) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    const [mine, suggested] = await Promise.all([myTasks(req.user.id), suggestedTasks(req.user.id, { limit: 5 })]);
    res.render('home.njk', {
      mine,
      suggested,
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
