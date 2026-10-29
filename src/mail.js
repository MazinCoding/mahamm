import nodemailer from 'nodemailer';
import { q } from './db.js';

let transport = null;
let fromAddress = null;
let log = null;

export function initMail(config, logger) {
  log = logger;
  if (!config.smtp) {
    transport = null;
    return;
  }
  const { host, port, user, pass, from } = config.smtp;
  fromAddress = from;
  transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

// Tests can swap in a fake transport.
export function setTransport(t, from = 'test@example.com') {
  transport = t;
  fromAddress = from;
}

export function mailEnabled() {
  return transport !== null;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').slice(0, 200);

// Plain, safe email body: every piece of text is escaped.
export function composeEmail({ appName, lang, heading, lines = [], buttonText, url, footer }) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const text = [heading, '', ...lines, '', url ? `${buttonText}: ${url}` : '', '', footer || ''].join('\n').trim();
  const html = `<!doctype html><html lang="${lang}" dir="${dir}"><body style="margin:0;padding:24px;background:#eef0f3;font-family:Arial,Helvetica,sans-serif;color:#1b1f24">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dde1e6;border-radius:10px;padding:28px 32px">
<p style="margin:0 0 20px;font-weight:bold">${escapeHtml(appName)}</p>
<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(heading)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;color:#3d4752">${escapeHtml(l)}</p>`).join('\n')}
${url ? `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#0b6e69;color:#ffffff;font-weight:bold;text-decoration:none">${escapeHtml(buttonText)}</a></p>` : ''}
${footer ? `<p style="margin:16px 0 0;font-size:13px;color:#57606a">${escapeHtml(footer)}</p>` : ''}
</div></body></html>`;
  return { text, html };
}

// Security emails (invites, resets) go out immediately so the person can act.
export async function sendNow({ to, subject, text, html }) {
  if (!transport) return false;
  try {
    await transport.sendMail({ from: fromAddress, to, subject: oneLine(subject), text, html });
    return true;
  } catch (err) {
    log?.error({ err: { message: err.message, code: err.code } }, 'email send failed');
    return false;
  }
}

// Notifications go through an outbox so a slow mail server never blocks a page.
export async function queueEmail(db, { to, subject, text, html }) {
  await db.query(
    `INSERT INTO email_outbox (to_email, subject, body_text, body_html, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [to, oneLine(subject), text, html, transport ? 'pending' : 'skipped'],
  );
}

export async function processOutbox() {
  if (!transport) return 0;
  const { rows } = await q(
    `UPDATE email_outbox SET attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
     WHERE id IN (
       SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
     RETURNING id, to_email, subject, body_text, body_html, attempts`,
  );
  for (const row of rows) {
    try {
      await transport.sendMail({ from: fromAddress, to: row.to_email, subject: row.subject, text: row.body_text, html: row.body_html });
      await q(`UPDATE email_outbox SET status = 'sent', sent_at = now(), body_text = NULL, body_html = NULL WHERE id = $1`, [row.id]);
    } catch (err) {
      log?.warn({ err: { message: err.message, code: err.code }, outboxId: row.id }, 'queued email failed');
      if (row.attempts >= 5) {
        await q(`UPDATE email_outbox SET status = 'failed', body_text = NULL, body_html = NULL WHERE id = $1`, [row.id]);
      }
    }
  }
  return rows.length;
}

export async function pruneOutbox() {
  await q(`DELETE FROM email_outbox WHERE status <> 'pending' AND created_at < now() - interval '30 days'`);
}
