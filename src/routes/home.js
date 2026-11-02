import express from 'express';
import { requireAuth } from '../auth.js';
import { myTasks } from '../services/tasks.js';

// The phone-first start page and the menu behind the "Mahamm" tab.
export default function homeRoutes(config) {
  const r = express.Router();

  r.get('/home', requireAuth, async (req, res) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    const mine = await myTasks(req.user.id);
    res.render('home.njk', {
      mine,
      today,
      overdue: mine.filter((t) => t.due_date && t.due_date < today).length,
      firstName: String(req.user.name || '').trim().split(/\s+/)[0],
    });
  });

  r.get('/mahamm', requireAuth, (req, res) => {
    res.render('mahamm.njk');
  });

  return r;
}
