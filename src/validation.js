import { z } from 'zod';
import { INVITE_ROLES } from './roles.js';

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
export const editTaskSchema = z.object({
  ...taskFields,
  team_task: z.preprocess((v) => v === 'on' || v === true, z.boolean()),
  // '' means nobody; left out keeps the current reviewer.
  reviewer_id: z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable()).optional(),
});

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

// Quick-add row at the bottom of the table: a title, and the column it starts in.
export const quickAddSchema = z.object({
  title: z.preprocess(cleanLine, z.string().min(1).max(200)),
  status: z.enum(['backlog', 'todo']).catch('todo'),
});

// Home composer: just what you're working on.
export const mineSchema = z.object({ title: z.preprocess(cleanLine, z.string().min(1).max(200)) });

// Home details sheet after the composer: everything is chosen first, then sent once.
export const detailsSchema = z.object({
  status: z.enum(['backlog', 'todo', 'progress', 'review', 'done']),
  priority: z.enum(['high', 'med', 'low']),
  labels: z.preprocess(toArray, z.array(z.coerce.number().int().positive().max(999999999)).max(50)),
  assignees: z.preprocess(toArray, z.array(z.string().uuid()).max(50)),
  add_assignee: z.preprocess(clean, z.union([z.literal(''), z.string().uuid()])),
  due_when: z.enum(['none', 'today', 'tomorrow', 'date']),
  due_date: z.preprocess(clean, z.union([z.literal(''), isoDate])),
}).refine((v) => v.due_when !== 'date' || v.due_date !== '', { path: ['due_date'], message: 'pick a date' });

export const wipLimitSchema = z.object({ limit: z.coerce.number().int().min(1).max(50) });

export const commentSchema = z.object({ body: z.preprocess(clean, z.string().min(1).max(5000)) });

export const flagSchema = z.object({
  reason: z.enum(['mistake', 'wrong', 'duplicate', 'other']),
  note: z.preprocess(clean, z.string().max(1000)),
}).refine((v) => v.reason !== 'other' || v.note.length > 0, { path: ['note'], message: 'required' });

export const emailField = z.preprocess((v) => cleanLine(v).toLowerCase(), z.string().max(254).email());

export const inviteSchema = z.object({ email: emailField, role: z.enum(INVITE_ROLES) });
export const roleSchema = z.object({ role: z.enum(INVITE_ROLES) });

export const nameField = z.preprocess(cleanLine, z.string().min(1).max(100));

// A person without an account: just a name.
export const personSchema = z.object({ name: nameField, role: z.enum(INVITE_ROLES).optional() });

export const labelSchema = z.object({
  name_en: z.preprocess(cleanLine, z.string().min(1).max(40)),
  name_ar: z.preprocess(cleanLine, z.string().min(1).max(40)),
  color: z.enum(['red', 'blue', 'teal', 'amber', 'purple', 'gray', 'green', 'pink', 'yellow']),
});

// Skills are typed as one line, separated by commas (English or Arabic).
export const skillList = z.array(z.preprocess(cleanLine, z.string().min(1).max(40))).max(20)
  .transform((list) => list.filter((s, i) => list.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i));
export const profileSchema = z.object({
  name: nameField,
  lang: z.enum(['en', 'ar']),
  email_notifications: z.preprocess((v) => v === 'on' || v === 'true', z.boolean()),
  skills: z.preprocess((v) => String(v ?? '').split(/[,،\n]/).map(cleanLine).filter(Boolean), skillList),
});

// Connected apps (OAuth). These values come from outside apps, so every field is bounded.
const oneOf = (allowed) => z.array(z.string().max(50)).max(5).refine((v) => v.every((x) => allowed.includes(x)), 'not supported');
export const registerClientSchema = z.object({
  client_name: z.preprocess((v) => cleanLine(v ?? 'App').slice(0, 100) || 'App', z.string().min(1).max(100)),
  redirect_uris: z.array(z.string().max(500)).min(1).max(5),
  token_endpoint_auth_method: z.literal('none').optional(),
  grant_types: oneOf(['authorization_code', 'refresh_token']).optional(),
  response_types: oneOf(['code']).optional(),
});

export const authorizeSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().max(64),
  redirect_uri: z.string().max(500),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(1000).optional(),
  scope: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});

export const tokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    client_id: z.string().max(64),
    code: z.string().max(100),
    redirect_uri: z.string().max(500),
    code_verifier: z.string().max(128),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    client_id: z.string().max(64),
    refresh_token: z.string().max(100),
    scope: z.string().max(200).optional(),
  }),
]);

// Connector tools. Values come from an outside app acting for a signed-in person.
const connectorName = z.preprocess(cleanLine, z.string().min(1).max(100));
const connectorDate = z.union([isoDate, z.null()]);
const connectorPriority = z.enum(['high', 'medium', 'low']);
const connectorLabel = z.preprocess(cleanLine, z.string().min(1).max(40));
export const captureSchema = z.object({
  source: z.enum(['voice', 'text']).default('text'),
  tasks: z.array(z.object({
    title: z.preprocess(cleanLine, z.string().min(1).max(200)),
    description: z.preprocess(clean, z.string().max(10000)).optional(),
    labels: z.array(connectorLabel).max(10).default([]),
    assignees: z.array(connectorName).max(10).default([]),
    assign_to_me: z.boolean().default(false),
    started: z.boolean().default(false),
    team_task: z.boolean().default(false),
    priority: connectorPriority.default('medium'),
    due_date: connectorDate.optional(),
  })).min(1).max(50),
});
export const connectorUpdateSchema = z.object({
  task_id: z.number().int().min(1).max(999999999),
  add_assignees: z.array(connectorName).max(10).default([]),
  status: z.enum(['backlog', 'todo', 'in_progress', 'review']).transform((v) => (v === 'in_progress' ? 'progress' : v)).optional(),
  priority: connectorPriority.optional(),
  due_date: connectorDate.optional(),
  team_task: z.boolean().optional(),
});
export const connectorUndoSchema = z.object({ batch: z.string().uuid() });

const taskId = z.number().int().min(1).max(999999999);
const taskIds = z.array(taskId).min(1).max(50).transform((ids) => [...new Set(ids)]);
const names = z.array(connectorName).max(10).default([]);
export const connectorSearchSchema = z.object({
  words: z.array(z.preprocess(cleanLine, z.string().min(1).max(60))).max(8).default([]),
  status: z.array(z.enum(['backlog', 'todo', 'in_progress', 'review', 'done'])).max(5).default([]),
  person: connectorName.optional(),
  unassigned: z.boolean().default(false),
  creator: connectorName.optional(),
  reviewer: connectorName.optional(),
  label: connectorLabel.optional(),
  priority: z.array(connectorPriority).max(3).default([]),
  due: z.enum(['overdue', 'today', 'this_week', 'none']).optional(),
  due_before: isoDate.optional(),
  team_task: z.boolean().optional(),
  flagged: z.boolean().optional(),
  not_updated_for_days: z.number().int().min(1).max(365).optional(),
  closed_within_days: z.number().int().min(1).max(365).default(30),
  sort: z.enum(['priority', 'due', 'updated', 'newest', 'oldest']).default('priority'),
  page: z.number().int().min(1).max(1000).default(1),
});
export const connectorTaskSchema = z.object({ task_id: taskId });
export const connectorActivitySchema = z.object({
  person: connectorName.optional(),
  task_id: taskId.optional(),
  kinds: z.array(z.enum(['created', 'moved', 'edited', 'closed', 'reopened', 'commented', 'flagged', 'files'])).max(8).default([]),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const connectorUpdateManySchema = z.object({
  task_ids: taskIds,
  status: z.enum(['backlog', 'todo', 'in_progress', 'review']).optional(),
  priority: connectorPriority.optional(),
  due_date: connectorDate.optional(),
  add_assignees: names,
  remove_assignees: names,
  add_labels: z.array(connectorLabel).max(10).default([]),
  remove_labels: z.array(connectorLabel).max(10).default([]),
  title: z.preprocess(cleanLine, z.string().min(1).max(200)).optional(),
  description: z.preprocess(clean, z.string().max(10000)).optional(),
  team_task: z.boolean().optional(),
  reviewer: z.union([connectorName, z.null()]).optional(),
}).refine((d) => (d.title === undefined && d.description === undefined) || d.task_ids.length === 1, {
  message: 'title and description can only be changed on one task at a time', path: ['title'],
});
export const connectorCloseSchema = z.object({
  task_ids: taskIds,
  reason: z.enum(['completed', 'not_needed', 'duplicate', 'mistake']),
  credit: names,
  duplicate_of: taskId.optional(),
});
export const connectorCommentSchema = z.object({
  task_id: taskId,
  text: z.preprocess(clean, z.string().min(1).max(4000)),
  mention: names,
  nudge: z.boolean().default(false),
});
export const connectorFlagSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('raise'),
    task_id: taskId,
    reason: z.enum(['mistake', 'wrong', 'duplicate', 'other']),
    note: z.preprocess(clean, z.string().max(1000)).default(''),
  }),
  z.object({
    action: z.literal('resolve'),
    task_id: taskId,
    flag_id: z.number().int().min(1).max(999999999).optional(),
    resolution: z.enum(['fixed', 'dismissed']),
  }),
]);
export const connectorReadSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ notification_ids: z.array(z.number().int().min(1)).min(1).max(100) }),
]);

export const connectorAdminSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_person'), name: connectorName }),
  z.object({ action: z.literal('set_in_progress_limit'), limit: z.number().int().min(1).max(50) }),
]);
export const connectorConfirmSchema = z.object({ preview_id: z.string().uuid(), secret: z.string().min(20).max(100) });
export const connectorCancelSchema = z.object({ preview_id: z.string().uuid() });
export const connectorSuggestSchema = z.object({ limit: z.number().int().min(1).max(10).default(5) });
export const connectorSkillsSchema = z.object({ skills: skillList, mode: z.enum(['add', 'remove', 'replace']).default('add') });

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
