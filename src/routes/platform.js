// The platform admin's own pages. Separate accounts and a separate sign-in
// (password + two-step code, always). A platform session never signs anyone in
// to a company, and a company session never opens these pages.
import express from 'express';
import { decryptField, encryptField, hashRecoveryCode, newRecoveryCodes, safeEqual } from '../crypto.js';
import { q } from '../db.js';
import { equaliseTiming, hashPassword, passwordProblem, verifyPassword, MAX_LENGTH } from '../passwords.js';
import { clear, enforce, hit, peek } from '../ratelimit.js';
import { newTotpSecret, totpQrDataUrl, verifyTotp } from '../totp.js';
import {
  PLANS, STATUS_ACTIONS, createFirstPlatformAdmin, findPlatformAdmin, findPlatformAdminByEmail, getCompany, listCompanies,
  platformAdminCount, platformAudit, renameCompany, setCompanyPlan, setCompanyStatus,
} from '../services/platform.js';
import { HttpError } from '../services/tasks.js';
import { cleanLine, emailField, nameField, parse, uuidParam } from '../validation.js';

const SESSION_MS = 12 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;
const FAIL_WINDOW = 15 * 60;
const MAX_FAILS = 5;

const readEmail = (v) => cleanLine(v).toLowerCase().slice(0, 254);
const readPassword = (v) => String(v ?? '').slice(0, MAX_LENGTH + 1);

// A new session id on every change of who is signed in, keeping whatever else
// the session holds (a company sign-in in the same browser stays as it was).
function renewSession(req) {
  const keep = { ...req.session };
  delete keep.cookie;
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, keep);
      return resolve();
    });
  });
}

function clearPlatformSession(req) {
  for (const key of ['platformAdminId', 'platformAt', 'platformPwv', 'platformPendingId', 'platformPendingAt', 'platformEnrolId', 'platformTotp']) {
    delete req.session[key];
  }
}

async function signInPlatform(req, admin) {
  clearPlatformSession(req);
  await renewSession(req);
  req.session.platformAdminId = admin.id;
  req.session.platformAt = Date.now();
  req.session.platformPwv = new Date(admin.password_changed_at).toISOString();
}

// The signed-in platform admin, or null.
async function currentAdmin(req) {
  const id = req.session?.platformAdminId;
  if (!id) return null;
  const admin = await findPlatformAdmin(id);
  const fresh = admin && admin.status === 'active' && admin.totp_enabled
    && Date.now() - req.session.platformAt < SESSION_MS
    && req.session.platformPwv === new Date(admin.password_changed_at).toISOString();
  if (!fresh) {
    clearPlatformSession(req);
    return null;
  }
  return admin;
}

const pendingId = (req, key) => {
  const id = req.session?.[key];
  if (!id || !req.session.platformPendingAt || Date.now() - req.session.platformPendingAt > PENDING_MS) return null;
  return id;
};

export default function platformRoutes(config) {
  const r = express.Router();

  const requirePlatform = async (req, res, next) => {
    const admin = await currentAdmin(req);
    if (!admin) return res.redirect('/platform/login');
    req.platformAdmin = admin;
    res.locals.platformAdmin = { name: admin.name };
    return next();
  };

  // --- First platform admin -------------------------------------------------

  r.get('/platform/setup', async (req, res) => {
    if ((await platformAdminCount()) > 0) throw new HttpError(404, 'not found');
    res.render('platform/setup.njk', { enabled: !!config.platformSetupToken, name: '', email: '' });
  });

  r.post('/platform/setup', async (req, res) => {
    if ((await platformAdminCount()) > 0 || !config.platformSetupToken) throw new HttpError(404, 'not found');
    await enforce(`platform-setup:${req.ip}`, 10, FAIL_WINDOW);
    const name = cleanLine(req.body.name).slice(0, 100);
    const email = readEmail(req.body.email);
    const again = (key, status = 400) => res.status(status).render('platform/setup.njk', { enabled: true, name, email, error: req.t(key) });
    if (!safeEqual(String(req.body.setup_token ?? ''), config.platformSetupToken)) return again('setup.badToken', 403);
    const n = parse(nameField, name);
    const e = parse(emailField, email);
    if (n.errors || e.errors) return again('platform.badDetails');
    const password = readPassword(req.body.password);
    if (password !== readPassword(req.body.confirm)) return again('settings.mismatch');
    const problem = await passwordProblem(password, { email: e.data, name: n.data, breachCheck: true });
    if (problem) return again(problem);
    const admin = await createFirstPlatformAdmin({ email: e.data, name: n.data, passwordHash: await hashPassword(password), ip: req.ip });
    await renewSession(req);
    req.session.platformEnrolId = admin.id;
    req.session.platformPendingAt = Date.now();
    res.redirect('/platform/two-step');
  });

  // --- Two-step set-up (required before anything else) -----------------------

  const enrolling = async (req) => {
    const id = pendingId(req, 'platformEnrolId');
    const admin = id ? await findPlatformAdmin(id) : null;
    return admin && !admin.totp_enabled && admin.status === 'active' ? admin : null;
  };

  const twoStepPage = async (req, res, admin, status = 200, error = null) => {
    if (!req.session.platformTotp) req.session.platformTotp = encryptField(newTotpSecret());
    const secret = decryptField(req.session.platformTotp);
    const qr = await totpQrDataUrl(secret, admin.email, `${config.appName} platform`);
    res.status(status).render('platform/two-step.njk', { qr, secret: secret.replace(/(.{4})/g, '$1 ').trim(), error });
  };

  r.get('/platform/two-step', async (req, res) => {
    const admin = await enrolling(req);
    if (!admin) return res.redirect('/platform/login');
    await twoStepPage(req, res, admin);
  });

  r.post('/platform/two-step', async (req, res) => {
    const admin = await enrolling(req);
    if (!admin || !req.session.platformTotp) return res.redirect('/platform/login');
    await enforce(`platform-2fa-setup:${admin.id}`, 10, FAIL_WINDOW);
    const secret = decryptField(req.session.platformTotp);
    const step = verifyTotp(secret, req.body.code, 0);
    if (!step) return twoStepPage(req, res, admin, 400, req.t('auth.badCode'));
    const codes = newRecoveryCodes();
    await q(
      'UPDATE platform_admins SET totp_secret_enc = $2, totp_enabled = true, totp_last_step = $3, recovery_codes = $4 WHERE id = $1',
      [admin.id, encryptField(secret), step, codes.map(hashRecoveryCode)],
    );
    await platformAudit({ query: q }, { adminId: admin.id, action: 'platform.two_step_enabled', ip: req.ip });
    await signInPlatform(req, await findPlatformAdmin(admin.id));
    res.render('platform/recovery-codes.njk', { codes });
  });

  // --- Sign in ---------------------------------------------------------------

  r.get('/platform/login', async (req, res) => {
    if (await currentAdmin(req)) return res.redirect('/platform');
    if ((await platformAdminCount()) === 0) return res.redirect('/platform/setup');
    res.render('platform/login.njk', { email: '' });
  });

  r.post('/platform/login', async (req, res) => {
    const email = readEmail(req.body.email);
    const password = readPassword(req.body.password);
    const fail = (key, status) => res.status(status).render('platform/login.njk', { email, error: req.t(key) });
    await enforce(`platform-login-ip:${req.ip}`, 20, FAIL_WINDOW);
    const failKey = `platform-login-fail:${email}`;
    if ((await peek(failKey)).count >= MAX_FAILS) return fail('auth.paused', 429);
    const admin = email ? await findPlatformAdminByEmail(email) : null;
    let ok = false;
    if (admin && admin.status === 'active') ok = await verifyPassword(admin.password_hash, password);
    else await equaliseTiming(password);
    if (!ok) {
      const { count } = await hit(failKey, FAIL_WINDOW);
      req.log.warn({ event: 'platform_login_failed' }, 'platform sign-in failed');
      return fail(count >= MAX_FAILS ? 'auth.paused' : 'auth.invalid', count >= MAX_FAILS ? 429 : 401);
    }
    await clear(failKey);
    clearPlatformSession(req);
    await renewSession(req);
    req.session.platformPendingAt = Date.now();
    if (!admin.totp_enabled) {
      req.session.platformEnrolId = admin.id;
      return res.redirect('/platform/two-step');
    }
    req.session.platformPendingId = admin.id;
    res.redirect('/platform/code');
  });

  r.get('/platform/code', (req, res) => {
    if (!pendingId(req, 'platformPendingId')) return res.redirect('/platform/login');
    res.render('platform/code.njk', {});
  });

  r.post('/platform/code', async (req, res) => {
    const id = pendingId(req, 'platformPendingId');
    if (!id) return res.redirect('/platform/login');
    await enforce(`platform-2fa:${id}`, 6, FAIL_WINDOW);
    const admin = await q(
      `SELECT id, totp_secret_enc, totp_last_step, password_changed_at, status FROM platform_admins WHERE id = $1 AND status = 'active'`, [id],
    ).then((x) => x.rows[0]);
    if (!admin || !admin.totp_secret_enc) return res.redirect('/platform/login');
    const code = cleanLine(req.body.code).slice(0, 40);
    let ok = false;
    let usedRecovery = false;
    if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      const step = verifyTotp(decryptField(admin.totp_secret_enc), code, admin.totp_last_step);
      if (step) ok = (await q('UPDATE platform_admins SET totp_last_step = $2 WHERE id = $1 AND totp_last_step < $2', [id, step])).rowCount === 1;
    } else if (code) {
      ok = (await q(
        'UPDATE platform_admins SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)',
        [id, hashRecoveryCode(code)],
      )).rowCount === 1;
      usedRecovery = ok;
    }
    if (!ok) return res.status(401).render('platform/code.njk', { error: req.t('auth.badCode') });
    await clear(`platform-2fa:${id}`);
    await signInPlatform(req, await findPlatformAdmin(id));
    await platformAudit({ query: q }, { adminId: id, action: 'platform.signed_in', details: usedRecovery ? { recovery_code: true } : {}, ip: req.ip });
    res.redirect('/platform');
  });

  r.post('/platform/logout', async (req, res) => {
    clearPlatformSession(req);
    await renewSession(req);
    res.redirect('/platform/login');
  });

  // --- Companies -------------------------------------------------------------

  r.get('/platform', requirePlatform, async (req, res) => {
    res.render('platform/index.njk', { companies: await listCompanies() });
  });

  const companyId = (req) => {
    const id = uuidParam(req.params.id);
    if (!id) throw new HttpError(404, 'not found');
    return id;
  };

  r.get('/platform/companies/:id', requirePlatform, async (req, res) => {
    const company = await getCompany(companyId(req));
    res.render('platform/company.njk', { company, plans: PLANS });
  });

  const write = (fn) => async (req, res) => {
    const id = companyId(req);
    await enforce(`platform-write:${req.platformAdmin.id}`, 60, 60);
    try {
      await fn(req, id);
      req.session.flash = { type: 'ok', text: req.t('platform.saved') };
    } catch (err) {
      if (!(err instanceof HttpError) || ![400, 409].includes(err.status)) throw err;
      req.session.flash = { type: 'warn', text: req.t(err.status === 409 ? 'platform.notNow' : 'platform.badDetails') };
    }
    res.redirect(`/platform/companies/${id}`);
  };

  r.post('/platform/companies/:id/rename', requirePlatform, write(async (req, id) => {
    const name = parse(nameField, cleanLine(req.body.name));
    if (name.errors) throw new HttpError(400, 'bad name');
    await renameCompany(id, name.data, req.platformAdmin, req.ip);
  }));

  r.post('/platform/companies/:id/plan', requirePlatform, write(async (req, id) => {
    if (!PLANS.includes(req.body.plan)) throw new HttpError(400, 'bad plan');
    await setCompanyPlan(id, req.body.plan, req.platformAdmin, req.ip);
  }));

  r.post('/platform/companies/:id/status', requirePlatform, write(async (req, id) => {
    if (!STATUS_ACTIONS.includes(req.body.action)) throw new HttpError(400, 'bad action');
    await setCompanyStatus(id, req.body.action, req.platformAdmin, req.ip);
  }));

  return r;
}
