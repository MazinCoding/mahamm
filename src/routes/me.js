import express from 'express';
import { audit } from '../audit.js';
import { requireAuth, signOutEverywhere, startSession } from '../auth.js';
import { decryptField, encryptField, hashRecoveryCode, newRecoveryCodes } from '../crypto.js';
import { one, q } from '../db.js';
import { hashPassword, passwordProblem, verifyPassword, MAX_LENGTH } from '../passwords.js';
import { enforce } from '../ratelimit.js';
import { newTotpSecret, totpQrDataUrl, verifyTotp } from '../totp.js';
import { HttpError } from '../services/tasks.js';
import { parse, profileSchema } from '../validation.js';

const readPassword = (v) => String(v ?? '').slice(0, MAX_LENGTH + 1);

export default function meRoutes(config) {
  const r = express.Router();

  r.get('/notifications', requireAuth, async (req, res) => {
    const { rows } = await q(
      `SELECT n.id, n.kind, n.task_id, n.created_at, n.read_at, a.name AS actor_name, t.title
       FROM notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN tasks t ON t.id = n.task_id
       WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`,
      [req.user.id],
    );
    res.render('notifications.njk', { items: rows });
  });

  // Opening a notification marks it read; only your own can be opened.
  r.get('/notifications/:id', requireAuth, async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(404, 'not found');
    const n = await one(
      'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING task_id',
      [req.params.id, req.user.id],
    );
    if (!n) throw new HttpError(404, 'not found');
    res.redirect(n.task_id ? `/tasks/${n.task_id}` : '/notifications');
  });

  r.post('/notifications/read-all', requireAuth, async (req, res) => {
    await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
    res.redirect('/notifications');
  });

  r.get('/settings', requireAuth, async (req, res) => {
    const me = await one('SELECT name, email, lang, email_notifications, totp_enabled, cardinality(recovery_codes) AS codes_left FROM users WHERE id = $1', [req.user.id]);
    res.render('settings/index.njk', { me, errors: {} });
  });

  r.post('/settings/profile', requireAuth, async (req, res) => {
    const result = parse(profileSchema, { ...req.body, email_notifications: req.body.email_notifications || 'false' });
    if (result.errors) {
      req.session.flash = { type: 'warn', text: req.t('settings.nameRequired') };
      return res.redirect('/settings');
    }
    await q('UPDATE users SET name = $2, lang = $3, email_notifications = $4 WHERE id = $1',
      [req.user.id, result.data.name, result.data.lang, result.data.email_notifications]);
    req.session.lang = result.data.lang;
    req.session.flash = { type: 'ok', text: req.t('settings.saved') };
    res.redirect('/settings');
  });

  r.post('/settings/password', requireAuth, async (req, res) => {
    await enforce(`pw-change:${req.user.id}`, 10, 3600);
    const current = readPassword(req.body.current);
    const next = readPassword(req.body.password);
    const user = await one('SELECT id, email, name, password_hash, password_changed_at FROM users WHERE id = $1', [req.user.id]);
    const back = (key) => {
      req.session.flash = { type: 'warn', text: req.t(key) };
      return res.redirect('/settings#password');
    };
    if (!(await verifyPassword(user.password_hash, current))) return back('settings.wrongPassword');
    if (next !== readPassword(req.body.confirm)) return back('password.mismatch');
    const problem = await passwordProblem(next, { email: user.email, name: user.name, breachCheck: config.breachCheck });
    if (problem) return back(problem);
    const updated = await one(
      'UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1 RETURNING id, password_changed_at',
      [user.id, await hashPassword(next)],
    );
    await audit({ query: q }, { actorId: user.id, action: 'auth.password_changed', subjectUserId: user.id, ip: req.ip });
    // Every other session ends; this one continues with a fresh id.
    await signOutEverywhere(user.id);
    await startSession(req, updated);
    req.session.flash = { type: 'ok', text: req.t('settings.passwordChanged') };
    res.redirect('/settings');
  });

  r.get('/settings/two-factor', requireAuth, async (req, res) => {
    const me = await one('SELECT email, totp_enabled FROM users WHERE id = $1', [req.user.id]);
    if (me.totp_enabled) return res.redirect('/settings#two-factor');
    // The not-yet-confirmed secret is kept encrypted in the session.
    if (!req.session.pendingTotp) req.session.pendingTotp = encryptField(newTotpSecret());
    const secret = decryptField(req.session.pendingTotp);
    const qr = await totpQrDataUrl(secret, me.email, config.appName);
    res.render('settings/two-factor.njk', { qr, secret: secret.replace(/(.{4})/g, '$1 ').trim(), required: req.user.role === 'admin' });
  });

  r.post('/settings/two-factor', requireAuth, async (req, res) => {
    await enforce(`2fa-setup:${req.user.id}`, 10, 900);
    if (!req.session.pendingTotp) return res.redirect('/settings/two-factor');
    const secret = decryptField(req.session.pendingTotp);
    const step = verifyTotp(secret, req.body.code, 0);
    if (!step) {
      const me = await one('SELECT email FROM users WHERE id = $1', [req.user.id]);
      const qr = await totpQrDataUrl(secret, me.email, config.appName);
      return res.status(400).render('settings/two-factor.njk', {
        qr, secret: secret.replace(/(.{4})/g, '$1 ').trim(), required: req.user.role === 'admin', error: req.t('auth.badCode'),
      });
    }
    const codes = newRecoveryCodes();
    await q(
      'UPDATE users SET totp_secret_enc = $2, totp_enabled = true, totp_last_step = $3, recovery_codes = $4 WHERE id = $1',
      [req.user.id, encryptField(secret), step, codes.map(hashRecoveryCode)],
    );
    delete req.session.pendingTotp;
    await audit({ query: q }, { actorId: req.user.id, action: 'auth.two_factor_enabled', subjectUserId: req.user.id, ip: req.ip });
    // Shown once; only hashes are stored.
    res.render('settings/recovery-codes.njk', { codes });
  });

  r.post('/settings/two-factor/disable', requireAuth, async (req, res) => {
    if (req.user.role === 'admin') throw new HttpError(403, 'admins must keep two-step verification');
    await enforce(`2fa-disable:${req.user.id}`, 6, 900);
    const user = await one('SELECT password_hash, totp_secret_enc, totp_last_step FROM users WHERE id = $1', [req.user.id]);
    const okPassword = await verifyPassword(user.password_hash, readPassword(req.body.password));
    const okCode = user.totp_secret_enc && verifyTotp(decryptField(user.totp_secret_enc), req.body.code, user.totp_last_step);
    if (!okPassword || !okCode) {
      req.session.flash = { type: 'warn', text: req.t('settings.disableFailed') };
      return res.redirect('/settings#two-factor');
    }
    await q(`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = 0, recovery_codes = '{}' WHERE id = $1`, [req.user.id]);
    await audit({ query: q }, { actorId: req.user.id, action: 'auth.two_factor_disabled', subjectUserId: req.user.id, ip: req.ip });
    req.session.flash = { type: 'ok', text: req.t('settings.twoFactorOff') };
    res.redirect('/settings');
  });

  return r;
}
