import { composeEmail, queueEmail } from './mail.js';
import { translator } from './i18n.js';

// Which notification kinds also send an email (if the person allows emails).
const EMAIL_KINDS = new Set(['assigned', 'review', 'flagged', 'mentioned']);

let settings = { origin: '', appName: 'Mahamm' };
export function initNotify(config) {
  settings = { origin: config.origin, appName: config.appName };
}

export async function notify(db, { kind, taskId, task, actor, userIds }) {
  const ids = [...new Set(userIds || [])].filter((id) => id && id !== actor?.id);
  if (ids.length === 0) return;
  await db.query(
    `INSERT INTO notifications (user_id, task_id, actor_id, kind)
     SELECT u.id, $2, $3, $4 FROM users u WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
    [ids, taskId, actor?.id ?? null, kind],
  );
  if (!EMAIL_KINDS.has(kind)) return;
  const { rows } = await db.query(
    `SELECT email, lang FROM users WHERE id = ANY($1::uuid[]) AND status = 'active' AND email_notifications`,
    [ids],
  );
  for (const r of rows) {
    const t = translator(r.lang);
    const vars = { actor: actor?.name || settings.appName, n: `#${taskId}`, title: task?.title || '' };
    const { text, html } = composeEmail({
      appName: settings.appName,
      lang: r.lang,
      heading: t(`notify.${kind}`, vars),
      lines: [`#${taskId} · ${task?.title || ''}`],
      buttonText: t('email.openTask'),
      url: `${settings.origin}/tasks/${taskId}`,
      footer: t('email.notificationFooter'),
    });
    await queueEmail(db, { to: r.email, subject: t(`notify.${kind}`, vars), text, html });
  }
}
