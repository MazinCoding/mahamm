-- Connected apps: a person can let an outside app use Mahamm on their behalf
-- (standard OAuth 2.1 authorization code flow with PKCE). The app never sees
-- the person's password; it gets short-lived access tokens and a refresh token.
-- Only SHA-256 hashes of codes and tokens are stored.
--
-- A connection (grant) ends when the person disconnects it in Settings, on a
-- password change or reset, or when the account is disabled. Expired rows are
-- tidied up by the hourly cleanup job.

CREATE TABLE oauth_clients (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 16 AND 64),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES oauth_clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK (char_length(scope) <= 200),
  resource text CHECK (char_length(resource) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_client_idx ON oauth_grants (client_id);

-- Single-use, short-lived authorization codes. grant_id is set when the code
-- is exchanged, so a replayed code can end the connection it created.
CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) <= 500),
  code_challenge text NOT NULL CHECK (char_length(code_challenge) BETWEEN 43 AND 128),
  scope text NOT NULL CHECK (char_length(scope) <= 200),
  resource text CHECK (char_length(resource) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  grant_id uuid REFERENCES oauth_grants(id)
);
CREATE INDEX oauth_codes_client_idx ON oauth_codes (client_id);

CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id),
  kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);

-- Team tasks: work several people are doing together. They are shown first
-- among tasks of the same priority in Suggested, so others can join them.
ALTER TABLE tasks ADD COLUMN team_task boolean NOT NULL DEFAULT false;
