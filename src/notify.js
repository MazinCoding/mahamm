import { composeEmail, queueEmail } from './mail.js';
import { translator } from './i18n.js';

// Which notification kinds also send an email (if the person allows emails).
const EMAIL_KINDS = new Set(['assigned', 'review', 'flagged', 'mentioned']);
const MAX_EMAIL_LINES = 20;

let settings = { origin: '', appName: 'Mahamm' };
export function initNotify(config) {
  settings = { origin: config.origin, appName: config.appName };
}

export async function notify(db, { kind, taskId, task, actor, userIds }) {
  await notifyBatch(db, { kind, actor, items: [{ task: { id: taskId, title: task?.title || '' }, userIds }] });
}

// One in-app notification per task, but at most one email per person: someone
// assigned to twelve tasks in one go gets a single email listing all twelve.
export async function notifyBatch(db, { kind, actor, items }) {
  const perUser = new Map();
  for (const item of items) {
    const ids = [...new Set(item.userIds || [])].filter((id) => id && id !== actor?.id);
    if (ids.length === 0) continue;
    await db.query(
      `INSERT INTO notifications (user_id, task_id, actor_id, kind)
       SELECT u.id, $2, $3, $4 FROM users u WHERE u.id = ANY($1::uuid[]) AND u.status = 'active'`,
      [ids, item.task.id, actor?.id ?? null, kind],
    );
    for (const id of ids) {
      if (!perUser.has(id)) perUser.set(id, []);
      perUser.get(id).push(item.task);
    }
  }
  if (!EMAIL_KINDS.has(kind) || perUser.size === 0) return;
  const { rows } = await db.query(
    `SELECT id, email, lang FROM users WHERE id = ANY($1::uuid[]) AND status = 'active' AND email_notifications`,
    [[...perUser.keys()]],
  );
  const actorName = actor?.name || settings.appName;
  for (const r of rows) {
    const t = translator(r.lang);
    const tasks = perUser.get(r.id);
    let heading;
    let lines;
    let buttonText;
    let url;
    if (tasks.length === 1) {
      const [task] = tasks;
      heading = t(`notify.${kind}`, { actor: actorName, n: `#${task.id}`, title: task.title || '' });
      lines = [`#${task.id} · ${task.title || ''}`];
      buttonText = t('email.openTask');
      url = `${settings.origin}/tasks/${task.id}`;
    } else {
      heading = t(`notify.${kind}Many`, { actor: actorName, count: tasks.length });
      lines = tasks.slice(0, MAX_EMAIL_LINES).map((task) => `#${task.id} · ${task.title || ''}`);
      if (tasks.length > MAX_EMAIL_LINES) lines.push(t('notify.andMore', { count: tasks.length - MAX_EMAIL_LINES }));
      buttonText = t('email.openTable');
      url = kind === 'assigned' ? `${settings.origin}/table?person=${r.id}` : `${settings.origin}/table?status=review`;
    }
    const { text, html } = composeEmail({
      appName: settings.appName, lang: r.lang, heading, lines, buttonText, url, footer: t('email.notificationFooter'),
    });
    await queueEmail(db, { to: r.email, subject: heading, text, html });
  }
}
