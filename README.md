# SolarHisaab

Understand your net-metering electricity bill, every month.

Drop a LESCO (or other PITC DISCO) web-bill PDF. SolarHisaab reads both QR codes and the printed figures, then shows:

- an energy-flow picture of what you took from and sent back to the grid
- daytime (off-peak) vs evening (peak) units and what each costs
- why a quarterly settlement can charge a net exporter
- what solar saved you, self-consumption, and payback
- your credit balance and net units over time
- a full bill check (every figure recomputed) for experts

Guests can try it without an account. Signed-in users (email magic link) get their bills saved, filed by consumer ID, with a monthly reminder when the next bill is out.

---

## How it's built

| Piece | Cloudflare product | Where |
|---|---|---|
| Web app (HTML/CSS/JS) | Workers static assets | `public/` |
| API, sign-in, cron | Worker | `src/` |
| Accounts, meters, parsed bill data | D1 (SQLite) | `migrations/` |
| Original bill PDFs | R2 | bucket `solarhisaab-bills` |
| Sign-in and reminder emails | Resend (HTTP API) | `src/email.js` |

**Parsing happens in the browser.** `public/engine.js` reads the PDF text and QR codes client-side. The browser uploads the PDF plus the raw material it read (`text`, `qrs`); the Worker **re-runs the same engine** on that material, so stored figures always come from one code path. The same `engine.js` file is imported by the Worker (`src/api.js`).

**Accounts are email-based, meters are consumer-ID based.** Consumer IDs and reference numbers are printed on every bill and can be looked up online, so they are never used as a login. A user signs in with a magic link; each uploaded bill is filed under a *meter* (one per consumer ID per user). One account can hold several meters (home, shop, parents). Every query is scoped to the signed-in user, so two users with the same meter never see each other's uploads.

```
public/
  index.html  app.js  app.css   the main app
  engine.js                     bill parser + analysis (shared with the Worker)
  account.html account.js       meters, bills, PDFs, reminders, export, delete
  admin.html  admin.js          counts-only stats for ADMIN_EMAILS
  privacy.html 404.html
  vendor/                       pdf.js 3.11.174 + jsQR 1.4.0 (self-hosted)
  _headers                      CSP and security headers
src/
  worker.js   router, Origin check, cron entry
  auth.js     magic links, sessions, one-click unsubscribe
  api.js      bills, meters, account, export, admin stats
  cron.js     monthly reminder emails
  email.js    Resend client and email templates
  util.js     helpers
migrations/0001_init.sql
```

---

## One-time setup

You need a Cloudflare account, Node 20+, and a Resend account.

### 1. Domain

1. Register your `.pk` domain at PKNIC (pknic.net.pk) or a PKNIC reseller.
2. In Cloudflare, **Add a site** with that domain and copy the two Cloudflare nameservers.
3. In PKNIC, replace the nameservers with Cloudflare's. This can take a few hours.

### 2. Cloudflare resources

```bash
npm install
npx wrangler login

npx wrangler d1 create solarhisaab           # copy the database_id it prints
npx wrangler r2 bucket create solarhisaab-bills
```

Edit `wrangler.jsonc`:

- `database_id`: paste the D1 id
- `APP_URL`, `APP_NAME`, `EMAIL_FROM`: your domain and brand
- `ADMIN_EMAILS`: your email (comma-separate several)
- uncomment `routes` and put your domain in it

### 3. Email (Resend)

1. Sign up at resend.com and add your domain. Resend gives you DNS records (SPF, DKIM); add them in Cloudflare DNS and wait for "Verified".
2. Create an API key.

```bash
npx wrangler secret put RESEND_API_KEY     # paste the Resend key
npx wrangler secret put SESSION_SECRET     # paste any long random string, e.g. from: openssl rand -base64 48
```

### 4. First deploy

```bash
npm run db:migrate:remote
npm run deploy
```

Open your domain, add a bill, sign in, and check that the email arrives.

### 5. GitHub auto-deploy

1. Create an empty GitHub repo and push this project:
   ```bash
   git remote add origin git@github.com:<you>/solarhisaab.git
   git push -u origin main
   ```
2. In Cloudflare, **My Profile → API Tokens → Create Token** using the **Edit Cloudflare Workers** template, and add **Account → D1 → Edit** so migrations can run.
3. In GitHub, **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID`: from the Cloudflare dashboard sidebar
4. Every push to `main` now checks the code, applies new migrations, and deploys. Pull requests run the check only.

The workflow uses a GitHub **environment** called `production`. GitHub creates it on the first run; add required reviewers there if you want a manual approval before each deploy.

---

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

With `DEV_MODE=1` and no `RESEND_API_KEY`, the sign-in dialog shows the magic link on screen instead of emailing it. Use `http://localhost:8787`, not `127.0.0.1`, so the secure session cookie is accepted. In dev mode you can trigger reminders by hand:

```bash
curl -X POST -H "Origin: http://localhost:8787" -b "__Host-sh_sid=<cookie>" \
  "http://localhost:8787/api/admin/run-reminders?at=2026-10-22T06:00:00Z"
```

---

## API

All `/api/*` routes except sign-in need the session cookie. Non-GET requests must come from the site's own origin.

| Method | Path | Does |
|---|---|---|
| POST | `/api/auth/request` | `{email}` sends a magic link (5 per email, 20 per IP address per hour) |
| GET/POST | `/auth/verify` | confirmation page, then starts a 60-day session |
| POST | `/api/auth/logout` | ends the session |
| GET/PATCH/DELETE | `/api/me` | profile; `{reminders}`; delete account with `{confirm: email}` |
| GET | `/api/bills` | all meters and bills for the user |
| POST | `/api/bills` | multipart `payload` (JSON) + optional `file` (PDF ≤ 10 MB); same meter + month replaces |
| GET | `/api/bills/:id/pdf` | the PDF (`?download=1` to download) |
| DELETE | `/api/bills/:id` | deletes the bill and its PDF |
| PATCH/DELETE | `/api/meters/:id` | rename `{label}`; delete meter and its bills |
| GET | `/api/export` | everything as JSON, with PDF links |
| GET | `/api/admin/stats` | counts for `ADMIN_EMAILS` only |
| GET/POST | `/auth/unsubscribe` | signed one-click unsubscribe from reminders |

R2 keys are `u/<userId>/<consumerId>/<YYYY-MM>.pdf`.

## Reminders

A cron runs daily at 06:00 UTC (11:00 PKT). A user gets one email a month when:
- reminders are on,
- they have at least one meter,
- some meter has no bill for the current month, and
- today is at least 2 days after the day their bills are usually issued (read from past bills; default the 20th).

Each email has a one-click unsubscribe link.

## Security notes

- Magic-link tokens and session IDs are stored only as SHA-256 hashes. Tokens are single-use and expire after 15 minutes.
- Opening the email link shows a confirmation button; the token is used only by the POST. This stops email scanners from using up links.
- Cookies are `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`. State-changing requests must carry the site's own `Origin`.
- Uploaded JSON is size-limited and stripped of markup. Only real PDFs (`%PDF-` header) are stored. PDFs are served with `Content-Security-Policy: sandbox`.
- Strict CSP on all pages. pdf.js and jsQR are self-hosted, so no third-party scripts run.
- Account deletion removes every R2 object under the user's prefix and all D1 rows.

## Costs

At the time of writing, Cloudflare's free tiers cover a lot:
- Workers: 100k requests/day
- D1: 5 GB
- R2: 10 GB storage, no egress fees

Resend's free plan sends 3,000 emails/month. Check each provider's current pricing before launch. At about 1.7 MB per bill PDF, 10 GB of R2 holds roughly 6,000 bills.

## Supported bills

The format is tested on LESCO net-metering web bills. IESCO, FESCO, GEPCO, MEPCO, PESCO and HESCO use the same PITC web-bill layout and QR format, so they should parse the same way; confirm with real samples. Bills without the net-metering QR fall back to the printed meter registers.
