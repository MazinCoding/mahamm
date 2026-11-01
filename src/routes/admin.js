import express from 'express';
import { GROUPS, TASK_ACTIONS, audit, describe, groupOf } from '../audit.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { one, q } from '../db.js';
import { translator } from '../i18n.js';
import { composeEmail, mailEnabled, sendNow } from '../mail.js';
import { enforce } from '../ratelimit.js';
import { MAX_IMPORT_BYTES, uploadThenCsrf } from '../uploads.js';
import { FIELDS, buildPreview, getJob, guessMapping, parseSheet, readMapping, runImport, saveJob } from '../services/import.js';
import { HttpError } from '../services/tasks.js';
import {
  activePeople, addPerson, changeRole, createInvite, createReset, peopleOverview, renamePerson, revokeInvite, setStatus,
} from '../services/users.js';
import { cleanLine, idParam, inviteSchema, labelSchema, parse, personSchema, uuidParam } from '../validation.js';

const AUDIT_PAGE = 100;

// Spreadsheet apps run cells that start with these characters as formulas.
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export default function adminRoutes(config) {
  const r = express.Router();
  const flash = (req, text, type = 'ok') => {
    req.session.flash = { type, text };
  };

  async function auditQuery(req, { limit, offset }) {
    const where = [];
    const params = [];
    const add = (v) => {
      params.push(v);
      return `$${params.length}`;
    };
    // Members see task history; admins also see accounts and security.
    if (req.user.role !== 'admin') where.push(`e.action = ANY(${add(TASK_ACTIONS)})`);
    const who = req.query.who === 'system' ? 'system' : uuidParam(req.query.who);
    if (who === 'system') where.push('e.actor_id IS NULL');
    else if (who) where.push(`e.actor_id = ${add(who)}`);
    const group = Object.keys(GROUPS).includes(req.query.group) ? req.query.group : null;
    if (group && (group !== 'account' || req.user.role === 'admin')) where.push(`e.action = ANY(${add(GROUPS[group])})`);
    const task = idParam(req.query.task);
    if (task) where.push(`e.task_id = ${add(task)}`);
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await one(`SELECT count(*)::int AS n FROM audit_events e ${sql}`, params)).n;
    const rows = (await q(
      `SELECT e.id, e.at, e.action, e.task_id, e.actor_id, e.subject_user_id, e.details, e.ip,
              a.name AS actor_name, a.email AS actor_email, t.title AS task_title
       FROM audit_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN tasks t ON t.id = e.task_id
       ${sql} ORDER BY e.at DESC, e.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    )).rows;
    return { total, rows, who, group, task };
  }

  async function lookups(lang) {
    const people = (await q('SELECT id, name, status FROM users ORDER BY name')).rows;
    const labels = (await q('SELECT id, name_en, name_ar FROM labels')).rows;
    return {
      people,
      names: Object.fromEntries(people.map((p) => [p.id, p.name])),
      labelNames: Object.fromEntries(labels.map((l) => [l.id, lang === 'ar' ? l.name_ar : l.name_en])),
    };
  }

  r.get('/audit', requireAuth, async (req, res) => {
    const page = Math.min(idParam(req.query.page) || 1, 100000);
    const { total, rows, who, group, task } = await auditQuery(req, { limit: AUDIT_PAGE, offset: (page - 1) * AUDIT_PAGE });
    const { people, names, labelNames } = await lookups(req.lang);
    const events = rows.map((e) => {
      let text = describe(e, req.t, { names, labels: labelNames });
      if (e.action === 'task.commented' && e.details?.excerpt) text += `: “${e.details.excerpt}”`;
      return { ...e, text, group: groupOf(e.action) };
    });
    const qs = (p) => {
      const s = new URLSearchParams();
      if (who) s.set('who', who);
      if (group) s.set('group', group);
      if (task) s.set('task', task);
      if (p > 1) s.set('page', p);
      const str = s.toString();
      return str ? `/audit?${str}` : '/audit';
    };
    res.render('audit.njk', {
      events, people, total, who, group, task,
      groups: Object.keys(GROUPS).filter((g) => g !== 'account' || req.user.role === 'admin'),
      prevUrl: page > 1 ? qs(page - 1) : null,
      nextUrl: page * AUDIT_PAGE < total ? qs(page + 1) : null,
      exportUrl: `/audit.csv${qs(1).replace('/audit', '')}`,
    });
  });

  r.get('/audit.csv', requireAuth, requireAdmin, async (req, res) => {
    await enforce(`audit-export:${req.user.id}`, 10, 3600);
    const { rows } = await auditQuery(req, { limit: 50000, offset: 0 });
    const t = translator('en');
    const { names, labelNames } = await lookups('en');
    const lines = [['time_utc', 'actor', 'actor_email', 'action', 'task_id', 'task_title', 'details', 'ip'].map(csvCell).join(',')];
    for (const e of rows) {
      lines.push([
        new Date(e.at).toISOString(), e.actor_name || 'System', e.actor_email || '', e.action, e.task_id ?? '', e.task_title || '',
        describe(e, t, { names, labels: labelNames }), e.ip || '',
      ].map(csvCell).join(','));
    }
    await audit({ query: q }, { actorId: req.user.id, action: 'audit.exported', details: { rows: rows.length }, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  const peoplePage = async (req, res, status = 200, extra = {}) => {
    const { users, invites } = await peopleOverview();
    res.status(status).render('people.njk', {
      users, invites, mail: mailEnabled(), values: { email: '', role: 'member', name: '' }, errors: {}, ...extra,
    });
  };

  r.get('/people', requireAuth, requireAdmin, async (req, res) => peoplePage(req, res));

  // Sends an invite, optionally tied to a person without an account, and shows the link once.
  async function sendInvite(req, res, { email, role, userId = null, onConflict }) {
    let created;
    try {
      created = await createInvite(email, role, req.user, req.ip, userId);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return onConflict(err.message);
      throw err;
    }
    const link = `${config.origin}/invite/${created.token}`;
    let emailed = false;
    if (mailEnabled()) {
      const t = translator(req.lang);
      const { text, html } = composeEmail({
        appName: config.appName,
        lang: req.lang,
        heading: t('email.inviteHeading', { app: config.appName }),
        lines: [t('email.inviteBody', { who: req.user.name, role: t(`role.${role}`) })],
        buttonText: t('email.inviteButton'),
        url: link,
        footer: t('email.inviteFooter'),
      });
      emailed = await sendNow({ to: email, subject: t('email.inviteSubject', { who: req.user.name, app: config.appName }), text, html });
    }
    // The link is shown once, to the admin who made it.
    return res.render('link-once.njk', {
      title: req.t('people.inviteCreated'),
      body: emailed ? req.t('people.inviteEmailed', { email }) : req.t('people.inviteNotEmailed', { email }),
      link,
    });
  }

  const inviteConflict = (req, res) => (reason) => {
    const map = { 'already a member': 'people.alreadyMember', 'has account': 'people.hasAccount', 'person disabled': 'people.personDisabled' };
    flash(req, req.t(map[reason] || 'errors.conflict'), 'warn');
    return res.redirect('/people');
  };

  r.post('/people/invite', requireAuth, requireAdmin, async (req, res) => {
    await enforce(`invite-send:${req.user.id}`, 60, 3600);
    const result = parse(inviteSchema, req.body);
    if (result.errors) {
      return peoplePage(req, res, 400, {
        values: { email: String(req.body.email || '').slice(0, 254), role: req.body.role === 'admin' ? 'admin' : 'member', name: '' },
        errors: { email: req.t('people.badEmail') },
      });
    }
    return sendInvite(req, res, { ...result.data, onConflict: inviteConflict(req, res) });
  });

  // People without accounts: added by name, assignable and creditable straight away.
  r.post('/people/add', requireAuth, requireAdmin, async (req, res) => {
    await enforce(`person-add:${req.user.id}`, 200, 3600);
    const result = parse(personSchema, req.body);
    if (result.errors) {
      return peoplePage(req, res, 400, { values: { email: '', role: 'member', name: cleanLine(req.body.name).slice(0, 100) }, errors: { name: req.t('people.badName') } });
    }
    try {
      const person = await addPerson(result.data.name, req.user, req.ip);
      flash(req, req.t('people.added', { name: person.name }));
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      return peoplePage(req, res, 409, { values: { email: '', role: 'member', name: result.data.name }, errors: { name: req.t('people.nameTaken') } });
    }
    res.redirect('/people');
  });

  r.post('/people/:id/rename', requireAuth, requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    if (!id) throw new HttpError(404, 'not found');
    await enforce(`person-rename:${req.user.id}`, 200, 3600);
    const result = parse(personSchema, req.body);
    if (result.errors) {
      flash(req, req.t('people.badName'), 'warn');
      return res.redirect('/people');
    }
    try {
      await renamePerson(id, result.data.name, req.user, req.ip);
      flash(req, req.t('people.renamed'));
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err;
      flash(req, req.t(err.message === 'name taken' ? 'people.nameTaken' : 'people.hasAccount'), 'warn');
    }
    res.redirect('/people');
  });

  r.post('/people/:id/invite', requireAuth, requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    if (!id) throw new HttpError(404, 'not found');
    await enforce(`invite-send:${req.user.id}`, 60, 3600);
    const result = parse(inviteSchema, req.body);
    if (result.errors) {
      flash(req, req.t('people.badEmail'), 'warn');
      return res.redirect('/people');
    }
    return sendInvite(req, res, { ...result.data, userId: id, onConflict: inviteConflict(req, res) });
  });

  r.post('/people/invites/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    if (!id) throw new HttpError(404, 'not found');
    await revokeInvite(id, req.user, req.ip);
    flash(req, req.t('people.inviteRevoked'));
    res.redirect('/people');
  });

  const guarded = async (req, fn) => {
    try {
      await fn();
      return null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        const map = {
          'last admin': 'people.lastAdmin', 'cannot change own role': 'people.notYourself',
          'cannot disable yourself': 'people.notYourself', 'has no account': 'people.noAccountRole', 'name taken': 'people.nameTakenEnable',
        };
        return req.t(map[err.message] || 'errors.conflict');
      }
      throw err;
    }
  };

  r.post('/people/:id/role', requireAuth, requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    if (!id) throw new HttpError(404, 'not found');
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const problem = await guarded(req, () => changeRole(id, role, req.user, req.ip));
    flash(req, problem || req.t('people.roleChanged'), problem ? 'warn' : 'ok');
    res.redirect('/people');
  });

  r.post('/people/:id/status', requireAuth, requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    if (!id) throw new HttpError(404, 'not found');
    const status = req.body.status === 'disabled' ? 'disabled' : 'active';
    const problem = await guarded(req, () => setStatus(id, status, req.user, req.ip));
    flash(req, problem || req.t(status === 'disabled' ? 'people.disabled' : 'people.enabled'), problem ? 'warn' : 'ok');
    res.redirect('/people');
  });

  r.post('/people/:id/reset-link', requireAuth, requireAdmin, async (req, res) => {
    const id = uuidParam(req.params.id);
    const target = id ? await one(`SELECT id, name FROM users WHERE id = $1 AND status = 'active' AND email IS NOT NULL`, [id]) : null;
    if (!target) throw new HttpError(404, 'not found');
    await enforce(`reset-link:${req.user.id}`, 20, 3600);
    const token = await createReset(target.id, req.user.id, 24, req.ip);
    res.render('link-once.njk', {
      title: req.t('people.resetCreated'),
      body: req.t('people.resetBody', { name: target.name }),
      link: `${config.origin}/reset/${token}`,
    });
  });

  r.get('/labels', requireAuth, requireAdmin, async (req, res) => {
    const labels = (await q('SELECT l.*, (SELECT count(*)::int FROM task_labels tl WHERE tl.label_id = l.id) AS used FROM labels l ORDER BY l.id')).rows;
    res.render('labels.njk', { labels, errors: {} });
  });

  r.post('/labels', requireAuth, requireAdmin, async (req, res) => {
    const result = parse(labelSchema, req.body);
    if (result.errors) {
      flash(req, req.t('labels.invalid'), 'warn');
      return res.redirect('/labels');
    }
    const count = (await one('SELECT count(*)::int AS n FROM labels')).n;
    if (count >= 60) throw new HttpError(409, 'too many labels');
    const { name_en: en, name_ar: ar, color } = result.data;
    const created = await one('INSERT INTO labels (name_en, name_ar, color) VALUES ($1, $2, $3) RETURNING id', [en, ar, color]);
    await audit({ query: q }, { actorId: req.user.id, action: 'label.created', details: { label_id: created.id, name: en }, ip: req.ip });
    flash(req, req.t('labels.saved'));
    res.redirect('/labels');
  });

  r.post('/labels/:id', requireAuth, requireAdmin, async (req, res) => {
    const id = idParam(req.params.id);
    const result = parse(labelSchema, req.body);
    if (!id || result.errors) {
      flash(req, req.t('labels.invalid'), 'warn');
      return res.redirect('/labels');
    }
    const { name_en: en, name_ar: ar, color } = result.data;
    const updated = await one('UPDATE labels SET name_en = $2, name_ar = $3, color = $4 WHERE id = $1 RETURNING id', [id, en, ar, color]);
    if (!updated) throw new HttpError(404, 'not found');
    await audit({ query: q }, { actorId: req.user.id, action: 'label.updated', details: { label_id: id, name: en }, ip: req.ip });
    flash(req, req.t('labels.saved'));
    res.redirect('/labels');
  });

  r.get('/import', requireAuth, requireAdmin, async (req, res) => {
    const last = await one(
      `SELECT e.at, e.details, u.name FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.action = 'import.completed' ORDER BY e.at DESC LIMIT 1`,
    );
    res.render('import/upload.njk', { last });
  });

  r.post('/import', requireAuth, requireAdmin, ...uploadThenCsrf(MAX_IMPORT_BYTES), async (req, res) => {
    await enforce(`import:${req.user.id}`, 30, 3600);
    let parsed;
    try {
      parsed = await parseSheet(req.file);
    } catch (err) {
      if (!(err instanceof HttpError)) req.log.warn({ reason: err.message }, 'sheet could not be read');
      flash(req, req.t('import.unreadable'), 'warn');
      return res.redirect('/import');
    }
    const job = await saveJob(req.user.id, req.file.originalname, parsed);
    if (parsed.truncated) flash(req, req.t('import.truncated'), 'warn');
    res.redirect(`/import/${job.id}`);
  });

  async function jobOr404(req) {
    const id = uuidParam(req.params.id);
    const job = id ? await getJob(id, req.user.id) : null;
    if (!job) throw new HttpError(404, 'not found');
    return job;
  }

  r.get('/import/:id', requireAuth, requireAdmin, async (req, res) => {
    const job = await jobOr404(req);
    const mapping = req.query.mapped === '1' ? readMapping(req.query, job.headers) : guessMapping(job.headers);
    const people = await activePeople();
    const preview = mapping.title === undefined ? null : await buildPreview(job, mapping, people);
    const samples = job.headers.map((h, i) => job.rows.find((r) => r[i])?.[i] || '');
    res.render('import/review.njk', { job, mapping, fields: FIELDS, preview, samples, rowCount: job.rows.length });
  });

  r.post('/import/:id/run', requireAuth, requireAdmin, async (req, res) => {
    const job = await jobOr404(req);
    const mapping = readMapping(req.body, job.headers);
    if (mapping.title === undefined) throw new HttpError(400, 'title column required');
    const people = await activePeople();
    const preview = await buildPreview(job, mapping, people);
    const count = await runImport(job, preview, req.user, req.ip, translator(req.lang));
    flash(req, req.t('import.done', { n: count, skipped: preview.rows.length - count }));
    res.redirect('/tasks');
  });

  return r;
}
