-- Organizations underneath: every company-owned row belongs to an organization,
-- and row-level security keeps organizations apart.
--
-- Backward compatible: org_id defaults to the request's organization, or to
-- organization #1 when none is set (the previous version sets none), and the
-- policies are created but not forced, so the app's own database user is not
-- yet subject to them. Migration 010 forces them once this version is live.

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  plan text NOT NULL DEFAULT 'team' CHECK (plan IN ('hobbyist', 'personal', 'team', 'enterprise', 'custom')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Organization #1 holds everything that exists today. Its real name is set on the site.
INSERT INTO organizations (id, name, plan) VALUES ('00000000-0000-4000-8000-000000000001', 'Organization 1', 'team');

-- The organization of the current request (set per transaction by src/db.js),
-- and the bypass used only by background jobs, migrations and lookups by secret.
CREATE FUNCTION mahamm_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION mahamm_bypass() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.bypass', true), '') = 'on' $$;
CREATE FUNCTION mahamm_default_org() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT coalesce(mahamm_org(), '00000000-0000-4000-8000-000000000001'::uuid) $$;

-- org_id on every company table. A non-volatile default fills existing rows
-- without rewriting them, so the audit log's append-only triggers don't fire.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'invites', 'password_resets', 'trusted_devices',
    'labels', 'tasks', 'task_assignees', 'task_labels', 'task_credits', 'comments', 'attachments', 'flags', 'import_jobs',
    'notifications', 'email_outbox', 'audit_events', 'app_settings',
    'oauth_grants', 'oauth_codes', 'oauth_tokens', 'connector_previews'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN org_id uuid NOT NULL DEFAULT mahamm_default_org() REFERENCES organizations(id)', t);
    EXECUTE format('CREATE INDEX %I ON %I (org_id)', t || '_org_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (mahamm_bypass() OR org_id = mahamm_org()) WITH CHECK (mahamm_bypass() OR org_id = mahamm_org())', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations USING (mahamm_bypass() OR id = mahamm_org()) WITH CHECK (mahamm_bypass());

-- Targets for same-organization links.
ALTER TABLE users ADD CONSTRAINT users_org_id_key UNIQUE (org_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_org_id_key UNIQUE (org_id, id);
ALTER TABLE labels ADD CONSTRAINT labels_org_id_key UNIQUE (org_id, id);
ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_org_id_key UNIQUE (org_id, id);

-- Links between rows must stay inside one organization, even if the code had a bug.
-- (A null column skips the check, as with the existing single-column keys.)
DO $$
DECLARE l text[];
BEGIN
  FOREACH l SLICE 1 IN ARRAY ARRAY[
    ['tasks', 'creator_id', 'users'], ['tasks', 'closed_by', 'users'], ['tasks', 'reviewer_id', 'users'], ['tasks', 'duplicate_of', 'tasks'],
    ['task_assignees', 'task_id', 'tasks'], ['task_assignees', 'user_id', 'users'],
    ['task_labels', 'task_id', 'tasks'], ['task_labels', 'label_id', 'labels'],
    ['task_credits', 'task_id', 'tasks'], ['task_credits', 'user_id', 'users'],
    ['comments', 'task_id', 'tasks'], ['comments', 'author_id', 'users'],
    ['attachments', 'task_id', 'tasks'], ['attachments', 'uploader_id', 'users'], ['attachments', 'removed_by', 'users'],
    ['flags', 'task_id', 'tasks'], ['flags', 'flagged_by', 'users'], ['flags', 'resolved_by', 'users'],
    ['notifications', 'user_id', 'users'], ['notifications', 'task_id', 'tasks'], ['notifications', 'actor_id', 'users'],
    ['invites', 'invited_by', 'users'], ['invites', 'user_id', 'users'],
    ['password_resets', 'user_id', 'users'], ['password_resets', 'created_by', 'users'],
    ['trusted_devices', 'user_id', 'users'],
    ['import_jobs', 'user_id', 'users'],
    ['app_settings', 'updated_by', 'users'],
    ['oauth_grants', 'user_id', 'users'], ['oauth_codes', 'user_id', 'users'], ['oauth_codes', 'grant_id', 'oauth_grants'],
    ['oauth_tokens', 'grant_id', 'oauth_grants'],
    ['connector_previews', 'user_id', 'users'],
    ['audit_events', 'actor_id', 'users'], ['audit_events', 'subject_user_id', 'users'], ['audit_events', 'task_id', 'tasks']
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id, %I) REFERENCES %I (org_id, id)',
      l[1], l[1] || '_' || l[2] || '_org_fk', l[2], l[3]);
  END LOOP;
END $$;

-- Each organization has its own settings. The key-only primary key stays until
-- sign-up exists (phase 2), so the previous version's ON CONFLICT (key) still works.
ALTER TABLE app_settings ADD CONSTRAINT app_settings_org_key UNIQUE (org_id, key);

-- One owner (the "superadmin" level) per organization, instead of one in the whole app.
DROP INDEX users_one_superadmin;
CREATE UNIQUE INDEX users_one_owner ON users (org_id) WHERE role = 'superadmin';
