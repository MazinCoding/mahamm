-- People without accounts: an admin adds someone by name so tasks can be
-- assigned to and credited to them now. They get an email and a password when
-- they accept an invite tied to them, on the same row, so nothing moves.
--
-- An account is exactly "email and password both set". Rows without one are
-- always members with email notifications off, which also keeps older code
-- (during a deploy or after a rollback) from queueing email to nobody.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD CONSTRAINT users_account_pair
  CHECK ((email IS NULL) = (password_hash IS NULL));

ALTER TABLE users ADD CONSTRAINT users_no_account_limits
  CHECK (email IS NOT NULL OR (role = 'member' AND NOT totp_enabled AND NOT email_notifications));

-- An invite can be for a person already on the list.
ALTER TABLE invites ADD COLUMN user_id uuid REFERENCES users(id);
CREATE INDEX invites_user_idx ON invites (user_id) WHERE user_id IS NOT NULL;
