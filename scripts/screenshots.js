// Development check: starts the app against a seeded database, walks through
// the main pages in a real browser (desktop, Arabic and phone width), and saves
// full-page screenshots plus a report of console errors, failed requests,
// sideways scrolling and drag-and-drop behaviour.
// Usage: node scripts/screenshots.js <output-folder>
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.js';
import { decryptField, initCrypto } from '../src/crypto.js';
import { closeDb, initDb, one } from '../src/db.js';
import { currentCode } from '../src/totp.js';

const out = process.argv[2] || 'screens';
const config = loadConfig();
if (config.isProd) process.exit(1);
await mkdir(out, { recursive: true });
initDb(config);
initCrypto(config.dataKey);

const base = `http://127.0.0.1:${config.port}`;
const admin = await one(`SELECT email, totp_secret_enc FROM users WHERE email = 'ahmed@example.com'`);
const secret = decryptField(admin.totp_secret_enc);
const idOf = async (title) => (await one('SELECT id FROM tasks WHERE title = $1', [title])).id;
const ids = {
  coffee: await idOf('Descale the kitchen coffee machine'),
  pdf: await idOf('Client portal: export reports to PDF'),
  paper: await idOf('طلب ورق طباعة A4 للمكتب'),
  projector: await idOf('Replace the projector bulb in meeting room B'),
  safari: await idOf('Sign-in fails on Safari when autofill is used'),
};

const server = spawn(process.execPath, ['src/server.js'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; ; i += 1) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch { /* not up yet */ }
  if (i > 60) throw new Error(`server did not start:\n${serverLog}`);
  await new Promise((r) => setTimeout(r, 500));
}

const report = [];
const note = (line) => { report.push(line); console.log(line); };
const browser = await chromium.launch();

function watch(page, label) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') note(`[${label}] console ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => note(`[${label}] page error: ${e.message}`));
  page.on('requestfailed', (r) => note(`[${label}] request failed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) note(`[${label}] HTTP ${r.status()} ${r.url()}`); });
}

async function shot(page, name) {
  await page.waitForLoadState('networkidle');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 1) note(`[${name}] page scrolls sideways by ${wide}px`);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
}

const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await desktop.newPage();
watch(page, 'desktop');

await page.goto(`${base}/login`);
await shot(page, '01-login');
await page.fill('#email', admin.email);
await page.fill('#password', process.env.DEMO_PASSWORD);
await page.click('form[action="/login"] button[type=submit]');
await page.waitForURL('**/login/two-factor');
await shot(page, '02-two-factor');
await page.fill('#code', currentCode(secret));
await page.click('form[action="/login/two-factor"] button[type=submit]');
await page.waitForURL('**/board');
await shot(page, '03-board');

// Drag a card from To do to In progress, then onto Done.
const card = page.locator(`[data-task-id="${ids.projector}"]`);
await card.dragTo(page.locator('[data-status="progress"]'));
await page.waitForLoadState('networkidle');
await page.waitForTimeout(800);
const inProgress = await page.locator(`[data-status="progress"] [data-task-id="${ids.projector}"]`).count();
note(`drag to In progress: ${inProgress ? 'moved' : 'NOT moved'}`);
await page.locator(`[data-task-id="${ids.projector}"]`).dragTo(page.locator('[data-status="done"]'));
await page.waitForTimeout(800);
note(`drag to Done opens: ${new URL(page.url()).pathname}`);
await shot(page, '04-close-form-from-drag');

const pages = [
  ['05-list', '/tasks'],
  ['06-list-closed', '/tasks?state=closed'],
  ['07-task-closed-with-credit', `/tasks/${ids.coffee}`],
  ['08-task-open-files-comments', `/tasks/${ids.pdf}`],
  ['09-task-flagged', `/tasks/${ids.paper}`],
  ['10-flag-form', `/tasks/${ids.safari}/flag`],
  ['11-new-task', '/tasks/new'],
  ['12-edit-task', `/tasks/${ids.pdf}/edit`],
  ['13-audit', '/audit'],
  ['14-people', '/people'],
  ['15-labels', '/labels'],
  ['16-notifications', '/notifications'],
  ['17-settings', '/settings'],
  ['18-not-found', '/tasks/999999'],
];
for (const [name, url] of pages) {
  await page.goto(`${base}${url}`);
  await shot(page, name);
}

// Excel import: upload a sheet with gaps and an unknown name.
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Requests');
ws.addRow(['Request', 'Location', 'Owner', 'Status', 'Done by', 'Date added', 'Notes']);
ws.addRow(['Replace kitchen tap washer', 'Kitchen, 2nd floor', 'Khalid H.', 'Done', 'Khalid', '14/09/2026', 'Washer size 1/2 inch']);
ws.addRow(['Fix flickering light in corridor', 'Corridor B', 'Khalid', 'Ongoing', '', '22/09/2026', '']);
ws.addRow(['', 'Reception', 'Aisha', 'Not started', '', '25/09/2026', '']);
ws.addRow(['Weekly fridge clean-out', 'Kitchen', 'Yousef', 'Done', 'Aisha, Yousef', '', '']);
ws.addRow(['Change the water dispenser filter', 'Kitchen', '', 'Not started', '', '03/10/2026', '']);
ws.addRow(['Repaint the parking lines', 'Car park', 'Hamed', 'Not started', '', '10/10/2026', '']);
const sheetPath = path.join(out, 'facilities-requests.xlsx');
await wb.xlsx.writeFile(sheetPath);
await page.goto(`${base}/import`);
await shot(page, '19-import-upload');
await page.setInputFiles('#file', sheetPath);
await page.click('form[action="/import"] button[type=submit]');
await page.waitForURL('**/import/**');
await shot(page, '20-import-review');

// Arabic, right to left.
await page.goto(`${base}/board`);
await page.click('.topbar form[action="/lang"] button');
await page.waitForURL('**/board');
await shot(page, '21-board-ar');
for (const [name, url] of [['22-task-ar', `/tasks/${ids.coffee}`], ['23-close-form-ar', `/tasks/${ids.pdf}/close`], ['24-audit-ar', '/audit'], ['25-list-ar', '/tasks']]) {
  await page.goto(`${base}${url}`);
  await shot(page, name);
}
await page.click('.topbar form[action="/lang"] button');
await page.waitForLoadState('networkidle');

// Phone width.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await desktop.storageState() });
const mobile = await phone.newPage();
watch(mobile, 'phone');
for (const [name, url] of [['26-phone-board', '/board'], ['27-phone-task', `/tasks/${ids.pdf}`], ['28-phone-list', '/tasks'], ['29-phone-close', `/tasks/${ids.safari}/close`]]) {
  await mobile.goto(`${base}${url}`);
  await shot(mobile, name);
}
const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const anonPage = await anon.newPage();
await anonPage.goto(`${base}/login`);
await shot(anonPage, '30-phone-login');

await browser.close();
server.kill('SIGTERM');
await closeDb();
note(`done: ${report.filter((l) => l.startsWith('[')).length} problems logged`);
await writeFile(path.join(out, 'report.txt'), `${report.join('\n')}\n\n--- server log ---\n${serverLog}`);
