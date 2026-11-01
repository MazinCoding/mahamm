# Mahamm (مهام) — team task board

An invite-only task board with a complete audit trail, built to replace a shared Excel sheet.

- **Board and list views** of the same tasks: Backlog → To do → In progress → Review → Done, with a work-in-progress limit.
- **Close and credit**: whoever closes a task picks who actually did the work. Both are recorded.
- **Flags**: anyone can flag a task that was created by mistake or has wrong details; the creator or an admin resolves it.
- **Nothing is deleted.** Tasks are closed, files are hidden, and the audit log is append-only at the database level.
- **English and Arabic**, with a right-to-left layout.
- **Attachments**, comments with @mentions, in-app notifications and optional email.
- **Excel/CSV import** with column matching and a preview that marks missing values instead of guessing.
- **Security**: invite-only accounts, Argon2id passwords, two-step verification (required for admins), CSRF protection, strict CSP, rate limits.

Stack: Node.js 22, Express 5, server-rendered Nunjucks templates, PostgreSQL. No front-end build step.

## Deploy on Render (easiest)

1. Push this folder to a **private** GitHub repository.
2. In Render: **New → Blueprint**, connect GitHub, pick the repository, and click **Apply**. Render reads `render.yaml` and creates the web service and a private database in Frankfurt.
3. When it asks for the `SMTP_*` values, leave them empty for now (see Email below).
4. When the deploy is live, open **Environment** on the `mahamm` service and copy the value of `SETUP_TOKEN`.
5. Visit `https://<your-service>.onrender.com/setup`, paste the token, and create the first admin account. Set up two-step verification when asked and save the recovery codes.
6. Back in **Environment**, delete `SETUP_TOKEN` (the setup page is already switched off once an account exists).
7. Invite your coworkers from **People**. Without email set up, each invite link is shown once for you to send yourself (WhatsApp works fine).
8. Optional: **Import** your current Excel sheet. The preview shows exactly what will happen to each row before anything is saved.

**Free plan limits (trial only).** The free web service sleeps after 15 minutes without visitors and takes about a minute to wake. The free database is deleted 30 days after creation (plus a 14-day grace period) and has no backups. Before people rely on it, upgrade both in the Render dashboard; the smallest paid web service is $7/month and the smallest paid database $6/month at the time of writing.

### Custom domain
Add it under the service's **Settings → Custom Domains**, then set `APP_URL=https://tasks.yourcompany.om` so links in emails use it.

## Email (optional)

Set all five `SMTP_*` variables or none. With Gmail or Google Workspace:

| Variable | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | the full Gmail address |
| `SMTP_PASS` | a 16-character **app password** (needs 2-Step Verification on that Google account) |
| `SMTP_FROM` | `Mahamm <that address>` |

Personal Outlook.com accounts are removing password-based SMTP in favour of OAuth, so Gmail is the dependable choice for now. Free Gmail allows about 500 recipients a day, which is plenty for 30–50 people.

## Self-hosting with Docker

```bash
cp .env.example .env   # fill in APP_URL, secrets, POSTGRES_PASSWORD, optional SMTP
docker compose up -d
```

Put an HTTPS reverse proxy in front of `127.0.0.1:3000`. The database port is not published. For a least-privilege database user, see `scripts/create-app-role.sql`.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Local development

```bash
npm install
npm run build                 # copies the self-hosted fonts
cp .env.example .env          # set DATABASE_URL, SESSION_SECRET, DATA_ENCRYPTION_KEY, SETUP_TOKEN
npm run migrate
npm run dev
```

Tests need a Postgres database they can wipe: `TEST_DATABASE_URL=postgres://… npm test`.

For a demo with sample people and tasks, run `DEMO_PASSWORD=<12+ chars> npm run seed:demo` against an **empty development** database (it refuses to run in production). Accounts are `ahmed@example.com`, `fatma@example.com` and so on.

GitHub Actions runs the tests, a browser walk-through with screenshots, `npm audit` and a full-history secret scan on every push; results are kept as a downloadable artifact for 14 days.

## Backups

Paid Render databases include daily backups. When self-hosting, schedule `pg_dump` and **test a restore** at least once. Keep dumps out of the repository (`.gitignore` covers `*.dump`, `*.sql.gz`).

## Where things live

| Path | What |
|---|---|
| `src/routes/` | Pages and actions (auth, tasks, admin, personal settings) |
| `src/services/` | Database logic for tasks, people and imports |
| `migrations/` | Schema, applied in order on every start |
| `views/`, `public/` | Templates, CSS and the small script for drag and drop |
| `locales/` | English and Arabic text |
| `test/` | Integration tests against a real database |
