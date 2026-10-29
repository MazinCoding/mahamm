import express from 'express';
import { audit } from '../audit.js';
import { destroySession, startPendingSession, startSession } from '../auth.js';
import { decryptField, hashRecoveryCode, hashToken, safeEqual } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { LANGS, translator } from '../i18n.js';
import { composeEmail, mailEnabled, sendNow } from '../mail.js';
import { equaliseTiming, hashPassword, needsRehash, passwordProblem, verifyPassword, MAX_LENGTH } from '../passwords.js';
import { clear, enforce, hit, peek, RateLimited } from '../ratelimit.js';
import { safeLocalPath } from '../security.js';
import { verifyTotp } from '../totp.js';
import { acceptInvite, completeReset, createReset, findInvite, findReset, userCount } from '../services/users.js';
import { HttpError } from '../services/tasks.js';
import { cleanLine, emailField, nameField, parse } from '../validation.js';

const MAX_FAILS = 5;
const FAIL_WINDOW = 15 * 60;

const readEmail = (v) => cleanLine(v).toLowerCase().slice(0, 254);
const readPassword = (v) => String(v ?? '').slice(0, MAX_LENGTH + 1);

export default function authRoutes(config) {
  const r = express.Router();

  r.get('/login', async (req, res) => {
    if (req.user) return res.redirect('/board');
    if ((await userCount()) === 0) return res.redirect('/setup');
    res.render('auth/login.njk', { next: safeLocalPath(req.query.next, ''), email: '' });
  });

  r.post('/login', async (req, res) => {
    const email = readEmail(req.body.email);
    const password = readPassword(req.body.password);
    const next = safeLocalPath(req.body.next, '');
    const fail = (key, status) => res.status(status).render('auth/login.njk', { next, email, error: req.t(key) });

    await enforce(`login-ip:${req.ip}`, 30, FAIL_WINDOW);
    const failKey = `login-fail:${hashToken(email)}`;
    if ((await peek(failKey)).count >= MAX_FAILS) return fail('auth.paused', 429);

    const user = email
      ? await one('SELECT id, email, name, password_hash, status, totp_enabled, password_changed_at FROM users WHERE email = $1', [email])
      : null;
    let ok = false;
    if (user && user.status === 'active') ok = await verifyPassword(user.password_hash, password);
    else await equaliseTiming(password);

    if (!ok) {
      const { count } = await hit(failKey, FAIL_WINDOW);
      req.log.warn({ event: 'login_failed' }, 'sign-in failed');
      if (count === MAX_FAILS) {
        await audit({ query: q }, { action: 'auth.signin_paused', subjectUserId: user?.id ?? null, details: { email }, ip: req.ip });
      }
      return fail(count >= MAX_FAILS ? 'auth.paused' : 'auth.invalid', count >= MAX_FAILS ? 429 : 401);
    }
    await clear(failKey);
    if (needsRehash(user.password_hash)) {
      await q('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)]);
    }
    if (user.totp_enabled) {
      await startPendingSession(req, user);
      req.session.pendingNext = next;
      return res.redirect('/login/two-factor');
    }
    await startSession(req, user);
    await audit({ query: q }, { actorId: user.id, action: 'auth.signed_in', subjectUserId: user.id, ip: req.ip });
    return res.redirect(next || '/board');
  });

  const pendingUser = (req) => {
    const id = req.session?.pendingUserId;
    if (!id || !req.session.pendingAt || Date.now() - req.session.pendingAt > 10 * 60 * 1000) return null;
    return id;
  };

  r.get('/login/two-factor', (req, res) => {
    if (!pendingUser(req)) return res.redirect('/login');
    res.render('auth/two-factor.njk', {});
  });

  r.post('/login/two-factor', async (req, res) => {
    const userId = pendingUser(req);
    if (!userId) return res.redirect('/login');
    try {
      await enforce(`2fa:${userId}`, 6, FAIL_WINDOW);
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
      await destroySession(req);
      return res.status(429).render('auth/login.njk', { next: '', email: '', error: req.t('auth.paused') });
    }
    const user = await one(
      'SELECT id, email, name, totp_secret_enc, totp_last_step, recovery_codes, password_changed_at FROM users WHERE id = $1 AND status = $2',
      [userId, 'active'],
    );
    if (!user || !user.totp_secret_enc) return res.redirect('/login');
    const code = cleanLine(req.body.code).slice(0, 40);
    let ok = false;
    let usedRecovery = false;
    if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      const step = verifyTotp(decryptField(user.totp_secret_enc), code, user.totp_last_step);
      if (step) {
        const upd = await q('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2 RETURNING id', [user.id, step]);
        ok = upd.rowCount === 1;
      }
    } else if (code) {
      const hashed = hashRecoveryCode(code);
      const upd = await q(
        'UPDATE users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes) RETURNING id',
        [user.id, hashed],
      );
      ok = upd.rowCount === 1;
      usedRecovery = ok;
    }
    if (!ok) return res.status(401).render('auth/two-factor.njk', { error: req.t('auth.badCode') });
    const next = safeLocalPath(req.session.pendingNext, '');
    await startSession(req, user);
    await clear(`2fa:${userId}`);
    if (usedRecovery) await audit({ query: q }, { actorId: user.id, action: 'auth.recovery_code_used', subjectUserId: user.id, ip: req.ip });
    await audit({ query: q }, { actorId: user.id, action: 'auth.signed_in', subjectUserId: user.id, details: { two_factor: true }, ip: req.ip });
    if (usedRecovery) req.session.flash = { type: 'warn', text: req.t('auth.recoveryUsed') };
    return res.redirect(next || '/board');
  });

  r.post('/logout', async (req, res) => {
    await destroySession(req);
    res.clearCookie(config.isProd ? '__Host-mahamm.sid' : 'mahamm.sid', { path: '/', secure: config.isProd, httpOnly: true, sameSite: 'lax' });
    res.redirect('/login');
  });

  r.get('/forgot', (req, res) => res.render('auth/forgot.njk', { sent: false }));

  // Same answer whether or not the email has an account.
  r.post('/forgot', async (req, res) => {
    const email = readEmail(req.body.email);
    await enforce(`forgot-ip:${req.ip}`, 10, 3600);
    if (email) {
      try {
        await enforce(`forgot-email:${hashToken(email)}`, 3, 3600);
        const user = await one(`SELECT id, email, name, lang FROM users WHERE email = $1 AND status = 'active'`, [email]);
        if (user && mailEnabled()) {
          const token = await createReset(user.id, null, 1, req.ip);
          const t = translator(user.lang);
          const { text, html } = composeEmail({
            appName: config.appName,
            lang: user.lang,
            heading: t('email.resetHeading'),
            lines: [t('email.resetBody')],
            buttonText: t('email.resetButton'),
            url: `${config.origin}/reset/${token}`,
            footer: t('email.resetFooter'),
          });
          await sendNow({ to: user.email, subject: t('email.resetSubject', { app: config.appName }), text, html });
        }
      } catch (err) {
        if (!(err instanceof RateLimited)) throw err;
      }
    }
    res.render('auth/forgot.njk', { sent: true });
  });

  r.get('/reset/:token', async (req, res) => {
    const reset = await findReset(req.params.token);
    if (!reset) return res.status(410).render('auth/message.njk', { title: req.t('auth.linkExpiredTitle'), body: req.t('auth.linkExpired') });
    res.render('auth/reset.njk', { token: req.params.token });
  });

  r.post('/reset/:token', async (req, res) => {
    await enforce(`reset-ip:${req.ip}`, 20, 3600);
    const reset = await findReset(req.params.token);
    if (!reset) return res.status(410).render('auth/message.njk', { title: req.t('auth.linkExpiredTitle'), body: req.t('auth.linkExpired') });
    const password = readPassword(req.body.password);
    if (password !== readPassword(req.body.confirm)) {
      return res.status(400).render('auth/reset.njk', { token: req.params.token, error: req.t('password.mismatch') });
    }
    const problem = await passwordProblem(password, { email: reset.email, name: reset.name, breachCheck: config.breachCheck });
    if (problem) return res.status(400).render('auth/reset.njk', { token: req.params.token, error: req.t(problem) });
    await completeReset(req.params.token, password, req.ip);
    await destroySession(req);
    res.render('auth/message.njk', { title: req.t('auth.resetDoneTitle'), body: req.t('auth.resetDone'), link: '/login', linkText: req.t('auth.signIn') });
  });

  r.get('/invite/:token', async (req, res) => {
    const invite = await findInvite(req.params.token);
    if (!invite) return res.status(410).render('auth/message.njk', { title: req.t('auth.linkExpiredTitle'), body: req.t('auth.inviteExpired') });
    res.render('auth/invite.njk', { token: req.params.token, invite, name: '' });
  });

  r.post('/invite/:token', async (req, res) => {
    await enforce(`invite-ip:${req.ip}`, 20, 3600);
    const invite = await findInvite(req.params.token);
    if (!invite) return res.status(410).render('auth/message.njk', { title: req.t('auth.linkExpiredTitle'), body: req.t('auth.inviteExpired') });
    const nameResult = parse(nameField, req.body.name);
    const password = readPassword(req.body.password);
    const again = (error) => res.status(400).render('auth/invite.njk', { token: req.params.token, invite, name: cleanLine(req.body.name).slice(0, 100), error });
    if (nameResult.errors) return again(req.t('auth.nameRequired'));
    if (password !== readPassword(req.body.confirm)) return again(req.t('password.mismatch'));
    const problem = await passwordProblem(password, { email: invite.email, name: nameResult.data, breachCheck: config.breachCheck });
    if (problem) return again(req.t(problem));
    let user;
    try {
      user = await acceptInvite(req.params.token, { name: nameResult.data, password }, req.ip);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 409 || err.status === 410)) {
        return res.status(err.status).render('auth/message.njk', { title: req.t('auth.linkExpiredTitle'), body: req.t('auth.inviteExpired') });
      }
      throw err;
    }
    await startSession(req, user);
    await audit({ query: q }, { actorId: user.id, action: 'auth.signed_in', subjectUserId: user.id, ip: req.ip });
    res.redirect(user.role === 'admin' ? '/settings/two-factor' : '/board');
  });

  // First-run setup: only works while there are no users, and only with SETUP_TOKEN.
  r.get('/setup', async (req, res) => {
    if ((await userCount()) > 0) throw new HttpError(404);
    res.render('auth/setup.njk', { enabled: !!config.setupToken, name: '', email: '' });
  });

  r.post('/setup', async (req, res) => {
    await enforce(`setup-ip:${req.ip}`, 10, 3600);
    if ((await userCount()) > 0 || !config.setupToken) throw new HttpError(404);
    const name = cleanLine(req.body.name).slice(0, 100);
    const emailRaw = cleanLine(req.body.email).toLowerCase().slice(0, 254);
    const again = (error, status = 400) => res.status(status).render('auth/setup.njk', { enabled: true, name, email: emailRaw, error });
    if (!safeEqual(hashToken(cleanLine(req.body.setup_token)), hashToken(config.setupToken))) return again(req.t('setup.badToken'), 403);
    const e = parse(emailField, req.body.email);
    const n = parse(nameField, req.body.name);
    if (e.errors || n.errors) return again(req.t('setup.fill'));
    const password = readPassword(req.body.password);
    if (password !== readPassword(req.body.confirm)) return again(req.t('password.mismatch'));
    const problem = await passwordProblem(password, { email: e.data, name: n.data, breachCheck: config.breachCheck });
    if (problem) return again(req.t(problem));
    const hash = await hashPassword(password);
    const user = await tx(async (db) => {
      await db.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const count = await db.query('SELECT count(*)::int AS n FROM users');
      if (count.rows[0].n > 0) throw new HttpError(404);
      const created = (await db.query(
        `INSERT INTO users (email, name, password_hash, role, lang) VALUES ($1, $2, $3, 'admin', $4)
         RETURNING id, email, name, role, password_changed_at`,
        [e.data, n.data, hash, req.lang],
      )).rows[0];
      await audit(db, { actorId: created.id, action: 'setup.completed', subjectUserId: created.id, ip: req.ip });
      return created;
    });
    await startSession(req, user);
    res.redirect('/settings/two-factor');
  });

  r.post('/lang', async (req, res) => {
    const lang = LANGS.includes(req.body.lang) ? req.body.lang : 'en';
    req.session.lang = lang;
    if (req.user) await q('UPDATE users SET lang = $2 WHERE id = $1', [req.user.id, lang]);
    res.redirect(safeLocalPath(req.body.next, '/'));
  });

  return r;
}
