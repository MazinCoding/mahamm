import express from 'express';
import { SCOPES, verifyAccessToken } from '../oauth.js';
import { enforce, limiter } from '../ratelimit.js';
import { captureTasks, teamPeople, undoCapture, updateCaptured } from '../services/capture.js';
import { getWipLimit, inProgressCount } from '../services/settings.js';
import { HttpError } from '../services/tasks.js';
import { captureSchema, connectorUndoSchema, connectorUpdateSchema, parse } from '../validation.js';

// The connector: a small JSON-RPC 2.0 endpoint (Streamable HTTP, stateless,
// JSON responses) that lets a connected app work with Mahamm as the person
// who approved it. Every call carries that person's access token and has
// exactly their rights.

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const INSTRUCTIONS = `Mahamm is the team's task board (English and Arabic).
Use it to capture work as tasks the moment someone mentions it, in a voice note or plain words.
Add tasks straight away with create_tasks; never ask for confirmation first. Capturing the task quickly matters more than complete details.
The team works in the Asia/Muscat time zone; get_team gives today's date there and the team's names.
After adding tasks, say briefly what was added and that it can be undone for one minute.
If a name matched several people or nobody, or a date was unclear, ask one short question and apply the answer with update_task.`;

const priority = { type: 'string', enum: ['high', 'medium', 'low'] };
const date = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD in Asia/Muscat time, or null for none.' };

const TOOLS = [
  {
    name: 'get_team',
    title: 'Team and today',
    description: "Who you are acting for, today's date and weekday in the team's time zone, and the names of everyone tasks can be assigned to. Use it to work out dates such as \"Thursday\" and to spell names the way the team does.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_tasks',
    title: 'Add tasks',
    description: [
      'Add one or more tasks from what the person said or typed. Call it straight away, without asking first; details can be added later.',
      'For each task:',
      '- title: short and clear, in the language the person used.',
      '- assignees: the people who should do it, as named (use the spelling from get_team when you can). Leave it empty if nobody else was named. Never guess a name.',
      '- assign_to_me: true when the person takes the task themselves ("I\'ll…", "me") or says "we" are doing it.',
      '- started: true only when they say the work has started or is under way ("started", "I\'m doing", "we\'re working on"). Otherwise false, and the task goes to To do.',
      '- team_task: true when they say "we" are doing it together. Team tasks are shown to others first so they can join.',
      '- priority: high or low only if they said so; otherwise medium.',
      '- due_date: only if a date was said and is clear; leave it out otherwise.',
      'Set source to "voice" for a voice note.',
      'The result lists, per task, any name that matched nobody or several people under "missing". Ask the person about those, then use update_task. The batch id can undo the whole message for one minute.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['voice', 'text'] },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              assignees: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 10 },
              assign_to_me: { type: 'boolean' },
              started: { type: 'boolean' },
              team_task: { type: 'boolean' },
              priority,
              due_date: date,
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'update_task',
    title: 'Update a task',
    description: 'Change a task after it was added: add people (for example after asking "which Ahmed?"), set or clear the due date, change status, priority, or whether it is a team task. Status can be changed by anyone; other changes need the person to be the creator, an assignee or an admin. Adding someone settles an automatic "No assignee" flag.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', minimum: 1 },
        add_assignees: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 10 },
        status: { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review'] },
        priority,
        due_date: date,
        team_task: { type: 'boolean' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'undo_created_tasks',
    title: 'Undo added tasks',
    description: 'Take back the tasks from one create_tasks call, using its batch id. Works for one minute, only for the person who added them, and only for tasks nobody has changed since. The tasks are closed as "Created by mistake"; history keeps the record.',
    inputSchema: {
      type: 'object',
      properties: { batch: { type: 'string', format: 'uuid' } },
      required: ['batch'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

function inputProblem(errors) {
  return toolError(`Invalid input: ${Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
}

function todayIn(timezone) {
  const now = new Date();
  return {
    today: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
    weekday: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(now),
  };
}

async function callTool(config, name, args, ctx) {
  const { user, ip } = ctx;
  const origin = config.origin;
  switch (name) {
    case 'get_team': {
      const people = await teamPeople();
      return ok({
        you: user.name,
        ...todayIn(config.timezone),
        timezone: config.timezone,
        people: people.map((p) => ({ name: p.name, has_account: p.has_account })),
      });
    }
    case 'create_tasks': {
      const { data, errors } = parse(captureSchema, args);
      if (errors) return inputProblem(errors);
      const result = await captureTasks(data.tasks, user, ip, { source: data.source, origin });
      if (result.tasks.some((t) => t.status === 'in_progress')) {
        const [count, limit] = await Promise.all([inProgressCount(), getWipLimit(config.wipLimit)]);
        if (count > limit) result.warning = `In progress now has ${count} tasks, over the team's limit of ${limit}. The tasks were still added.`;
      }
      return ok(result);
    }
    case 'update_task': {
      const { data, errors } = parse(connectorUpdateSchema, args);
      if (errors) return inputProblem(errors);
      const { task_id: id, ...changes } = data;
      try {
        return ok(await updateCaptured(id, changes, user, ip, { origin }));
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        if (err.status === 404) return toolError(`There is no task #${id}.`);
        if (err.status === 409) return toolError(`Task #${id} is closed.`);
        if (err.status === 403) return toolError(`Only the creator of task #${id}, its assignees or an admin can change those details. Status can still be changed.`);
        throw err;
      }
    }
    case 'undo_created_tasks': {
      const { data, errors } = parse(connectorUndoSchema, args);
      if (errors) return inputProblem(errors);
      const result = await undoCapture(data.batch, user, ip);
      if (result.expired) return toolError('Undo is no longer available: it works for one minute after adding, and only for the person who added the tasks.');
      return ok(result);
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${String(name).slice(0, 50)}`);
  }
}

async function dispatch(config, msg, ctx) {
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mahamm', title: config.appName, version: '1.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      if (typeof params.name !== 'string') throw new RpcError(-32602, 'Missing tool name');
      return callTool(config, params.name, params.arguments && typeof params.arguments === 'object' ? params.arguments : {}, ctx);
    default:
      throw new RpcError(-32601, 'Method not found');
  }
}

export function connectorRoutes(config) {
  const r = express.Router();
  if (!config.oauth.enabled) return r;
  const { resource, issuer } = config.oauth;
  const path = new URL(resource).pathname;
  const metadataUrl = `${config.origin}/.well-known/oauth-protected-resource`;

  const metadata = (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: config.appName,
    });
  };
  r.get('/.well-known/oauth-protected-resource', metadata);
  r.get(`/.well-known/oauth-protected-resource${path}`, metadata);

  r.all(path, limiter({ name: 'connector-ip', limit: 300, windowSeconds: 300, by: 'ip' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Browsers send an Origin; only the site's own is accepted. Apps calling
    // from a server send none.
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) return res.status(403).json({ error: 'origin not allowed' });

    const header = String(req.headers.authorization || '');
    const m = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    const auth = m ? await verifyAccessToken(m[1]) : null;
    const fits = auth && auth.scope.split(' ').includes('tasks') && (!auth.resource || auth.resource === resource);
    if (!fits) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"${header ? ', error="invalid_token"' : ''}`);
      return res.status(401).json({ error: header ? 'invalid_token' : 'unauthorized' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method not allowed' });
    }
    await enforce(`connector:${auth.user.id}`, 120, 300);

    const msg = req.body;
    if (!req.is('application/json') || !msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    // Notifications and replies from the app need no answer.
    if (msg.id === undefined || msg.method === undefined) return res.status(202).end();
    if (typeof msg.method !== 'string') return res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } });
    try {
      const result = await dispatch(config, msg, { user: auth.user, ip: req.ip });
      return res.json({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      if (err instanceof RpcError) return res.json({ jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message } });
      req.log?.error({ err }, 'connector call failed');
      return res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
    }
  });

  return r;
}
