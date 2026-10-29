import { z } from 'zod';

// Every setting the app reads comes through here. Missing or invalid
// values stop the app at startup with the variable names (never values).

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_NAME: z.string().min(1).max(40).default('Mahamm'),
  APP_URL: z.string().url().optional(),
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  APP_TIMEZONE: z.string().min(1).default('Asia/Muscat'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DATABASE_CA_CERT: z.string().optional(),

  SESSION_SECRET: z.string().min(32),
  SESSION_SECRET_PREVIOUS: z.string().min(32).optional(),
  DATA_ENCRYPTION_KEY: z.string().min(32),
  SETUP_TOKEN: z.string().min(24).optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  TRUST_PROXY: z.string().optional(),
  WIP_LIMIT: z.coerce.number().int().min(1).max(50).default(5),
  PASSWORD_BREACH_CHECK: z.enum(['true', 'false']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export class ConfigError extends Error {}

export function loadConfig(env = process.env) {
  // Treat empty strings as "not set" so blank dashboard fields behave.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid or missing environment variables:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';

  const appUrl = c.APP_URL || c.RENDER_EXTERNAL_URL || (isProd ? null : `http://localhost:${c.PORT}`);
  if (!appUrl) throw new ConfigError('Invalid or missing environment variables:\n  - APP_URL: required in production');
  const origin = new URL(appUrl).origin;
  if (isProd && !origin.startsWith('https://')) {
    throw new ConfigError('Invalid or missing environment variables:\n  - APP_URL: must use https in production');
  }

  const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const smtpSet = smtpKeys.filter((k) => c[k] !== undefined);
  if (smtpSet.length > 0 && smtpSet.length < smtpKeys.length) {
    const missing = smtpKeys.filter((k) => c[k] === undefined).map((k) => `  - ${k}: required when any SMTP_ setting is set`);
    throw new ConfigError(`Invalid or missing environment variables:\n${missing.join('\n')}`);
  }

  let trustProxy = c.TRUST_PROXY ?? (isProd ? '1' : 'loopback');
  if (/^\d+$/.test(trustProxy)) trustProxy = Number(trustProxy);
  if (trustProxy === 'true') trustProxy = true;
  if (trustProxy === 'false') trustProxy = false;

  return Object.freeze({
    env: c.NODE_ENV,
    isProd,
    isTest: c.NODE_ENV === 'test',
    port: c.PORT,
    appName: c.APP_NAME,
    origin,
    timezone: c.APP_TIMEZONE,
    databaseUrl: c.DATABASE_URL,
    databaseSsl: c.DATABASE_SSL,
    databaseCaCert: c.DATABASE_CA_CERT,
    sessionSecrets: [c.SESSION_SECRET, c.SESSION_SECRET_PREVIOUS].filter(Boolean),
    dataKey: c.DATA_ENCRYPTION_KEY,
    setupToken: c.SETUP_TOKEN || null,
    smtp: smtpSet.length === smtpKeys.length
      ? { host: c.SMTP_HOST, port: c.SMTP_PORT, user: c.SMTP_USER, pass: c.SMTP_PASS, from: c.SMTP_FROM }
      : null,
    trustProxy,
    wipLimit: c.WIP_LIMIT,
    breachCheck: c.PASSWORD_BREACH_CHECK ? c.PASSWORD_BREACH_CHECK === 'true' : isProd,
    logLevel: c.NODE_ENV === 'test' ? 'silent' : c.LOG_LEVEL,
  });
}
