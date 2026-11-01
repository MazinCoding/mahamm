-- Team-wide settings that admins change in the app (the in-progress limit first).
-- A missing row means "use the server's default", so older code keeps working.
CREATE TABLE app_settings (
  key text PRIMARY KEY CHECK (key IN ('wip_limit')),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
