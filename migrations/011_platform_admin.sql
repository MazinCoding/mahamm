-- The platform admin: runs the whole app (companies, plans, approvals) and is
-- not part of any organization. Separate accounts, separate sign-in.

CREATE TABLE platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) <= 254),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  password_hash text NOT NULL,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  totp_last_step bigint NOT NULL DEFAULT 0,
  recovery_codes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- What the platform admin did, across all companies. Append-only, like audit_events.
CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  admin_id uuid REFERENCES platform_admins(id),
  action text NOT NULL,
  org_id uuid REFERENCES organizations(id),
  details jsonb NOT NULL DEFAULT '{}',
  ip inet
);
CREATE INDEX platform_audit_at_idx ON platform_audit (at DESC);

CREATE FUNCTION platform_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit is append-only';
END;
$$;
CREATE TRIGGER platform_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON platform_audit
  FOR EACH ROW EXECUTE FUNCTION platform_audit_append_only();
CREATE TRIGGER platform_audit_no_truncate
  BEFORE TRUNCATE ON platform_audit
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_append_only();

-- Companies can wait for approval (sign-up, phase 2c) or be turned down.
ALTER TABLE organizations DROP CONSTRAINT organizations_status_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('pending', 'active', 'suspended', 'rejected'));
ALTER TABLE organizations ADD COLUMN approved_at timestamptz;
ALTER TABLE organizations ADD COLUMN approved_by uuid REFERENCES platform_admins(id);
UPDATE organizations SET approved_at = created_at WHERE status = 'active';
