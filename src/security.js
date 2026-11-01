import helmet from 'helmet';

export function securityHeaders(config) {
  const strict = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
  });
  return function headers(req, res, next) {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    strict(req, res, next);
  };
}

// Behind a TLS-terminating proxy, plain-HTTP requests get sent to HTTPS.
// The redirect target is built from APP_URL, never from the Host header.
export function httpsRedirect(config) {
  return function redirect(req, res, next) {
    if (!config.isProd || req.secure || req.path === '/healthz') return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(301, config.origin + req.originalUrl);
    return res.status(403).send('HTTPS required');
  };
}

// Defence in depth on top of CSRF tokens: state-changing requests must not
// come from another site.
export function sameOriginWrites(config) {
  return function checkOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return next(forbidden(`sec-fetch-site ${site}`));
    // "null" is what browsers send from no-referrer pages; the CSRF token still applies.
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !config.allowedOrigins.includes(origin)) return next(forbidden('origin not allowed'));
    return next();
  };
}

function forbidden(why) {
  const err = new Error(`cross-site request blocked (${why})`);
  err.status = 403;
  return err;
}

// Only allow redirects to local paths ("/board"), never "//evil.com" or "https://…".
export function safeLocalPath(value, fallback = '/') {
  const s = String(value || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\r\n]/.test(s)) return fallback;
  return s;
}
