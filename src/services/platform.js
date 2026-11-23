// The platform admin's work: companies, plans and approvals. Runs across all
// organizations, but only ever reads the organizations table and counts.
// It never reads a company's tasks, comments, files or people.
import { audit } from '../audit.js';
import { asSystem, one, q, scopeTo, tx } from '../db.js';
import { HttpError } from './tasks.js';

export const PLANS = ['hobbyist', 'personal', 'team', 'enterprise', 'custom'];
export const STATUSES = ['pending', 'active', 'suspended', 'rejected'];

// Which status changes are allowed, and the audit action for each.
const MOVES = {
  approve: { from: ['pending'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended', 'rejected'], to: 'active' },
};
export const STATUS_ACTIONS = Object.keys(MOVES);

const ADMIN_COLUMNS = 'id, email, name, status, totp_enabled, totp_secret_enc, totp_last_step, password_changed_at';

export const platformAdminCount = () => one('SELECT count(*)::int AS n FROM platform_admins').then((r) => r.n);
export const findPlatformAdmin = (id) => one(`SELECT ${ADMIN_COLUMNS} FROM platform_admins WHERE id = $1`, [id]);
export const findPlatformAdminByEmail = (email) => one(`SELECT ${ADMIN_COLUMNS}, password_hash FROM platform_admins WHERE email = $1`, [email]);

// The first platform admin, only while there is none.
export async function createFirstPlatformAdmin({ email, name, passwordHash, ip }) {
  return tx(async (db) => {
    await db.query('LOCK TABLE platform_admins IN EXCLUSIVE MODE');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM platform_admins');
    if (rows[0].n > 0) throw new HttpError(404, 'not found');
    const created = (await db.query(
      `INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, $2, $3) RETURNING ${ADMIN_COLUMNS}`,
      [email, name, passwordHash],
    )).rows[0];
    await platformAudit(db, { adminId: created.id, action: 'platform.setup', ip });
    return created;
  });
}

export async function platformAudit(db, { adminId, action, orgId = null, details = {}, ip = null }) {
  await db.query(
    'INSERT INTO platform_audit (admin_id, action, org_id, details, ip) VALUES ($1, $2, $3, $4, $5)',
    [adminId, action, orgId, JSON.stringify(details), ip],
  );
}

// Every company with counts only (people with an account, open tasks).
export function listCompanies() {
  return asSystem(() => q(
    `SELECT o.id, o.name, o.plan, o.status, o.created_at, o.approved_at,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.status = 'active' AND u.email IS NOT NULL) AS people,
            (SELECT count(*)::int FROM tasks t WHERE t.org_id = o.id AND t.closed_at IS NULL) AS open_tasks
     FROM organizations o
     ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'suspended' THEN 2 ELSE 3 END, o.created_at`,
  )).then((r) => r.rows);
}

export async function getCompany(id) {
  const company = await asSystem(() => one(
    `SELECT o.id, o.name, o.plan, o.status, o.created_at, o.approved_at,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.status = 'active' AND u.email IS NOT NULL) AS people,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id AND u.status = 'active' AND u.email IS NULL) AS without_account,
            (SELECT count(*)::int FROM tasks t WHERE t.org_id = o.id AND t.closed_at IS NULL) AS open_tasks,
            (SELECT count(*)::int FROM tasks t WHERE t.org_id = o.id) AS all_tasks
     FROM organizations o WHERE o.id = $1`,
    [id],
  ));
  if (!company) throw new HttpError(404, 'not found');
  const history = await asSystem(() => q(
    `SELECT p.at, p.action, p.details, a.name AS admin_name FROM platform_audit p
     LEFT JOIN platform_admins a ON a.id = p.admin_id
     WHERE p.org_id = $1 ORDER BY p.at DESC LIMIT 50`,
    [id],
  ));
  return { ...company, history: history.rows };
}

// One change to a company: recorded in the platform log and in the company's
// own history, so the company can see what the Mahamm team did.
async function changeCompany(id, admin, ip, apply) {
  return asSystem(() => tx(async (db) => {
    const { rows } = await db.query('SELECT id, name, plan, status FROM organizations WHERE id = $1 FOR UPDATE', [id]);
    const before = rows[0];
    if (!before) throw new HttpError(404, 'not found');
    const change = await apply(db, before);
    if (!change) return before;
    await platformAudit(db, { adminId: admin.id, action: change.action, orgId: id, details: change.details, ip });
    await scopeTo(db, id);
    await audit(db, { action: change.action, details: { ...change.details, by: 'platform' } });
    return change;
  }));
}

export function renameCompany(id, name, admin, ip) {
  return changeCompany(id, admin, ip, async (db, before) => {
    if (before.name === name) return null;
    await db.query('UPDATE organizations SET name = $2 WHERE id = $1', [id, name]);
    return { action: 'org.renamed', details: { from: before.name, to: name } };
  });
}

export function setCompanyPlan(id, plan, admin, ip) {
  if (!PLANS.includes(plan)) throw new HttpError(400, 'bad plan');
  return changeCompany(id, admin, ip, async (db, before) => {
    if (before.plan === plan) return null;
    await db.query('UPDATE organizations SET plan = $2 WHERE id = $1', [id, plan]);
    return { action: 'org.plan_changed', details: { from: before.plan, to: plan } };
  });
}

export function setCompanyStatus(id, move, admin, ip) {
  const rule = MOVES[move];
  if (!rule) throw new HttpError(400, 'bad action');
  return changeCompany(id, admin, ip, async (db, before) => {
    if (!rule.from.includes(before.status)) throw new HttpError(409, 'not allowed now');
    await db.query(
      `UPDATE organizations SET status = $2,
         approved_at = CASE WHEN $3 THEN now() ELSE approved_at END,
         approved_by = CASE WHEN $3 THEN $4::uuid ELSE approved_by END
       WHERE id = $1`,
      [id, rule.to, move === 'approve', admin.id],
    );
    return { action: 'org.status_changed', details: { from: before.status, to: rule.to } };
  });
}

// Is this company open for its people? (Used at sign-in and on every request.)
export async function companyStatus(orgId) {
  const row = await asSystem(() => one('SELECT status FROM organizations WHERE id = $1', [orgId]));
  return row?.status ?? null;
}
