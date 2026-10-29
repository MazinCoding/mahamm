import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import { fileTypeFromBuffer } from 'file-type';
import { audit } from '../audit.js';
import { one, q, tx } from '../db.js';
import { clean, cleanLine } from '../validation.js';
import { HttpError } from './tasks.js';

export const MAX_ROWS = 2000;
const MAX_COLS = 40;
const MAX_CELL = 4000;

export const FIELDS = ['title', 'description', 'assignee', 'status', 'completed_by', 'created_date', 'due_date', 'priority', 'notes'];

const SYNONYMS = {
  title: ['task', 'title', 'request', 'item', 'subject', 'name', 'المهمة', 'العنوان', 'الطلب'],
  description: ['description', 'details', 'detail', 'location', 'الوصف', 'التفاصيل', 'الموقع'],
  assignee: ['owner', 'assignee', 'assigned to', 'assigned', 'responsible', 'person', 'المسؤول', 'المكلف'],
  status: ['status', 'state', 'progress', 'الحالة'],
  completed_by: ['done by', 'completed by', 'finished by', 'closed by', 'أنجزها', 'تم بواسطة', 'المنجز'],
  created_date: ['date added', 'created', 'created at', 'date', 'added', 'تاريخ الإضافة', 'التاريخ'],
  due_date: ['due', 'due date', 'deadline', 'target date', 'الموعد النهائي', 'تاريخ الاستحقاق'],
  priority: ['priority', 'urgency', 'importance', 'الأولوية'],
  notes: ['notes', 'comments', 'comment', 'remarks', 'ملاحظات'],
};

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellText(value.result);
    if ('text' in value) return String(value.text);
    if ('error' in value) return '';
    return '';
  }
  return String(value);
}

const tidy = (s) => clean(s).slice(0, MAX_CELL);

// Reads the first worksheet (xlsx) or a CSV into { headers, rows } of strings.
export async function parseSheet(file) {
  if (!file?.buffer?.length) throw new HttpError(400, 'empty file');
  const buffer = file.buffer;
  const detected = await fileTypeFromBuffer(buffer);
  let table = [];
  if (detected?.ext === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.worksheets[0];
    if (!sheet) throw new HttpError(400, 'no sheet');
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (table.length > MAX_ROWS) return;
      const values = Array.isArray(row.values) ? row.values.slice(1, MAX_COLS + 1) : [];
      table.push(values.map((v) => tidy(cellText(v))));
    });
  } else if (!detected && /\.csv$/i.test(file.originalname || '') && !buffer.includes(0)) {
    table = parseCsv(buffer.toString('utf8'), { bom: true, relax_column_count: true, skip_empty_lines: true, to: MAX_ROWS + 1 })
      .map((r) => r.slice(0, MAX_COLS).map((v) => tidy(v)));
  } else {
    throw new HttpError(400, 'unsupported file');
  }
  table = table.filter((r) => r.some((v) => v !== ''));
  if (table.length < 2) throw new HttpError(400, 'no rows');
  const width = Math.max(...table.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => cleanLine(table[0][i] || '') || `Column ${i + 1}`);
  const rows = table.slice(1, MAX_ROWS + 1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { headers, rows, truncated: table.length - 1 > MAX_ROWS };
}

export async function saveJob(userId, filename, parsed) {
  await q(`DELETE FROM import_jobs WHERE created_at < now() - interval '1 day'`);
  return one(
    'INSERT INTO import_jobs (user_id, filename, headers, rows) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, cleanLine(filename).slice(0, 160) || 'sheet', JSON.stringify(parsed.headers), JSON.stringify(parsed.rows)],
  );
}

// Jobs belong to the admin who uploaded them.
export async function getJob(id, userId) {
  return one(
    `SELECT id, filename, headers, rows, created_at FROM import_jobs
     WHERE id = $1 AND user_id = $2 AND created_at > now() - interval '1 day'`,
    [id, userId],
  );
}

export function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  const norm = (s) => s.toLowerCase().replace(/[_\-:]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const field of FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && SYNONYMS[field].includes(norm(h)));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

export function readMapping(body, headers) {
  const mapping = {};
  for (const field of FIELDS) {
    const raw = body[`map_${field}`];
    if (raw === undefined || raw === '') continue;
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 0 && idx < headers.length) mapping[field] = idx;
  }
  return mapping;
}

const DONE = ['done', 'complete', 'completed', 'closed', 'finished', 'yes', 'resolved', 'منجز', 'منجزة', 'مكتمل', 'مكتملة', 'تم'];
const PROGRESS = ['in progress', 'ongoing', 'started', 'working', 'doing', 'wip', 'جاري', 'قيد التنفيذ', 'جارية'];
const REVIEW = ['review', 'in review', 'testing', 'check', 'مراجعة', 'قيد المراجعة'];
const BACKLOG = ['backlog', 'later', 'idea', 'someday', 'on hold', 'لاحقا', 'لاحقًا', 'مؤجل'];

export function mapStatus(text) {
  const s = cleanLine(text).toLowerCase();
  if (DONE.includes(s)) return { status: 'todo', closed: true };
  if (PROGRESS.includes(s)) return { status: 'progress', closed: false };
  if (REVIEW.includes(s)) return { status: 'review', closed: false };
  if (BACKLOG.includes(s)) return { status: 'backlog', closed: false };
  return { status: 'todo', closed: false };
}

export function mapPriority(text) {
  const s = cleanLine(text).toLowerCase();
  if (['high', 'urgent', 'critical', 'h', '1', 'عالية', 'عاجل', 'مستعجل'].includes(s)) return 'high';
  if (['low', 'l', '3', 'منخفضة'].includes(s)) return 'low';
  return 'med';
}

// Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY and Excel serial numbers.
export function parseDate(text) {
  const s = cleanLine(text);
  if (!s) return { value: null, bad: false };
  let y; let m; let d;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) [, y, m, d] = match.map(Number);
  else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [, d, m, y] = match.map(Number);
  else if (/^\d{5}(\.\d+)?$/.test(s)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return { value: date.toISOString().slice(0, 10), bad: false };
  } else return { value: null, bad: true };
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 2000 || y > 2100) {
    return { value: null, bad: true };
  }
  return { value: date.toISOString().slice(0, 10), bad: false };
}

// Matches names from the sheet ("Khalid", "Khalid H.", "khalid.alhinai@…") to people.
export function matchPeople(text, people) {
  const parts = cleanLine(text).split(/\s*(?:,|،|;|&|\/|\band\b|\s+و\s+)\s*/i).map((p) => p.trim()).filter(Boolean);
  const ids = [];
  const unmatched = [];
  const firstCounts = {};
  for (const p of people) {
    const first = p.name.toLowerCase().split(/\s+/)[0];
    firstCounts[first] = (firstCounts[first] || 0) + 1;
  }
  for (const part of parts) {
    const lower = part.toLowerCase().replace(/\.$/, '');
    let hit = people.find((p) => p.email === lower) || people.find((p) => p.name.toLowerCase() === lower);
    if (!hit) {
      const tokens = lower.split(/\s+/);
      const candidates = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === tokens[0]);
      if (candidates.length === 1 && firstCounts[tokens[0]] === 1) hit = candidates[0];
      else if (candidates.length > 1 && tokens[1]) {
        const initial = tokens[1].replace(/\./g, '').replace(/^al-?/, '').charAt(0);
        const narrowed = candidates.filter((p) => {
          const rest = p.name.toLowerCase().split(/\s+/).slice(1).join(' ').replace(/^al-?/, '');
          return rest.startsWith(initial);
        });
        if (narrowed.length === 1) hit = narrowed[0];
      }
    }
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
    } else unmatched.push(part);
  }
  return { ids, unmatched };
}

// Works out, for every row, what will be imported and what is missing.
export async function buildPreview(job, mapping, people) {
  const openTitles = new Set((await q('SELECT lower(title) AS t FROM tasks WHERE closed_at IS NULL')).rows.map((r) => r.t));
  const seen = new Map();
  const col = (row, field) => (mapping[field] === undefined ? null : row[mapping[field]] ?? '');
  const rows = job.rows.map((row, i) => {
    const rowNumber = i + 2;
    const title = cleanLine(col(row, 'title') ?? '').slice(0, 200);
    const status = mapStatus(col(row, 'status') ?? '');
    const assignee = matchPeople(col(row, 'assignee') ?? '', people);
    const credits = status.closed ? matchPeople(col(row, 'completed_by') ?? '', people) : { ids: [], unmatched: [] };
    const created = parseDate(col(row, 'created_date') ?? '');
    const due = parseDate(col(row, 'due_date') ?? '');
    const warnings = [];
    let kind = 'ready';
    let key = 'import.res.ready';
    const vars = {};
    if (!title) {
      kind = 'skip';
      key = 'import.res.noTitle';
    } else if (openTitles.has(title.toLowerCase())) {
      kind = 'skip';
      key = 'import.res.dupExisting';
    } else if (seen.has(title.toLowerCase())) {
      kind = 'skip';
      key = 'import.res.dupRow';
      vars.row = seen.get(title.toLowerCase());
    }
    if (title && !seen.has(title.toLowerCase())) seen.set(title.toLowerCase(), rowNumber);
    if (kind !== 'skip') {
      if (assignee.unmatched.length) warnings.push({ key: 'import.warn.unmatched', vars: { names: assignee.unmatched.join(', ') } });
      if (credits.unmatched.length) warnings.push({ key: 'import.warn.unmatchedDone', vars: { names: credits.unmatched.join(', ') } });
      if (mapping.created_date !== undefined && !created.value) warnings.push({ key: 'import.warn.noDate' });
      if (due.bad) warnings.push({ key: 'import.warn.badDue' });
      if (status.closed && credits.ids.length === 0) warnings.push({ key: 'import.warn.noCredit' });
      if (warnings.length) kind = 'warn';
    }
    const cells = FIELDS.filter((f) => mapping[f] !== undefined).map((f) => {
      const v = cleanLine(col(row, f) ?? '');
      const notApplicable = f === 'completed_by' && !status.closed && !v;
      return { field: f, text: v, missing: !v && !notApplicable, na: notApplicable };
    });
    return {
      rowNumber, kind, key, vars, warnings, cells,
      task: {
        title,
        description: cleanLine(col(row, 'description') ?? '') ? clean(col(row, 'description')).slice(0, 8000) : '',
        status: status.status,
        closed: status.closed,
        priority: mapPriority(col(row, 'priority') ?? ''),
        due: due.value,
        created: created.value,
        assignees: assignee.ids,
        credits: credits.ids,
        unmatchedAssignee: assignee.unmatched,
        unmatchedCredits: credits.unmatched,
        notes: clean(col(row, 'notes') ?? '').slice(0, 4000),
      },
    };
  });
  const counts = {
    total: rows.length,
    ready: rows.filter((r) => r.kind !== 'skip').length,
    noTitle: rows.filter((r) => r.key === 'import.res.noTitle').length,
    dupes: rows.filter((r) => r.key === 'import.res.dupExisting' || r.key === 'import.res.dupRow').length,
    warnings: rows.filter((r) => r.kind === 'warn').length,
  };
  return { rows, counts };
}

export async function runImport(job, preview, actor, ip, t) {
  const importable = preview.rows.filter((r) => r.kind !== 'skip');
  const count = await tx(async (db) => {
    let n = 0;
    for (const row of importable) {
      const it = row.task;
      const extra = [];
      if (it.unmatchedAssignee.length) extra.push(t('import.note.owner', { names: it.unmatchedAssignee.join(', ') }));
      if (it.unmatchedCredits.length) extra.push(t('import.note.doneBy', { names: it.unmatchedCredits.join(', ') }));
      extra.push(t('import.note.source', { file: job.filename, row: row.rowNumber }));
      const description = [it.description, extra.join('\n')].filter(Boolean).join('\n\n').slice(0, 10000);
      const created = it.created ? `${it.created}T09:00:00+04:00` : null;
      const { rows } = await db.query(
        `INSERT INTO tasks (title, description, status, priority, due_date, creator_id, created_at, imported, closed_at, closed_by, close_reason)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), true,
                 CASE WHEN $8 THEN now() END, CASE WHEN $8 THEN $6::uuid END, CASE WHEN $8 THEN 'completed' END)
         RETURNING id`,
        [it.title, description, it.status, it.priority, it.due, actor.id, created, it.closed],
      );
      const id = rows[0].id;
      if (it.assignees.length) await db.query('INSERT INTO task_assignees (task_id, user_id) SELECT $1, unnest($2::uuid[])', [id, it.assignees]);
      if (it.closed && it.credits.length) await db.query('INSERT INTO task_credits (task_id, user_id) SELECT $1, unnest($2::uuid[])', [id, it.credits]);
      await audit(db, { actorId: actor.id, action: 'task.imported', taskId: id, details: { file: job.filename, row: row.rowNumber }, ip });
      if (it.closed) await audit(db, { actorId: actor.id, action: 'task.closed', taskId: id, details: { reason: 'completed', credited: it.credits, imported: true }, ip });
      if (it.notes) {
        const c = await db.query('INSERT INTO comments (task_id, author_id, body) VALUES ($1, $2, $3) RETURNING id', [id, actor.id, `${t('import.note.notes')}\n${it.notes}`]);
        await audit(db, { actorId: actor.id, action: 'task.commented', taskId: id, details: { comment_id: c.rows[0].id, imported: true }, ip });
      }
      n += 1;
    }
    await audit(db, { actorId: actor.id, action: 'import.completed', details: { file: job.filename, count: n, skipped: preview.rows.length - n }, ip });
    await db.query('DELETE FROM import_jobs WHERE id = $1', [job.id]);
    return n;
  });
  return count;
}
