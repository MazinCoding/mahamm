// Fills an EMPTY development database with sample people and tasks, for demos
// and screenshots. Refuses to run in production or on a database that has users.
// Usage: DEMO_PASSWORD=... node scripts/seed-demo.js
import { loadConfig } from '../src/config.js';
import { encryptField, initCrypto } from '../src/crypto.js';
import { closeDb, initDb, one, q } from '../src/db.js';
import { initNotify } from '../src/notify.js';
import { hashPassword } from '../src/passwords.js';
import { newTotpSecret } from '../src/totp.js';
import {
  addAttachment, addComment, closeTask, createTask, flagTask, moveTask,
} from '../src/services/tasks.js';

const config = loadConfig();
if (config.isProd) {
  console.error('seed-demo: refusing to run with NODE_ENV=production');
  process.exit(1);
}
const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 12) {
  console.error('seed-demo: set DEMO_PASSWORD (12+ characters) for the sample accounts');
  process.exit(1);
}
initDb(config);
initCrypto(config.dataKey);
initNotify(config);

if ((await one('SELECT count(*)::int AS n FROM users')).n > 0) {
  console.error('seed-demo: the database already has users; use an empty database');
  await closeDb();
  process.exit(1);
}

const PEOPLE = {
  ab: ['Ahmed Al-Balushi', 'admin'], mk: ['Maryam Al-Kindi', 'admin'], fh: ['Fatma Al-Harthi', 'member'],
  sr: ['Said Al-Rawahi', 'member'], kh: ['Khalid Al-Hinai', 'member'], al: ['Aisha Al-Lawati', 'member'],
  ym: ['Yousef Al-Maskari', 'member'], nz: ['Noor Al-Zadjali', 'member'], lb: ['Laila Al-Busaidi', 'member'],
};
const hash = await hashPassword(password);
const u = {};
for (const [key, [name, role]] of Object.entries(PEOPLE)) {
  const email = `${name.split(' ')[0].toLowerCase()}@example.com`;
  const totp = role === 'admin' ? encryptField(newTotpSecret()) : null;
  const row = await one(
    `INSERT INTO users (email, name, password_hash, role, totp_enabled, totp_secret_enc, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7)) RETURNING id, name, role`,
    [email, name, hash, role, !!totp, totp, Math.floor(Math.random() * 600)],
  );
  u[key] = row;
}

const L = { bug: 1, feature: 2, it: 3, facilities: 4, office: 5, docs: 6, client: 7, security: 8, design: 9 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
const dayOffset = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// [title, description, labels, priority, creator, assignees, ageDays, target, extras]
// target: backlog | todo | progress | review | {by, credit, reason, daysAgo}
const TASKS = [
  ['Clear the paper jam in the 1st-floor printer', '', ['facilities'], 'med', 'al', ['kh'], 27, { by: 'al', credit: ['kh'], reason: 'completed', daysAgo: 24 }],
  ['Printer on the 1st floor not working', '', ['facilities'], 'med', 'nz', [], 24, { by: 'kh', reason: 'duplicate', daysAgo: 24 }],
  ['Book a venue for the end-of-year team dinner', '', ['office'], 'low', 'mk', ['al'], 22, { by: 'mk', credit: ['al'], reason: 'completed', daysAgo: 4 }],
  ['Set up nightly database backups and test a restore', 'Backups to the NAS every night, then restore one onto a fresh server.', ['it', 'security'], 'high', 'ab', ['kh', 'ym'], 21, { by: 'ab', credit: ['kh', 'ym'], reason: 'completed', daysAgo: 3 }, { comments: [['ym', 'Restore tested on a fresh server. It took 11 minutes and every table matched.']] }],
  ['App crashes when uploading HEIC photos', '', ['bug'], 'high', 'fh', ['nz'], 20, { by: 'nz', credit: ['nz'], reason: 'completed', daysAgo: 1 }],
  ['Translate client portal error messages to Arabic', '', ['feature', 'client'], 'med', 'fh', ['fh'], 26, { by: 'fh', credit: ['nz'], reason: 'completed', daysAgo: 8 }],
  ['Descale the kitchen coffee machine', 'The descale light is on and coffee is coming out very slowly.', ['facilities'], 'low', 'al', ['al'], 3, { by: 'fh', credit: ['sr'], reason: 'completed', daysAgo: 2 }, {
    comments: [['al', 'The descaling tablets are in the top drawer.'], ['sr', 'Done. I ran two descale cycles and a rinse.'], ['fh', 'Closing this for Said, since he did the descaling.']],
  }],
  ['Trial a separate project management tool', '', ['it'], 'low', 'mk', ['mk'], 30, { by: 'mk', reason: 'notneeded', daysAgo: 12 }],
  ['Fix the leaking AC unit in the server room', '', ['facilities'], 'high', 'nz', ['kh'], 17, 'progress', { due: -3, comments: [['kh', 'The technician is coming on Sunday. There is a tray under the unit for now.']] }],
  ['Client portal: export reports to PDF', 'Users need a one-click PDF export of the monthly report.\nIt should match the printed layout the finance team already uses.', ['feature', 'client'], 'high', 'mk', ['fh', 'sr'], 8, 'progress', {
    due: 6, file: true, comments: [['fh', 'Single-page reports export correctly now. Long tables still break badly across pages.'], ['sr', 'I’ll take the page breaks.'], ['mk', '@Ahmed Finance wants the logo on every page, not just the first. Can you confirm with them?']],
  }],
  ['Rate-limit the password reset endpoint', 'Limit by IP and by account. Return the same message whether or not the email exists.', ['security'], 'high', 'ab', ['ym'], 9, 'progress', { due: 2 }],
  ['Import the facilities team’s request sheet', '', ['it', 'facilities'], 'med', 'ab', ['ab'], 12, 'progress'],
  ['Sign-in fails on Safari when autofill is used', '', ['bug'], 'high', 'ab', ['nz'], 9, 'review', { comments: [['nz', 'Safari fills the password without firing an input event. The form now validates on submit instead.']] }],
  ['CSV export of the audit log for management', '', ['feature'], 'med', 'mk', ['sr'], 14, 'review'],
  ['Update the vendor contract tracker', '', ['office'], 'low', 'mk', ['mk'], 19, 'review'],
  ['Replace the projector bulb in meeting room B', 'The projector switches itself off after about 10 minutes. A spare bulb is in the store room.', ['facilities'], 'med', 'al', ['kh'], 0, 'todo', { due: 4 }],
  ['Date picker starts the week on Monday instead of Sunday', '', ['bug'], 'high', 'fh', ['ym'], 2, 'todo', { due: 1 }],
  ['Renew the TLS certificate for the staging server', '', ['security', 'it'], 'high', 'ab', ['nz'], 6, 'todo', { due: -2 }],
  ['Prepare slides for the sprint review', '', ['docs'], 'med', 'mk', ['mk'], 10, 'todo', { due: 5 }],
  ['طلب ورق طباعة A4 للمكتب', 'نحتاج 10 رزم على الأقل قبل نهاية الشهر.', ['office'], 'low', 'al', ['al'], 13, 'todo', { flag: ['sr', 'wrong', 'We need A3 for the plotter as well, not only A4.'] }],
  ['Add an Arabic invoice template to the client portal', 'Two clients asked for invoices in Arabic. Needs a right-to-left layout.', ['feature', 'client'], 'med', 'fh', [], 1, 'backlog'],
  ['Compare storing attachments on the office NAS vs cloud storage', '', ['it'], 'low', 'ym', [], 7, 'backlog'],
  ['Dark mode for the internal dashboard', '', ['feature', 'design'], 'low', 'nz', [], 16, 'backlog'],
  ['Write an onboarding guide for new developers', '', ['docs'], 'med', 'mk', ['sr'], 20, 'backlog'],
  ['Order chairs for meeting room A', '', ['facilities'], 'low', 'sr', [], 1, 'todo', { flag: ['kh', 'duplicate', 'Already ordered under the office budget last week.'] }],
];

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
for (const [title, description, labels, priority, creator, assignees, ageDays, target, extra = {}] of TASKS) {
  const startStatus = target === 'backlog' ? 'backlog' : 'todo';
  const task = await createTask({
    title, description, status: startStatus, priority,
    due_date: extra.due === undefined ? '' : dayOffset(extra.due),
    labels: labels.map((l) => L[l]), assignees: assignees.map((k) => u[k].id),
  }, u[creator], '127.0.0.1');
  const worker = u[assignees[0] || creator];
  if (target === 'progress' || target === 'review' || typeof target === 'object') await moveTask(task.id, 'progress', worker, '127.0.0.1');
  if (target === 'review' || (typeof target === 'object' && target.reason === 'completed')) await moveTask(task.id, 'review', worker, '127.0.0.1');
  if (extra.file) await addAttachment(task.id, { filename: 'report-layout.pdf', mime: 'application/pdf', buffer: PDF }, u[creator], '127.0.0.1');
  for (const [who, body] of extra.comments || []) await addComment(task.id, body, u[who], '127.0.0.1');
  if (extra.flag) await flagTask(task.id, { reason: extra.flag[1], note: extra.flag[2] }, u[extra.flag[0]], '127.0.0.1');
  if (typeof target === 'object') {
    await closeTask(task.id, { reason: target.reason, credited: (target.credit || []).map((k) => u[k].id) }, u[target.by], '127.0.0.1');
    await q(`UPDATE tasks SET closed_at = now() - make_interval(days => $2) WHERE id = $1`, [task.id, target.daysAgo]);
  }
  await q(`UPDATE tasks SET created_at = now() - make_interval(days => $2, hours => $3) WHERE id = $1`, [task.id, ageDays, task.id % 7]);
}

// Laila left the company: disabled, but her history stays.
await q(`UPDATE users SET status = 'disabled' WHERE id = $1`, [u.lb.id]);
console.log(`seed-demo: ${Object.keys(u).length} people and ${TASKS.length} tasks created`);
await closeDb();
