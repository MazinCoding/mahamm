import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { initCrypto } from './crypto.js';
import { closeDb, initDb } from './db.js';
import { createLogger } from './logger.js';
import { initMail, processOutbox, pruneOutbox } from './mail.js';
import { initNotify } from './notify.js';
import { pruneRateLimits } from './ratelimit.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  // Fail fast: names of the bad variables only, never their values.
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const logger = createLogger(config);
initDb(config, logger);
initCrypto(config.dataKey);
initMail(config, logger);
initNotify(config);

if (config.isProd && !config.smtp) logger.warn('SMTP is not configured: invites and reset links are shown on screen instead of emailed');
if (config.isProd && !config.setupToken) logger.info('SETUP_TOKEN is not set: first-run setup page is disabled');

const app = createApp(config, logger);
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'mahamm listening'));

// Background jobs: send queued emails, tidy expired counters.
const timers = [
  setInterval(() => processOutbox().catch((err) => logger.error({ err }, 'outbox failed')), 20_000),
  setInterval(() => Promise.all([pruneRateLimits(), pruneOutbox()]).catch((err) => logger.error({ err }, 'cleanup failed')), 60 * 60_000),
];

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  timers.forEach(clearInterval);
  server.close(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
