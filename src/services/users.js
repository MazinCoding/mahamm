import { audit } from '../audit.js';
import { hashToken, newToken } from '../crypto.js';
import { one, q, tx } from '../db.js';
import { hashPassword } from '../passwords.js';
import { signOutEverywhere } from '../auth.js';
import { HttpError } from './tasks.js';

const INVITE_HOURS = 72;

export async function userCount() {
  return (await one('SELECT count(*)::int AS n FROM users')).n;
}

export async function activePeople() {
  const { rows } = await q(`SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name`);
  return rows;
}

export async function allPeopleNames() {
  const { rows } = await q('SELECT id, name, status FROM users ORDER BY name');
  return rows;
}

// Exact names (ignoring case) must be unique among active people, so pickers,
// @mentions and import matching never have to guess between two "Khalid Al-Hinai"s.
async function assertNameFree(db, name, exceptId = null) {
  const { rows } = await db.query(
    `SELECT 1 FROM users WHERE status = 'active' AND lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`,
    [name, exceptId],
  );
  if (rows[0]) throw new HttpError(409, 'name taken');
}

// Adds someone by name only. They can be assigned and credited straight away,
// and get an account later through an invite tied to them.
export async function addPerson(name, actor, ip) {
  return tx(async (db) => {
    await assertNameFree(db, name);
    const { rows } = await db.query(
      `INSERT INTO users (name, email_notifications) VALUES ($1, false) RETURNING id, name`,
      [name],
    );
    await audit(db, { actorId: actor.id, action: 'person.added', subjectUserId: rows[0].id, details: { name }, ip });
    return rows[0];
  });
}

// Used by the Excel import: reuses an active person with exactly this name
// (ignoring case), otherwise adds them without an account.
export async function findOrAddPerson(db, name, actor, ip, details = {}) {
  const { rows } = await db.query(`SELECT id FROM users WHERE status = 'active' AND lower(name) = lower($1)`, [name]);
  if (rows[0]) return { id: rows[0].id, added: false };
  const created = (await db.query(`INSERT INTO users (name, email_notifications) VALUES ($1, false) RETURNING id`, [name])).rows[0];
  await audit(db, { actorId: actor.id, action: 'person.added', subjectUserId: created.id, details: { name, ...details }, ip });
  return { id: created.id, added: true };
}

// Only names of people without an account; people with one set their own.
export async function renamePerson(userId, name, actor, ip) {
  return tx(async (db) => {
    const { rows } = await db.query('SELECT id, name, email FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const target = rows[0];
    if (!target) throw new HttpError(404, 'user not found');
    if (target.email !== null) throw new HttpError(409, 'has account');
    if (target.name === name) return;
    await assertNameFree(db, name, userId);
    await db.query('UPDATE users SET name = $2 WHERE id = $1', [userId, name]);
    await audit(db, { actorId: actor.id, action: 'person.renamed', subjectUserId: userId, details: { from: target.name, to: name }, ip });
  });
}

// `userId` ties the invite to a person without an account; accepting it gives
// that person their email and password instead of creating someone new.
export async function createInvite(email, role, actor, ip, userId = null) {
  return tx(async (db) => {
    if (userId) {
      const { rows } = await db.query('SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!rows[0]) throw new HttpError(404, 'user not found');
      if (rows[0].email !== null) throw new HttpError(409, 'has account');
      if (rows[0].status !== 'active') throw new HttpError(409, 'person disabled');
    }
    const existing = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existing.rows[0]) throw new HttpError(409, 'already a member');
    await db.query(
      `UPDATE invites SET revoked_at = now()
       WHERE (email = $1 OR ($2::uuid IS NOT NULL AND user_id = $2)) AND accepted_at IS NULL AND revoked_at IS NULL`,
      [email, userId],
    );
    const token = newToken();
    const { rows } = await db.query(
      `INSERT INTO invites (email, role, token_hash, invited_by, expires_at, user_id)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6) RETURNING id, email, role, expires_at`,
      [email, role, hashToken(token), actor.id, INVITE_HOURS, userId],
    );
    const details = { invite_id: rows[0].id, email, role };
    if (userId) details.user_id = userId;
    await audit(db, { actorId: actor.id, action: 'user.invited', subjectUserId: userId, details, ip });
    return { token, invite: rows[0] };
  });
}

// An invite for a person stops working if that person was disabled or already joined.
const LIVE_INVITE = `i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  AND (i.user_id IS NULL OR (p.email IS NULL AND p.status = 'active'))`;

export async function findInvite(token) {
  return one(
    `SELECT i.id, i.email, i.role, i.expires_at, i.user_id, u.name AS invited_by_name, p.name AS person_name
     FROM invites i JOIN users u ON u.id = i.invited_by LEFT JOIN users p ON p.id = i.user_id
     WHERE i.token_hash = $1 AND ${LIVE_INVITE}`,
    [hashToken(token)],
  );
}

const ACCOUNT_COLUMNS = 'id, email, name, role, status, lang, totp_enabled, password_changed_at';

export async function acceptInvite(token, { name, password }, ip) {
  const passwordHash = await hashPassword(password);
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT id, email, role, user_id FROM invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashToken(token)],
    );
    const invite = rows[0];
    if (!invite) throw new HttpError(410, 'invite not valid');
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [invite.email]);
    if (exists.rows[0]) throw new HttpError(409, 'already a member');
    let user;
    const details = { invite_id: invite.id };
    if (invite.user_id) {
      const person = (await db.query('SELECT id, name, email, status FROM users WHERE id = $1 FOR UPDATE', [invite.user_id])).rows[0];
      if (!person || person.email !== null || person.status !== 'active') throw new HttpError(410, 'invite not valid');
      if (person.name !== name) await assertNameFree(db, name, person.id);
      user = (await db.query(
        `UPDATE users SET email = $2, name = $3, password_hash = $4, role = $5,
           email_notifications = true, password_changed_at = now()
         WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
        [person.id, invite.email, name, passwordHash, invite.role],
      )).rows[0];
      details.existing_person = true;
      if (person.name !== name) details.name_from = person.name;
    } else {
      user = (await db.query(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${ACCOUNT_COLUMNS}`,
        [invite.email, name, passwordHash, invite.role],
      )).rows[0];
    }
    await db.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
    await audit(db, { actorId: user.id, action: 'invite.accepted', subjectUserId: user.id, details, ip });
    return user;
  });
}

export async function revokeInvite(inviteId, actor, ip) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email',
      [inviteId],
    );
    if (!rows[0]) throw new HttpError(404, 'invite not found');
    await audit(db, { actorId: actor.id, action: 'invite.revoked', details: { invite_id: inviteId, email: rows[0].email }, ip });
  });
}

export async function createReset(userId, createdBy, hours, ip) {
  return tx(async (db) => {
    await db.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    const token = newToken();
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [userId, hashToken(token), createdBy, hours],
    );
    if (createdBy) await audit(db, { actorId: createdBy, action: 'user.reset_link_created', subjectUserId: userId, ip });
    return token;
  });
}

export async function findReset(token) {
  return one(
    `SELECT r.id, r.user_id, u.email, u.name FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active' AND u.email IS NOT NULL`,
    [hashToken(token)],
  );
}

export async function completeReset(token, password, ip) {
  const passwordHash = await hashPassword(password);
  const userId = await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT r.id, r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active'
         AND u.email IS NOT NULL FOR UPDATE OF r`,
      [hashToken(token)],
    );
    const reset = rows[0];
    if (!reset) throw new HttpError(410, 'reset not valid');
    await db.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
    await db.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [reset.user_id, passwordHash]);
    await audit(db, { actorId: reset.user_id, action: 'auth.password_reset', subjectUserId: reset.user_id, ip });
    return reset.user_id;
  });
  await signOutEverywhere(userId);
  return userId;
}

// There must always be at least one active admin.
async function assertAnotherAdmin(db, userId) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1`, [userId],
  );
  if (rows[0].n === 0) throw new HttpError(409, 'last admin');
}

export async function changeRole(userId, role, actor, ip) {
  return tx(async (db) => {
    const { rows } = await db.query('SELECT id, role, email FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const target = rows[0];
    if (!target) throw new HttpError(404, 'user not found');
    if (target.email === null) throw new HttpError(409, 'has no account');
    if (target.role === role) return;
    if (target.id === actor.id) throw new HttpError(409, 'cannot change own role');
    if (target.role === 'admin') await assertAnotherAdmin(db, userId);
    // A new admin is sent to two-step setup on their next request (see enforceAdminTwoFactor).
    await db.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
    await audit(db, { actorId: actor.id, action: 'user.role_changed', subjectUserId: userId, details: { from: target.role, to: role }, ip });
  });
}

export async function setStatus(userId, status, actor, ip) {
  await tx(async (db) => {
    const { rows } = await db.query('SELECT id, name, email, role, status FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const target = rows[0];
    if (!target) throw new HttpError(404, 'user not found');
    if (target.status === status) return;
    if (status === 'active' && target.email === null) await assertNameFree(db, target.name, userId);
    if (target.id === actor.id) throw new HttpError(409, 'cannot disable yourself');
    if (status === 'disabled' && target.role === 'admin') await assertAnotherAdmin(db, userId);
    await db.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
    await audit(db, { actorId: actor.id, action: status === 'disabled' ? 'user.disabled' : 'user.enabled', subjectUserId: userId, ip });
  });
  if (status === 'disabled') await signOutEverywhere(userId);
}

export async function peopleOverview() {
  const users = (await q(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.totp_enabled, u.last_seen_at, u.created_at,
       u.email IS NULL AS no_account,
       (SELECT count(*)::int FROM task_credits tc WHERE tc.user_id = u.id) AS completed
     FROM users u ORDER BY u.status, u.name`,
  )).rows;
  const invites = (await q(
    `SELECT i.id, i.email, i.role, i.expires_at, i.created_at, u.name AS invited_by_name, p.name AS person_name
     FROM invites i JOIN users u ON u.id = i.invited_by LEFT JOIN users p ON p.id = i.user_id
     WHERE ${LIVE_INVITE} ORDER BY i.created_at DESC`,
  )).rows;
  return { users, invites };
}
