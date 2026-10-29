-- Mahamm schema. Tasks are never deleted; the audit log can only grow.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) <= 254),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  lang text NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'ar')),
  email_notifications boolean NOT NULL DEFAULT true,
  totp_secret_enc text,
  totp_enabled boolean NOT NULL DEFAULT false,
  totp_last_step bigint NOT NULL DEFAULT 0,
  recovery_codes text[] NOT NULL DEFAULT '{}',
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX invites_email_idx ON invites (email);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE labels (
  id serial PRIMARY KEY,
  name_en text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 40),
  name_ar text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 40),
  color text NOT NULL CHECK (color IN ('red', 'blue', 'teal', 'amber', 'purple', 'gray', 'green', 'pink', 'yellow')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO labels (name_en, name_ar, color) VALUES
  ('Bug', 'خلل', 'red'),
  ('Feature', 'ميزة', 'blue'),
  ('IT', 'تقنية المعلومات', 'teal'),
  ('Facilities', 'المرافق', 'amber'),
  ('Office', 'المكتب', 'purple'),
  ('Docs', 'توثيق', 'gray'),
  ('Client', 'عميل', 'green'),
  ('Security', 'أمن', 'pink'),
  ('Design', 'تصميم', 'yellow');

CREATE TABLE tasks (
  id serial PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'progress', 'review')),
  priority text NOT NULL DEFAULT 'med' CHECK (priority IN ('high', 'med', 'low')),
  due_date date,
  creator_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  close_reason text CHECK (close_reason IN ('completed', 'notneeded', 'duplicate', 'mistake')),
  duplicate_of integer REFERENCES tasks(id),
  imported boolean NOT NULL DEFAULT false,
  CHECK ((closed_at IS NULL) = (closed_by IS NULL) AND (closed_at IS NULL) = (close_reason IS NULL))
);
CREATE INDEX tasks_open_idx ON tasks (status) WHERE closed_at IS NULL;
CREATE INDEX tasks_closed_idx ON tasks (closed_at DESC) WHERE closed_at IS NOT NULL;

CREATE TABLE task_assignees (
  task_id integer NOT NULL REFERENCES tasks(id),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id);

CREATE TABLE task_labels (
  task_id integer NOT NULL REFERENCES tasks(id),
  label_id integer NOT NULL REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);

-- Who did the work, as recorded by the person who closed the task.
CREATE TABLE task_credits (
  task_id integer NOT NULL REFERENCES tasks(id),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_credits_user_idx ON task_credits (user_id);

CREATE TABLE comments (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_task_idx ON comments (task_id, created_at);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id integer NOT NULL REFERENCES tasks(id),
  uploader_id uuid NOT NULL REFERENCES users(id),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 160),
  mime text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid REFERENCES users(id)
);
CREATE INDEX attachments_task_idx ON attachments (task_id);

CREATE TABLE flags (
  id serial PRIMARY KEY,
  task_id integer NOT NULL REFERENCES tasks(id),
  flagged_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (reason IN ('mistake', 'wrong', 'duplicate', 'other')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolution text CHECK (resolution IN ('fixed', 'dismissed', 'closed'))
);
CREATE INDEX flags_open_idx ON flags (task_id) WHERE resolved_at IS NULL;

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  task_id integer REFERENCES tasks(id),
  actor_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('assigned', 'review', 'flagged', 'mentioned', 'credited', 'commented')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE email_outbox (
  id bigserial PRIMARY KEY,
  to_email text NOT NULL,
  subject text NOT NULL,
  body_text text,
  body_html text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_pending_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  task_id integer REFERENCES tasks(id),
  subject_user_id uuid REFERENCES users(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text
);
CREATE INDEX audit_events_at_idx ON audit_events (at DESC);
CREATE INDEX audit_events_task_idx ON audit_events (task_id, at);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, at DESC);

-- The audit log is append-only, enforced by the database itself.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  filename text NOT NULL,
  headers jsonb NOT NULL,
  rows jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Session store used by connect-pg-simple.
CREATE TABLE "session" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
