import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import nunjucks from 'nunjucks';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { csrfToken, csrfUnlessMultipart, enforceAdminTwoFactor, loadUser, sessionMiddleware } from './auth.js';
import { q } from './db.js';
import { formatters, pickLang, translator } from './i18n.js';
import { redactUrl } from './logger.js';
import { RateLimited, limiter } from './ratelimit.js';
import { httpsRedirect, sameOriginWrites, securityHeaders } from './security.js';
import { rejectUnexpectedMultipart } from './uploads.js';
import authRoutes from './routes/auth.js';
import taskRoutes from './routes/tasks.js';
import adminRoutes from './routes/admin.js';
import meRoutes from './routes/me.js';
import homeRoutes from './routes/home.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const AVATAR_CLASSES = 10;
export function avatarClass(id) {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `av-${h % AVATAR_CLASSES}`;
}

export function initials(name, lang) {
  const parts = String(name || '?').trim().split(/\s+/);
  // One letter for names written in Arabic script; two Latin initials otherwise, in either language.
  if (/[؀-ۿ]/.test(parts[0] || '')) return (parts[0] || '?').charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].replace(/^al-/i, '') : '';
  return `${parts[0].charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function createApp(config, logger) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'njk');
  app.set('views', path.join(root, 'views'));
  const env = nunjucks.configure(path.join(root, 'views'), { autoescape: true, express: app, noCache: !config.isProd });
  env.addGlobal('avatarClass', avatarClass);

  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
    autoLogging: { ignore: (req) => req.url.startsWith('/static/') || req.url === '/healthz' },
  }));

  app.use(httpsRedirect(config));
  app.use(securityHeaders(config));

  app.get('/healthz', async (req, res) => {
    try {
      await q('SELECT 1');
      res.type('text').send('ok');
    } catch {
      res.status(503).type('text').send('unavailable');
    }
  });

  app.use('/static', express.static(path.join(root, 'public'), {
    index: false,
    dotfiles: 'ignore',
    maxAge: config.isProd ? '1d' : 0,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/favicon.svg'));

  // Lets people add the site to their phone's home screen and open it like an app.
  app.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/manifest+json').send(JSON.stringify({
      id: '/home',
      name: config.appName,
      short_name: config.appName,
      start_url: '/home',
      scope: '/',
      display: 'standalone',
      background_color: '#f6f7f9',
      theme_color: '#ffffff',
      icons: [
        { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/static/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }));
  });

  app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 300 }));
  app.use(express.json({ limit: '16kb' }));
  app.use(sessionMiddleware(config));
  app.use(loadUser());
  app.use(rejectUnexpectedMultipart);
  app.use(sameOriginWrites(config));
  app.use(csrfUnlessMultipart);
  app.use(limiter({ name: 'all', limit: 600, windowSeconds: 300 }));

  // Values every page can use.
  app.use(async (req, res, next) => {
    const lang = pickLang(req);
    const t = translator(lang);
    const fmt = formatters(lang, config.timezone);
    req.t = t;
    req.lang = lang;
    res.locals.t = t;
    res.locals.fmt = fmt;
    res.locals.lang = lang;
    res.locals.dir = lang === 'ar' ? 'rtl' : 'ltr';
    res.locals.appName = config.appName;
    res.locals.csrfToken = csrfToken(req);
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl.slice(0, 500);
    res.locals.section = req.path.split('/')[1] || '';
    res.locals.initials = (name) => initials(name, lang);
    res.locals.labelName = (l) => (lang === 'ar' ? l.name_ar : l.name_en);
    res.locals.fileSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
    res.locals.flash = req.session?.flash || null;
    if (req.session?.flash) delete req.session.flash;
    // Pages are personal; never let a shared or browser cache keep them.
    res.setHeader('Cache-Control', 'no-store');
    if (req.user) {
      res.locals.user ={ id: req.user.id, name: req.user.name, role: req.user.role, isAdmin: req.user.role === 'admin' };
      const unread = await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
      res.locals.unread = unread.rows[0].n;
    }
    next();
  });

  app.use(enforceAdminTwoFactor);

  app.use(authRoutes(config));
  app.use(meRoutes(config));
  app.use(homeRoutes(config));
  app.use(taskRoutes(config));
  app.use(adminRoutes(config));

  app.get('/', (req, res) => res.redirect(req.user ? '/home' : '/login'));

  app.use((req, res, next) => {
    const err = new Error('not found');
    err.status = 404;
    next(err);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = Number(err.status || err.statusCode) || 500;
    let key = null;
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    }
    if (err.code === 'EBADCSRFTOKEN') key = 'errors.csrf';
    if (err instanceof RateLimited) res.setHeader('Retry-After', String(err.retryAfter));
    if (status < 400 || status > 599) status = 500;
    if (status >= 500) req.log?.error({ err }, 'request failed');
    else req.log?.warn({ status, reason: err.message }, 'request rejected');
    if (res.headersSent) return undefined;
    const messages = { 400: 'errors.badRequest', 401: 'errors.signIn', 403: 'errors.forbidden', 404: 'errors.notFound', 409: 'errors.conflict', 410: 'errors.expired', 413: 'errors.tooLarge', 415: 'errors.badRequest', 429: 'errors.tooMany' };
    key = key || messages[status] || 'errors.server';
    const t = req.t || translator(pickLang(req));
    res.status(status);
    const wantsJson = req.is('application/json') || String(req.headers.accept || '').includes('application/json');
    if (wantsJson) return res.json({ error: t(key) });
    return res.render('error.njk', {
      status,
      message: t(key),
      t,
      lang: req.lang || 'en',
      dir: req.lang === 'ar' ? 'rtl' : 'ltr',
      appName: config.appName,
    });
  });

  return app;
}
