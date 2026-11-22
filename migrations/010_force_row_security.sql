-- Row-level security now applies to the app's own database user too (it owns
-- the tables, so until now it saw every organization). From here on each
-- request only sees its organization; background jobs and migrations use the
-- explicit bypass (see src/db.js and scripts/migrate.js).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'users', 'invites', 'password_resets', 'trusted_devices',
    'labels', 'tasks', 'task_assignees', 'task_labels', 'task_credits', 'comments', 'attachments', 'flags', 'import_jobs',
    'notifications', 'email_outbox', 'audit_events', 'app_settings',
    'oauth_grants', 'oauth_codes', 'oauth_tokens', 'connector_previews'
  ] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
