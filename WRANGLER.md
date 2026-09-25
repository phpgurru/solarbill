# Wrangler commands for SolarHisaab

Every Cloudflare command you need to set up, run, deploy and maintain SolarHisaab, in the order you'll use them.

- Run all commands from the project folder: `cd /var/www/solarbill`
- The Wrangler version is pinned in `package.json` (v4), so use `npx wrangler …` and not a global install.
- Project names used below:

| What | Name |
|---|---|
| Worker | `solarhisaab` |
| D1 database | `solarhisaab` |
| R2 bucket | `solarhisaab-bills` |

> **Wrangler v4 defaults to local.** `d1 execute` and `r2 object` act on your *local* copy unless you add `--remote`. Every production command below includes `--remote` explicitly.

---

## Quick start: first deploy

The full sequence at a glance. Each step is explained in the sections below.

```bash
cd /var/www/solarbill
npm install
npx wrangler login

npx wrangler d1 create solarhisaab                 # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create solarhisaab-bills

npx wrangler secret put RESEND_API_KEY
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET

npx wrangler d1 migrations apply solarhisaab --remote
npx wrangler deploy
```

---

## 1. Install and sign in

```bash
npm install                      # installs the pinned Wrangler
npx wrangler --version
npx wrangler login               # opens the browser to authorise Wrangler
npx wrangler whoami              # shows the account and token permissions
npx wrangler logout
```

If you have several Cloudflare accounts, `whoami` lists their IDs. Pick one for a single command with an environment variable:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> npx wrangler deploy
```

---

## 2. Create the database and bucket (once)

```bash
npx wrangler d1 create solarhisaab
npx wrangler r2 bucket create solarhisaab-bills
```

`d1 create` prints a `database_id`. Paste it into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "solarhisaab", "database_id": "PASTE-IT-HERE", "migrations_dir": "migrations" }
]
```

To check what exists:

```bash
npx wrangler d1 list
npx wrangler d1 info solarhisaab
npx wrangler r2 bucket list
```

Optional: pin the R2 bucket to the Asia-Pacific location hint (only when creating it):

```bash
npx wrangler r2 bucket create solarhisaab-bills --location apac
```

---

## 3. Settings in `wrangler.jsonc`

These are plain variables committed with the code. Edit them before the first deploy:

| Variable | Set it to |
|---|---|
| `APP_URL` | `https://yourdomain.pk` |
| `APP_NAME` | `SolarHisaab` or your brand |
| `EMAIL_FROM` | `SolarHisaab <hello@yourdomain.pk>`, which must be on a domain verified in Resend |
| `ADMIN_EMAILS` | your email; comma-separate several |
| `DEV_MODE` | keep `"0"` in production |

To serve the app on your domain, uncomment the `routes` block. The domain must already be in your Cloudflare account.

```jsonc
,"routes": [
  { "pattern": "yourdomain.pk", "custom_domain": true },
  { "pattern": "www.yourdomain.pk", "custom_domain": true }
]
```

Cloudflare creates the DNS records and certificate on the next `npx wrangler deploy`.

---

## 4. Secrets (never commit these)

```bash
npx wrangler secret put RESEND_API_KEY        # paste the key from resend.com when prompted
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET

npx wrangler secret list                      # shows names only, never values
npx wrangler secret delete RESEND_API_KEY
```

- Changing a secret takes effect immediately, with no redeploy.
- Changing `SESSION_SECRET` invalidates unsubscribe links in emails already sent. Sign-ins are not affected.

For local development, secrets go in `.dev.vars` (git-ignored) instead:

```bash
cp .dev.vars.example .dev.vars
```

---

## 5. Database migrations

Migrations live in `migrations/` and run in filename order. D1 records which ones have been applied.

```bash
# See which migrations are pending
npx wrangler d1 migrations list solarhisaab --local
npx wrangler d1 migrations list solarhisaab --remote

# Apply them
npx wrangler d1 migrations apply solarhisaab --local      # your machine
npx wrangler d1 migrations apply solarhisaab --remote     # production
```

The same commands are available as npm scripts:

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

To change the schema later, create a new migration instead of editing `0001_init.sql`:

```bash
npx wrangler d1 migrations create solarhisaab add_meter_notes
# edit migrations/0002_add_meter_notes.sql, then apply --local, test, and apply --remote
```

The GitHub Actions workflow runs `migrations apply --remote` before every deploy, so pushing a new migration to `main` applies it automatically.

---

## 6. Run locally

```bash
cp .dev.vars.example .dev.vars          # first time only
npm run db:migrate:local                # first time, and after new migrations
npx wrangler dev                        # http://localhost:8787
```

Useful options:

```bash
npx wrangler dev --port 8788
npx wrangler dev --ip 0.0.0.0           # reach it from your phone on the same Wi-Fi
npx wrangler dev --test-scheduled       # lets you fire the cron by hand (see section 10)
```

- **Local data** (D1 rows and R2 PDFs) lives in `.wrangler/state/`. Delete that folder to start fresh, then re-run `npm run db:migrate:local`.
- **Sign-in:** with `DEV_MODE=1` and no `RESEND_API_KEY`, the sign-in dialog shows the magic link on screen. Open the site at `http://localhost:8787`, not `127.0.0.1`, so the secure cookie is accepted.

Avoid `npx wrangler dev --remote`. It runs your local code against the **production** database and bucket.

---

## 7. Deploy

```bash
npx wrangler deploy --dry-run --outdir .wrangler/dry    # build only: checks bundling and bindings
npx wrangler deploy                                     # publish the Worker and the /public site
npm run check                                           # syntax check + dry run, same as CI
```

Deploy history and rollback:

```bash
npx wrangler deployments list
npx wrangler versions list
npx wrangler rollback                    # back to the previous version (asks for a reason)
npx wrangler rollback <version-id>       # back to a specific version
```

A rollback restores the **code only**. Database migrations and data are not rolled back.

Gradual rollout (optional): upload a version without sending it traffic, then shift traffic in steps.

```bash
npx wrangler versions upload
npx wrangler versions deploy             # interactive: choose versions and percentages
```

---

## 8. Live logs

```bash
npx wrangler tail                         # stream every request and console.log
npx wrangler tail --format pretty
npx wrangler tail --status error          # failures only
npx wrangler tail --method POST           # e.g. uploads and sign-ins
npx wrangler tail --search "reminders:"   # the daily cron summary line
```

Logs are also kept in the dashboard (**Workers → solarhisaab → Logs**), because `observability` is enabled in `wrangler.jsonc`.

---

## 9. Query and manage the database

Run SQL against production:

```bash
npx wrangler d1 execute solarhisaab --remote --command "SELECT COUNT(*) AS users FROM users"
npx wrangler d1 execute solarhisaab --remote --file ./query.sql
```

Swap `--remote` for `--local` to query your dev copy.

### Handy queries

```bash
# Users, meters, bills
npx wrangler d1 execute solarhisaab --remote --command \
  "SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM meters) meters, (SELECT COUNT(*) FROM bills) bills"

# Bills uploaded per bill month
npx wrangler d1 execute solarhisaab --remote --command \
  "SELECT month, COUNT(*) n FROM bills GROUP BY month ORDER BY month DESC LIMIT 12"

# Meters per DISCO
npx wrangler d1 execute solarhisaab --remote --command \
  "SELECT COALESCE(disco,'Unknown') disco, COUNT(*) meters FROM meters GROUP BY disco ORDER BY meters DESC"

# Look up one user and their meters (support requests)
npx wrangler d1 execute solarhisaab --remote --command \
  "SELECT u.id, u.email, u.reminders, m.consumer_id, m.label FROM users u LEFT JOIN meters m ON m.user_id = u.id WHERE u.email = 'someone@example.com'"

# Sign a user out everywhere
npx wrangler d1 execute solarhisaab --remote --command \
  "DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'someone@example.com')"

# Turn off reminders for a user
npx wrangler d1 execute solarhisaab --remote --command \
  "UPDATE users SET reminders = 0 WHERE email = 'someone@example.com'"

# Who was reminded this month
npx wrangler d1 execute solarhisaab --remote --command \
  "SELECT COUNT(*) FROM reminder_log WHERE month = strftime('%Y-%m','now')"

# Housekeeping: old sign-in tokens and expired sessions (the app also does this on each sign-in)
npx wrangler d1 execute solarhisaab --remote --command \
  "DELETE FROM login_tokens WHERE created_at < unixepoch() - 86400; DELETE FROM sessions WHERE expires_at < unixepoch();"
```

Don't delete users with SQL alone. That leaves their PDFs in R2. Use **My account → Delete everything**, which removes both.

### Backups and restore

```bash
# Full SQL dump to a file
npx wrangler d1 export solarhisaab --remote --output backups/solarhisaab-$(date +%F).sql

# Schema only / data only
npx wrangler d1 export solarhisaab --remote --no-data --output schema.sql
npx wrangler d1 export solarhisaab --remote --no-schema --output data.sql

# Time Travel: D1 keeps point-in-time history (30 days on paid plans, 7 on free)
npx wrangler d1 time-travel info solarhisaab
npx wrangler d1 time-travel restore solarhisaab --timestamp "2026-10-01T10:00:00+05:00"
```

A restore overwrites the current database. Take an `export` first.

To copy production data into your local dev database:

```bash
npx wrangler d1 export solarhisaab --remote --output prod.sql
rm -rf .wrangler/state && npx wrangler d1 execute solarhisaab --local --file prod.sql
```

---

## 10. R2: bill PDFs

PDFs are stored at `u/<userId>/<consumerId>/<YYYY-MM>.pdf`. Find a user's ID with the lookup query in section 9.

```bash
# Download one PDF
npx wrangler r2 object get "solarhisaab-bills/u/<userId>/<consumerId>/2026-09.pdf" --remote --file bill.pdf

# Upload / replace one (rarely needed; the app does this)
npx wrangler r2 object put "solarhisaab-bills/u/<userId>/<consumerId>/2026-09.pdf" --remote --file bill.pdf --content-type application/pdf

# Delete one
npx wrangler r2 object delete "solarhisaab-bills/u/<userId>/<consumerId>/2026-09.pdf" --remote

# Bucket details
npx wrangler r2 bucket info solarhisaab-bills
```

To browse or list objects, use the dashboard: **R2 → solarhisaab-bills → Objects**.

---

## 11. The monthly reminder cron

The schedule is set in `wrangler.jsonc` (`"crons": ["0 6 * * *"]`, which is 11:00 PKT daily) and goes live with `npx wrangler deploy`.

Test it locally in two terminals:

```bash
# terminal 1
npx wrangler dev --test-scheduled

# terminal 2: fire the cron now
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
```

Or simulate a specific date through the dev-only endpoint (works only with `DEV_MODE=1`, while signed in as an admin):

```bash
curl -X POST -H "Origin: http://localhost:8787" -b "__Host-sh_sid=<your-session-cookie>" \
  "http://localhost:8787/api/admin/run-reminders?at=2026-10-22T06:00:00Z"
```

In production, check what the cron did:

```bash
npx wrangler tail --search "reminders:"
```

The dashboard also shows past runs under **Workers → solarhisaab → Settings → Trigger events**.

To pause reminders, remove the cron from `wrangler.jsonc` (`"crons": []`) and deploy.

---

## 12. GitHub Actions secrets

The workflow in `.github/workflows/deploy.yml` needs two repository secrets. Add them in GitHub (**Settings → Secrets and variables → Actions**), or with the GitHub CLI:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo phpgurru/solarbill      # paste the token
gh secret set CLOUDFLARE_ACCOUNT_ID --repo phpgurru/solarbill     # from `npx wrangler whoami`
```

Create the token in Cloudflare: **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** template. Then add **Account → D1 → Edit** so the workflow can run migrations.

After that, pushing to `main` does **check → migrate → deploy**. Pull requests only run the check.

---

## 13. Troubleshooting

| Symptom | Fix |
|---|---|
| `Authentication error` / `code: 10000` | `npx wrangler login` again; in CI, check the token has Workers, D1 and R2 edit permissions |
| `Couldn't find a D1 DB with the name or binding` | `database_id` in `wrangler.jsonc` is still the placeholder; paste the ID from `npx wrangler d1 list` |
| `no such table: users` | Migrations not applied: `npx wrangler d1 migrations apply solarhisaab --remote` |
| Sign-in email never arrives | `npx wrangler secret list` should show `RESEND_API_KEY`; the domain in `EMAIL_FROM` must be verified in Resend; watch `npx wrangler tail --status error` |
| `SESSION_SECRET is not set` in logs | `openssl rand -base64 48 \| npx wrangler secret put SESSION_SECRET` |
| Signed in locally but still logged out | Use `http://localhost:8787`, not `127.0.0.1` |
| Custom domain shows an error | The domain must be an active zone in the same Cloudflare account; wait for nameserver change at PKNIC |
| Need to undo a bad deploy | `npx wrangler rollback` |
| Wrangler says an update is available | Update the pin: `npm install -D wrangler@4` and commit `package-lock.json` |

`npx wrangler <command> --help` shows every option for any command.
