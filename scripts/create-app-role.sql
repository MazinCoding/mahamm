-- Optional least-privilege setup for self-hosting. Run once as the database owner
-- after migrations, then point DATABASE_URL at the new role and keep the owner
-- account in MIGRATION_DATABASE_URL for future migrations only.
--
--   psql "$MIGRATION_DATABASE_URL" -v app_password="'a-long-random-password'" -f scripts/create-app-role.sql

CREATE ROLE mahamm_app LOGIN PASSWORD :app_password;
GRANT CONNECT ON DATABASE mahamm TO mahamm_app;
GRANT USAGE ON SCHEMA public TO mahamm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mahamm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mahamm_app;
-- The app can only add audit entries, never change or remove them.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM mahamm_app;
-- Tasks, comments and flags are never deleted by the app either.
REVOKE DELETE, TRUNCATE ON tasks, comments, flags, attachments, users FROM mahamm_app;
