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

// Browse at the configured address so the Origin check sees the site's own origin.
const base = config.origin;
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
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures += 1;
    note(`[${name}] STEP FAILED: ${err.message.split('\n')[0]}`);
  }
}
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
await step('drag', async () => {
  await page.locator(`[data-task-id="${ids.projector}"]`).dragTo(page.locator('[data-status="progress"]'));
  await page.waitForTimeout(1200);
  await page.waitForLoadState('networkidle');
  const moved = await page.locator(`[data-status="progress"] [data-task-id="${ids.projector}"]`).count();
  note(`check: drag to In progress ${moved ? 'saved' : 'DID NOT SAVE'}`);
  if (!moved) failures += 1;
  await page.locator(`[data-task-id="${ids.projector}"]`).dragTo(page.locator('[data-status="done"]'));
  await page.waitForURL('**/close', { timeout: 5000 });
  note(`check: drag to Done opens ${new URL(page.url()).pathname}`);
  await shot(page, '04-close-form-from-drag');
});

const pages = [
  ['05-list', '/tasks'],
  ['06-list-closed', '/tasks?state=closed'],
  ['06b-table', '/table'],
  ['06c-table-closed-by-priority', '/table?closed=1&color=priority&sort=due&dir=asc'],
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
  await step(name, async () => {
    await page.goto(`${base}${url}`);
    await shot(page, name);
  });
}

// Table: colouring switches without reloading and is remembered after a reload.
await step('table-colour', async () => {
  await page.goto(`${base}/table`);
  await page.selectOption('[data-color-by-select]', 'label');
  note(`check: table colour after choosing First label = ${await page.getAttribute('[data-sheet]', 'data-color-by')}`);
  await page.goto(`${base}/table?sort=title`);
  note(`check: table colour after reload = ${await page.getAttribute('[data-sheet]', 'data-color-by')}`);
  await shot(page, '06d-table-by-label');
  await page.selectOption('[data-color-by-select]', 'status');
});

// Table ribbon: select a range, apply a value, open a cell menu, paint with the brush.
await step('table-ribbon', async () => {
  await page.goto(`${base}/table?sort=id&dir=asc`);
  const rows = page.locator('.sheet tbody tr');
  await rows.nth(0).locator('.col-task .num').click();
  await rows.nth(2).locator('.col-task .num').click({ modifiers: ['Shift'] });
  note(`check: rows selected after shift-click = ${await page.locator('.row-check:checked').count()}`);
  await shot(page, '06e-table-selected');
  const picked = await page.locator('.row-check:checked').evaluateAll((boxes) => boxes.map((b) => b.value));
  await page.fill('#rb-due', '2026-12-31');
  await Promise.all([page.waitForEvent('load'), page.click('.ribbon-buttons button[name="apply"][value="due"]')]);
  const dues = [];
  for (const id of picked) dues.push((await page.locator(`tr[data-task-id="${id}"] [data-field="due"]`).innerText()).trim());
  note(`check: due dates after ribbon = ${dues.join(', ')}; message = ${(await page.locator('.flash').innerText()).trim()}`);
  note(`check: rows still selected after saving = ${await page.locator('.row-check:checked').count()}`);
  await rows.nth(1).locator('[data-field="status"]').click();
  await page.waitForSelector('.cell-menu');
  await shot(page, '06f-table-cell-menu');
  await page.keyboard.press('Escape');
  await page.click('[data-brush]');
  await page.click('button[name="apply"][value="priority:low"]');
  const target = await rows.nth(3).getAttribute('data-task-id');
  await Promise.all([page.waitForEvent('load'), rows.nth(3).locator('.col-task .num').click()]);
  note(`check: brush set #${target} priority to ${(await page.locator(`tr[data-task-id="${target}"] [data-field="priority"]`).innerText()).trim()}; brush still on = ${await page.getAttribute('[data-brush]', 'aria-pressed')}`);
  await shot(page, '06g-table-brush');
  await page.keyboard.press('Escape');
  note(`check: Esc turns the brush off = ${await page.getAttribute('[data-brush]', 'aria-pressed')}`);

  // Done for two rows goes to the close page; then Undo reopens them.
  await rows.nth(0).locator('.col-task .num').click();
  await rows.nth(1).locator('.col-task .num').click({ modifiers: ['Shift'] });
  const closing = await page.locator('.row-check:checked').evaluateAll((boxes) => boxes.map((b) => b.value));
  await Promise.all([page.waitForURL('**/table/close?**'), page.click('button[name="apply"][value="close"]')]);
  await shot(page, '06h-table-done-page');
  for (const select of await page.locator('select[name="credit"]').all()) {
    if ((await select.inputValue()) === '' && (await select.locator('option').first().innerText()).startsWith('Missing')) {
      await select.selectOption({ index: 1 });
    }
  }
  await Promise.all([page.waitForURL((url) => url.pathname === '/table'), page.click('form[action="/tasks/bulk/close"] button[type=submit]')]);
  note(`check: after Done = ${(await page.locator('.flash').innerText()).trim().replace(/\s+/g, ' ')}`);
  await shot(page, '06i-table-closed-with-undo');
  await Promise.all([page.waitForEvent('load'), page.click('.flash-undo button')]);
  note(`check: after Undo = ${(await page.locator('.flash').innerText()).trim()}; rows back = ${await page.locator(closing.map((id) => `tr[data-task-id="${id}"]`).join(', ')).count()}`);
});

// Quick-add row, and an admin changing the in-progress limit.
await step('table-quick-add', async () => {
  await page.goto(`${base}/table`);
  await page.fill('#quick-title', 'Check the fire extinguishers on every floor');
  await Promise.all([page.waitForEvent('load'), page.press('#quick-title', 'Enter')]);
  note(`check: quick-add = ${(await page.locator('.flash').innerText()).trim()}; cursor back in the box = ${await page.evaluate(() => document.activeElement?.id)}`);
  await shot(page, '06j-table-quick-add');
  await page.goto(`${base}/board`);
  const before = await page.inputValue('#wip-limit');
  await page.fill('#wip-limit', '3');
  await Promise.all([page.waitForEvent('load'), page.click('.wip-form button')]);
  note(`check: limit form = ${(await page.locator('.flash').innerText()).trim()}; stat = ${(await page.locator('.stat').nth(1).locator('.stat-value').innerText()).trim()}`);
  await shot(page, '06k-board-limit-changed');
  await page.fill('#wip-limit', before);
  await Promise.all([page.waitForEvent('load'), page.click('.wip-form button')]);
});

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
await step('import', async () => {
  await page.goto(`${base}/import`);
  await shot(page, '19-import-upload');
  await page.setInputFiles('#file', sheetPath);
  await page.click('form[action="/import"] button[type=submit]');
  await page.waitForURL('**/import/**', { timeout: 10000 });
  await shot(page, '20-import-review');
});

// Close a task through the form, crediting someone else.
await step('close-flow', async () => {
  await page.goto(`${base}/tasks/${ids.safari}/close`);
  await page.locator('input[name="credited"]').evaluateAll((boxes) => boxes.forEach((b) => { b.checked = false; }));
  await page.locator('label.check', { hasText: 'Fatma Al-Harthi' }).click();
  await page.click('form[data-close-form] button[type=submit]');
  await page.waitForURL(`**/tasks/${ids.safari}`);
  const text = await page.locator('.record').innerText();
  note(`check: after closing, audit record says ${text.includes('Fatma Al-Harthi') && text.includes('Ahmed Al-Balushi') ? 'closed by Ahmed, completed by Fatma' : 'SOMETHING ELSE: ' + text.replace(/\s+/g, ' ')}`);
  await shot(page, '20b-task-just-closed');
});

// Arabic, right to left.
await step('arabic', async () => {
  await page.goto(`${base}/board`);
  await page.click('.topbar form[action="/lang"] button');
  await page.waitForURL('**/board');
  note(`check: html dir after switching language = ${await page.getAttribute('html', 'dir')}`);
  await shot(page, '21-board-ar');
  for (const [name, url] of [['22-task-ar', `/tasks/${ids.coffee}`], ['23-close-form-ar', `/tasks/${ids.pdf}/close`], ['24-audit-ar', '/audit'], ['25-list-ar', '/tasks'], ['25b-table-ar', '/table?closed=1']]) {
    await page.goto(`${base}${url}`);
    await shot(page, name);
  }
  await page.click('.topbar form[action="/lang"] button');
  await page.waitForLoadState('networkidle');
});

// Phone width.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, storageState: await desktop.storageState() });
const mobile = await phone.newPage();
watch(mobile, 'phone');
for (const [name, url] of [['26-phone-board', '/board'], ['27-phone-task', `/tasks/${ids.pdf}`], ['28-phone-list', '/tasks'], ['28b-phone-table', '/table'], ['29-phone-close', `/tasks/${ids.projector}/close`]]) {
  await step(name, async () => {
    await mobile.goto(`${base}${url}`);
    await shot(mobile, name);
  });
}
const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
const anonPage = await anon.newPage();
await anonPage.goto(`${base}/login`);
await shot(anonPage, '30-phone-login');

await browser.close();
server.kill('SIGTERM');
await closeDb();
note(`done: ${failures} failed steps, ${report.filter((l) => l.startsWith('[')).length} problems logged`);
await writeFile(path.join(out, 'report.txt'), `${report.join('\n')}\n\n--- server log ---\n${serverLog}`);
process.exit(failures ? 1 : 0);
