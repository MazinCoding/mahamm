import pino from 'pino';

// One-time links carry their token in the path; never let it reach a log.
export function redactUrl(url = '') {
  return String(url).replace(/^\/(reset|invite)\/[^/?#]+/, '/$1/[redacted]');
}

export function createLogger(config) {
  return pino({
    level: config.logLevel,
    base: undefined,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[redacted]',
    },
  });
}
