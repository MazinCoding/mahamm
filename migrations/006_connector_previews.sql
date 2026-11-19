-- Changes asked for through a connected app that wait for the person to
-- confirm them: more than a few tasks at once, taking someone else off a task,
-- many new tasks at once, and admin changes. The person confirms on a button
-- shown with the reply (which presents a secret the app never shows as text;
-- only its hash is kept) or on Mahamm's own page. A preview can be used once,
-- only by the person it was made for, and only until it expires. Expired rows
-- are tidied up by the hourly cleanup job.

CREATE TABLE connector_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('update', 'close', 'create', 'admin')),
  payload jsonb NOT NULL,
  summary jsonb NOT NULL,
  secret_hash text NOT NULL CHECK (char_length(secret_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  outcome text CHECK (outcome IN ('confirmed', 'cancelled')),
  CHECK ((used_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX connector_previews_user_idx ON connector_previews (user_id, created_at DESC);
CREATE INDEX connector_previews_expires_idx ON connector_previews (expires_at);
