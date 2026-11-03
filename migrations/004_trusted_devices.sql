-- Remembered devices: after a correct two-step code, a person can ask this
-- browser to be remembered so later sign-ins there need only the password.
-- The browser holds a random token; only its SHA-256 hash is stored here.
--
-- A device stops working when it expires, when it is forgotten (by the person,
-- or automatically on a password change or reset, turning off two-step, or the
-- account being disabled), or when the person's role makes its period shorter.
-- Old rows are tidied up by the hourly cleanup job, like sessions.

CREATE TABLE trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL CHECK (char_length(label) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  forgotten_at timestamptz
);

CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id) WHERE forgotten_at IS NULL;
