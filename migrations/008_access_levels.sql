-- Access levels: superadmin, executive, admin, member and trainee (see src/roles.js).
-- Only widens what's allowed, so the previous version keeps running during a deploy.

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('superadmin', 'executive', 'admin', 'member', 'trainee'));

ALTER TABLE invites DROP CONSTRAINT invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check
  CHECK (role IN ('executive', 'admin', 'member', 'trainee'));

-- People without accounts can now hold any level but superadmin; it takes effect
-- when they accept their invite. They still get no email and no two-step.
ALTER TABLE users DROP CONSTRAINT users_no_account_limits;
ALTER TABLE users ADD CONSTRAINT users_no_account_limits
  CHECK (email IS NOT NULL OR (role <> 'superadmin' AND NOT totp_enabled AND NOT email_notifications));

-- There is at most one superadmin.
CREATE UNIQUE INDEX users_one_superadmin ON users (role) WHERE role = 'superadmin';

-- The account that set the site up becomes the superadmin, if it is still an
-- active admin. Recorded in the audit log as a change made by the system.
WITH owner AS (
  SELECT u.id FROM audit_events e JOIN users u ON u.id = e.subject_user_id
  WHERE e.action = 'setup.completed' AND u.role = 'admin' AND u.status = 'active' AND u.email IS NOT NULL
  ORDER BY e.at LIMIT 1
), promoted AS (
  UPDATE users SET role = 'superadmin' WHERE id IN (SELECT id FROM owner) RETURNING id
)
INSERT INTO audit_events (actor_id, action, subject_user_id, details)
SELECT NULL, 'user.role_changed', id, '{"from": "admin", "to": "superadmin", "auto": "setup_account"}'::jsonb FROM promoted;
