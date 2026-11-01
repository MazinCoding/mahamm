import { z } from 'zod';

// Strip control characters, normalise line endings, trim.
export function clean(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

export function cleanLine(value) {
  return clean(value).replace(/\s+/g, ' ');
}

export function toArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100;
}, 'invalid date');

const taskFields = {
  title: z.preprocess(cleanLine, z.string().min(1).max(200)),
  description: z.preprocess(clean, z.string().max(10000)),
  priority: z.enum(['high', 'med', 'low']),
  due_date: z.preprocess(clean, z.union([z.literal(''), isoDate])),
  labels: z.preprocess(toArray, z.array(z.coerce.number().int().positive()).max(20)),
  assignees: z.preprocess(toArray, z.array(z.string().uuid()).max(30)),
};

export const newTaskSchema = z.object({ ...taskFields, status: z.enum(['backlog', 'todo']) });
export const editTaskSchema = z.object(taskFields);

export const moveSchema = z.object({ status: z.enum(['backlog', 'todo', 'progress', 'review']) });

export const closeSchema = z.object({
  reason: z.enum(['completed', 'notneeded', 'duplicate', 'mistake']),
  credited: z.preprocess(toArray, z.array(z.string().uuid()).max(50)),
  duplicate_of: z.preprocess((v) => cleanLine(v).replace(/^#/, ''), z.union([z.literal(''), z.string().regex(/^\d{1,9}$/)])),
});

// Table ribbon. Buttons send apply="op:value"; the person and date pickers send
// apply="assignee" or "due" with the value in their own field.
const bulkValues = {
  status: z.enum(['backlog', 'todo', 'progress', 'review']),
  priority: z.enum(['high', 'med', 'low']),
  label: z.string().regex(/^\d{1,9}$/),
  assignee: z.string().uuid(),
  due: z.union([z.literal(''), isoDate]),
};

export const bulkSchema = z.preprocess((input) => {
  const body = input && typeof input === 'object' ? input : {};
  const [op, inline = ''] = String(body.apply ?? '').split(':');
  if (op === 'due-clear') return { ids: body.ids, op: 'due', value: '' };
  let value = inline;
  if (op === 'assignee') value = body.assignee;
  // "Set date" with no date is a mistake, not a request to clear it (that has its own button).
  if (op === 'due') value = clean(body.due) || 'missing';
  return { ids: body.ids, op, value: clean(value) };
}, z.object({
  ids: z.preprocess(toArray, z.array(z.coerce.number().int().positive().max(999999999)).min(1).max(50))
    .transform((ids) => [...new Set(ids)]),
  op: z.enum(['status', 'priority', 'label', 'assignee', 'due']),
  value: z.string().max(40),
}).superRefine((v, ctx) => {
  const check = bulkValues[v.op];
  if (check && !check.safeParse(v.value).success) ctx.addIssue({ code: 'custom', path: ['value'], message: 'invalid' });
}));

const bulkIds = z.preprocess(toArray, z.array(z.coerce.number().int().positive().max(999999999)).min(1).max(50))
  .transform((ids) => [...new Set(ids)]);

// Table "Done" page: one credit choice per task, in the same order as the ids.
// An empty choice means "its assignees".
export const bulkCloseSchema = z.object({
  ids: z.preprocess(toArray, z.array(z.coerce.number().int().positive().max(999999999)).min(1).max(50)),
  reason: z.enum(['completed', 'notneeded', 'mistake']),
  credit: z.preprocess(toArray, z.array(z.union([z.literal(''), z.string().uuid()])).max(50)),
});

export const bulkIdsSchema = z.object({ ids: bulkIds });

export const undoSchema = z.object({ batch: z.string().uuid() });

export const commentSchema = z.object({ body: z.preprocess(clean, z.string().min(1).max(5000)) });

export const flagSchema = z.object({
  reason: z.enum(['mistake', 'wrong', 'duplicate', 'other']),
  note: z.preprocess(clean, z.string().max(1000)),
}).refine((v) => v.reason !== 'other' || v.note.length > 0, { path: ['note'], message: 'required' });

export const emailField = z.preprocess((v) => cleanLine(v).toLowerCase(), z.string().max(254).email());

export const inviteSchema = z.object({ email: emailField, role: z.enum(['admin', 'member']) });

export const nameField = z.preprocess(cleanLine, z.string().min(1).max(100));

export const labelSchema = z.object({
  name_en: z.preprocess(cleanLine, z.string().min(1).max(40)),
  name_ar: z.preprocess(cleanLine, z.string().min(1).max(40)),
  color: z.enum(['red', 'blue', 'teal', 'amber', 'purple', 'gray', 'green', 'pink', 'yellow']),
});

export const profileSchema = z.object({
  name: nameField,
  lang: z.enum(['en', 'ar']),
  email_notifications: z.preprocess((v) => v === 'on' || v === 'true', z.boolean()),
});

export const idParam = (value) => (/^\d{1,9}$/.test(String(value)) ? Number(value) : null);
export const uuidParam = (value) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value)) ? String(value) : null);

// Returns { data } or { errors: { field: 'message' } }.
export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return { data: result.data };
  const errors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] ?? 'form';
    if (!errors[key]) errors[key] = issue.message;
  }
  return { errors };
}
