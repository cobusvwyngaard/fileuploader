# File uploader: upload sessions to Google Drive

A Cloudflare-hosted web app that lets an administrator create public, shareable
**upload sessions**. External users open a link (or scan a QR code), fill in a
short form and upload files. **The files go straight from their browser to the
administrator's Google Drive**, and every file is reported as a row in a Google
Sheets spreadsheet.

> The app was first built for Microsoft 365 (OneDrive for Business + Excel). It
> moved to Google Drive + Sheets because registering a Microsoft Entra app
> needs tenant-admin rights. Internal identifiers such as the `excel_pending`
> status and `excel_*` database columns refer to the report-sheet step.

- **Stack:** TypeScript, React (Vite), Cloudflare Workers + Static Assets, D1,
  Cloudflare Access, Google Drive API v3 + Sheets API v4, `qrcode` (PNG + SVG).
- **No file bytes pass through Cloudflare.** The Worker only starts Google
  Drive resumable upload sessions, then verifies the result. The only file
  content the Worker reads is a file's first 64 bytes, to check its type
  signature after upload.
- **Least privilege:** the only Drive permission is `drive.file`, so the app
  can see only the folders, files and spreadsheet it creates, never the rest of
  your Drive.

## Contents

1. [Architecture](#architecture)
2. [Features](#features)
3. [Project layout](#project-layout)
4. [Local development](#local-development)
5. [Google Cloud setup](#google-cloud-setup)
6. [Cloudflare setup](#cloudflare-setup)
7. [D1 migrations](#d1-migrations)
8. [Drive and Sheets setup](#drive-and-sheets-setup)
9. [Deployment](#deployment)
10. [Backups](#backups)
11. [Token revocation and key rotation](#token-revocation-and-key-rotation)
12. [Recovery](#recovery)
13. [Security notes](#security-notes)
14. [Tests](#tests)

## Architecture

```
                         ┌──────────────────────── Cloudflare ────────────────────────┐
 Administrator ──HTTPS──▶│ Cloudflare Access ──▶ Worker (/admin, /api/admin)          │
  (browser)              │   (SSO policy)        • verifies Access JWT again           │
                         │                       • OAuth: connect Google account ──────┼──▶ accounts.google.com
                         │                       • folders, report sheet, sessions     │        (PKCE, drive.file)
                         │                                                             │
 External uploader ─────▶│ Static assets (/u/#token)  +  Worker (/api/public)          │
  (browser)              │                       • validates link, fields, file rules  │
     │                   │                       • starts Drive resumable upload ──────┼──▶ www.googleapis.com/drive
     │                   │                       • verifies uploaded file, size, type  │     sheets.googleapis.com
     │                   │                       • queues + retries report rows        │     (delegated token)
     │                   │                                                             │
     │                   │ D1: sessions, submissions, files, audit, retry state,       │
     │                   │     AES-GCM-encrypted refresh token        Cron: */5 min ───┼──▶ report retries,
     │                   └─────────────────────────────────────────────────────────────┘     abandoned uploads,
     │                                                                                       token keep-alive
     └── file bytes: PUT 5 MiB chunks to the resumable session URI ──▶ www.googleapis.com/upload/drive
```

**Upload sequence**

1. The browser reads the share token from the URL fragment (`/u/#<token>`) and
   POSTs it to `/api/public/session`. The fragment is never sent in requests, so
   tokens do not appear in access logs, Referer headers or analytics.
2. `POST /api/public/submissions` validates fields and the declared files (count,
   extension, size, MIME), atomically reserves a submission slot, and creates
   the submission (`created`) with a per-submission secret held only by the
   browser.
3. For each file: `POST …/files/:id/upload-url`. The Worker starts a Drive
   resumable upload in the session's configured folder (`uploading`), with:
   - a server-generated file name and a MIME type chosen by the server;
   - the declared size (`X-Upload-Content-Length`), so Google rejects any
     extra bytes;
   - the site's `Origin`, so only this site's pages can upload to the session.
4. The browser PUTs 5 MiB chunks (a multiple of 256 KiB) directly to Google. It
   resumes from the `Range` of a `308` response after interruptions. If the
   session expires (404/410), it requests a new one and restarts that file.
5. `POST …/files/:id/complete`. The Worker finds the file by its own name in
   its own folder, then checks the folder, size and signature (moving the file
   to the Drive trash if a check fails). It records the file ID, path and link.
   When every file is verified, the submission moves to `uploaded`, then
   `excel_pending` (the report step).
6. The report rows are appended immediately (`waitUntil`) and, on failure, from
   the cron job with capped exponential backoff. Success marks the submission
   `complete`.

**Submission states:** `created → uploading → uploaded → excel_pending →
complete`. `failed` is reachable from any non-final state (upload window
expired, or the report step failed 12 times). Only report failures can be
retried, back to `excel_pending`. Every transition is a conditional `UPDATE …
WHERE status IN (allowed predecessors)`, so concurrent requests cannot corrupt
state.

## Features

- **Admin dashboard** (`/admin/`, protected by Cloudflare Access): list sessions
  with status, expiry, destination folder, submission count, share link and QR
  code (PNG and SVG). Create, edit, publish, unpublish, duplicate, close, and
  replace a leaked link.
- **Per-session configuration:** title, instructions, Google Drive folder
  (chosen or created in the dashboard, stored by its stable Drive file ID),
  expiry, maximum submissions,
  allowed extensions, maximum size per file, maximum files per submission, and
  form fields (label, internal key, type, required, dropdown options, optional
  report column).
- **Submissions page:** search by reference, file name, field value or session;
  filter by session and status; Drive links; retry the report step.
- **Settings:** connect or disconnect the Google account (disconnecting revokes
  the grant at Google), create or choose the report spreadsheet, and view
  recent audit activity.
- **Public upload page:** mobile-friendly and accessible (labelled inputs, error
  summary with focus management, live progress, keyboard and screen-reader
  support). It enforces rules in the browser as well as on the server, resumes
  after a reload, and ends with a completion page showing the reference ID.

## Project layout

```
src/                 Cloudflare Worker (Hono)
  index.ts           routing, admin UI gate, cron entry
  access.ts          Cloudflare Access JWT verification
  routes/public.ts   upload API      routes/admin.ts  admin API
  google/            OAuth, encrypted token store, API client, Drive, Sheets
  report/            column mapping (pure) and idempotent sheet sync with retries
  state.ts           submission state machine     scheduled.ts  cron jobs
shared/              validation, filename sanitisation and types used by Worker and browser
web/                 React apps: u/ (public), admin/ (dashboard), index.html (landing)
migrations/          D1 SQL migrations
test/                Vitest tests running in the Workers runtime (Miniflare)
docs/                report spreadsheet specification
scripts/             smoke test, key generator, CI D1 helper
.github/workflows/   deploy.yml: test, migrate, deploy, smoke test on every push
```

## Local development

Prerequisites: Node.js 20+ and npm.

```bash
npm install                      # .npmrc sets legacy-peer-deps (npm's resolver otherwise crashes on this dependency set)
cp .dev.vars.example .dev.vars   # then fill it in, see below
node scripts/generate-key.mjs --print   # paste the output into TOKEN_ENCRYPTION_KEY in .dev.vars
npm run db:migrate:local
npm run dev                      # builds the front-end, then serves on http://localhost:8787
```

Minimum `.dev.vars` for local work:

```
ENVIRONMENT=development
PUBLIC_BASE_URL=http://localhost:8787
DEV_ADMIN_EMAIL=you@example.com
TOKEN_ENCRYPTION_KEY=<generated>
GOOGLE_CLIENT_ID=<client id>     # only needed to connect Google locally
GOOGLE_CLIENT_SECRET=<client secret>
```

`DEV_ADMIN_EMAIL` lets you use `/admin/` without Cloudflare Access. It only works
when `ENVIRONMENT=development` **and** the request host is `localhost` or
`127.0.0.1`. Production sets `ENVIRONMENT=production` in `wrangler.jsonc`.
To connect Google locally, also add
`http://localhost:8787/api/admin/google/callback` as an authorised redirect URI
on the OAuth client (Google allows `http` only for localhost).

For front-end hot reload, run `npm run dev:web` (Vite on :5173, proxying `/api`
to :8787) alongside `npx wrangler dev`.

Checks: `npm run typecheck`, `npm test`.

## Google Cloud setup

The app uses Google's **OAuth authorisation-code flow with PKCE** as a
confidential web client, with **delegated** access to the one Google account
you connect. A personal Gmail account works, and no organisation admin is
needed.

1. Open the [Google Cloud console](https://console.cloud.google.com/), signed
   in with the Google account whose Drive should receive the uploads.
2. Use the project picker (top bar) → **New project**. Name it, for example
   `fileuploader`, then **Create** and select it.
3. **APIs & Services → Library:** enable **Google Drive API** and **Google
   Sheets API**.
4. **Google Auth Platform** (also reached via *APIs & Services → OAuth consent
   screen*) → **Get started**:
   - App name: `Upload sessions` (any name); user support email: yours.
   - Audience: **External**.
   - Contact email: yours. Accept the policy, then **Create**.
5. **Data Access → Add or remove scopes.** Tick exactly these, then **Update**
   and **Save**:
   - `.../auth/drive.file`: files and folders created by this app only
   - `openid`
   - `.../auth/userinfo.email`

   Do **not** add `.../auth/drive` or `.../auth/spreadsheets`. Those are
   restricted or sensitive, and Google would require a verification review.
6. **Audience → Publish app → Confirm** (status **In production**). This
   matters: in *Testing* status Google expires refresh tokens after 7 days and
   uploads would stop weekly. With only non-sensitive scopes, publishing needs
   no Google review. Google may still show a one-time "Google hasn't verified
   this app" notice when you connect; choose *Advanced → Go to …*. Only you ever
   see it, because only the administrator signs in.
7. **Clients → Create client** → Application type **Web application**:
   - Authorised redirect URI:
     `https://fileuploader.cobus-w.workers.dev/api/admin/google/callback`
     (it must match `PUBLIC_BASE_URL` exactly).
   - **Create**. The **Client ID** goes in `wrangler.jsonc` as
     `GOOGLE_CLIENT_ID`; it is not a secret. Enter the **Client secret** in
     Cloudflare as the secret `GOOGLE_CLIENT_SECRET` (see
     [Deployment](#deployment)). Never commit it or paste it into chat.

## Cloudflare setup

You need a Cloudflare account. A zone (domain) on that account is strongly
recommended, so that Access can protect only the admin paths.

### 1. Cloudflare Access (Zero Trust)

1. **Zero Trust → Settings → Custom pages / Team domain:** note your team domain,
   for example `https://example.cloudflareaccess.com` → `ACCESS_TEAM_DOMAIN`.
2. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Add **two** destinations (public hostnames) on your upload hostname:
     path `admin` and path `api/admin`. These cover `/admin`, `/admin/*`,
     `/api/admin/*` and the Google OAuth callback.
   - Policy: **Allow**, Include → **Emails** → your administrator email(s).
   - Save, then copy the **Application Audience (AUD) Tag** → `ACCESS_AUD`.
3. Optionally put the same emails in `ADMIN_EMAILS` (comma-separated) as a
   second check inside the Worker.

Do **not** protect `/`, `/u/*`, `/assets/*` or `/api/public/*`; external
uploaders must reach those without signing in.

The Worker independently verifies the `Cf-Access-Jwt-Assertion` header's
signature (against your team's JWKS), audience, issuer and expiry on every
admin request, including the admin HTML. If Access is misconfigured, admin
routes **fail closed** (401).

> **workers.dev only, no custom domain:** Cloudflare's one-click "Enable
> Cloudflare Access" for `workers.dev` protects the **whole** hostname, which
> would also block uploaders. Use a custom domain for production. Without Access
> in front, the admin routes on workers.dev simply return 401.

### 2. Automated smoke-test token (optional)

To let `scripts/smoke-test.mjs` exercise admin routes: **Access → Service
credentials → Service Tokens → Create**. Add an Access policy with action
**Service Auth** that includes this token, and put the token's **Client ID** in
`ADMIN_SERVICE_TOKENS`. Service tokens are refused unless they are listed there.

## D1 migrations

```bash
npx wrangler d1 create fileuploader            # once; copy database_id into wrangler.jsonc
npm run db:migrate:remote                      # wrangler d1 migrations apply DB --remote
npm run db:migrate:local                       # local dev database
npx wrangler d1 migrations list DB --remote    # show applied/pending
```

Migrations live in `migrations/` and are applied in order. Add new ones with
`npx wrangler d1 migrations create DB <name>`, and never edit an applied one.

## Drive and Sheets setup

1. In the dashboard, open **Settings → Connect Google account** and sign in with
   the Google account you configured above. Allow access to Google Drive. If
   the Drive box is unticked on the consent screen, the app refuses the
   connection and asks you to reconnect.
2. **Settings → Report spreadsheet → Create spreadsheet.** List the form-field
   keys you plan to use (default `table_number, description`); the app creates
   the spreadsheet in your Drive and selects it. See the
   [report sheet specification](docs/report-sheet-spec.md).
3. **Sessions → New session → Choose folder → create a folder** (for example
   `/Events/Gala 2026`), set the expiry, rules and fields, then **Save and
   publish**. Publishing validates the folder and the live report columns.
4. To add a field later, add a header with the field's key to row 1 of the
   report tab, then save the session.

## Deployment

**This repository deploys itself with GitHub Actions** (`.github/workflows/deploy.yml`)
on every push to `main` or `claude/lucid-volta-wv42bj`, and on manual runs. Each
run:
1. runs the typecheck and tests;
2. builds the front-end;
3. finds or creates the D1 database;
4. applies migrations;
5. deploys the Worker with `PUBLIC_BASE_URL` set to its `workers.dev` URL;
6. generates `TOKEN_ENCRYPTION_KEY` if it doesn't exist (the value is never
   printed);
7. runs the smoke test.

It needs one repository secret: **Settings → Secrets and variables → Actions →
New repository secret** `CLOUDFLARE_API_TOKEN`, created from the
**Edit Cloudflare Workers** template plus **Account → D1 → Edit**. The account
ID is in `wrangler.jsonc` and the workflow.

Set once in the Cloudflare dashboard (**Workers & Pages → fileuploader →
Settings → Variables and Secrets → Add**, type **Secret**):
`GOOGLE_CLIENT_SECRET`. Non-secret values (`GOOGLE_CLIENT_ID`, `ACCESS_*`,
`ADMIN_EMAILS`) live in `wrangler.jsonc` → `vars`.

Manual deployment from a workstation is equivalent:

```bash
npx wrangler login
npx wrangler d1 create fileuploader                  # once; put database_id in wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET         # prompted; not echoed
node scripts/generate-key.mjs                        # TOKEN_ENCRYPTION_KEY, piped to wrangler
npm run deploy                                       # typecheck, test, build, migrate, deploy
SMOKE_BASE_URL=https://fileuploader.cobus-w.workers.dev npm run smoke
```

The deploy creates the Worker with static assets, the D1 binding, two
rate-limit bindings, and a cron trigger (`*/5 * * * *`) that runs report
retries, abandoned-upload cleanup, token keep-alive and key-rotation
re-encryption.

## Backups

- **D1 Time Travel** (built in, no setup) lets you restore to any minute within
  the retention window (30 days on Workers Paid, 7 days on Free):
  `npx wrangler d1 time-travel info fileuploader` and
  `npx wrangler d1 time-travel restore fileuploader --timestamp=<RFC3339>`.
- **Exports:** `npx wrangler d1 export fileuploader --remote --output=backup-$(date +%F).sql`.
  Store exports encrypted. They contain submitted field values and
  *encrypted* tokens; without `TOKEN_ENCRYPTION_KEY` the tokens are useless.
- **Files** live in Google Drive. Rejected files are moved to the Drive trash
  (kept 30 days), never permanently deleted. Use Google Takeout or a Drive sync
  client if you want an independent copy.
- **The report sheet** is a reporting copy and can be rebuilt from D1 (see
  [Recovery](#recovery)). Google Sheets also keeps version history.
- Keep a copy of `TOKEN_ENCRYPTION_KEY` in your password manager. Cloudflare
  secrets cannot be read back.

## Token revocation and key rotation

| Goal | Action |
|---|---|
| Stop the app using Google immediately | Dashboard **Settings → Disconnect**. It revokes the grant at Google and deletes the encrypted tokens from D1. |
| Revoke from Google's side | [myaccount.google.com/connections](https://myaccount.google.com/connections) → the app → **Delete all connections**. The app detects `invalid_grant` and shows **Reconnect needed**. |
| Rotate the client secret | Google Cloud → Google Auth Platform → Clients → the client → **Add secret** → set `GOOGLE_CLIENT_SECRET` in Cloudflare → disable and delete the old secret. |
| Rotate the encryption key | `npx wrangler secret put TOKEN_ENCRYPTION_KEY_PREVIOUS` (old value) and `node scripts/generate-key.mjs` (new value). Within a day the cron re-encrypts the refresh token and share tokens with the new key; then `npx wrangler secret delete TOKEN_ENCRYPTION_KEY_PREVIOUS`. |
| A share link leaked | Session editor → **Replace link** (the old link stops working at once), or **Unpublish** / **Close**. |
| Remove an admin | Remove them from the Access policy (and `ADMIN_EMAILS`). |

Token writes use optimistic concurrency, so a slower concurrent refresh never
overwrites a newer token, and a new refresh token is stored if Google issues
one. The cron refreshes daily, which detects a revoked grant early and keeps the
refresh token in use (Google expires refresh tokens unused for six months).

## Recovery

- **"Reconnect needed" banner:** the grant was revoked, the refresh token
  expired (for example because the app was left in *Testing* status), or the
  client secret is wrong. Fix the cause, then **Settings → Reconnect**.
  Submissions waiting on the report retry automatically.
- **Lost `TOKEN_ENCRYPTION_KEY`:** set a new key, then reconnect Google. Share
  links keep working (lookup is by hash), but the dashboard cannot display them.
  Use **Replace link** on live sessions to issue new links and QR codes.
- **Report stuck or failed:** check **Submissions** (status filter
  *Sheet pending* / *Failed*; the last error is shown), fix the sheet (for
  example a deleted header or a deleted tab), then click **Retry report**.
  Retries never append a duplicate row for a file already present.
- **Report spreadsheet deleted or replaced:** create or choose a new one in
  Settings, then queue every file for re-reporting (duplicates are skipped):

  ```bash
  npx wrangler d1 execute DB --remote --command "UPDATE submission_files SET excel_status='pending' WHERE status='uploaded'; UPDATE submissions SET status='excel_pending', excel_attempts=1, excel_next_attempt_at=0, excel_lock_until=NULL WHERE status IN ('complete') OR (status='failed' AND failure_stage='excel');"
  ```

- **Abandoned uploads:** after 24 hours, unfinished submissions become `failed`
  (stage `upload`) and release their slot. Files that did finish stay in Drive
  and are listed on the submission.
- **Bad deploy:** `npx wrangler rollback` reverts to the previous Worker
  version. Restore data with D1 Time Travel if a migration went wrong.

## Security notes

- **Admin:** Cloudflare Access plus in-Worker JWT verification (fail closed),
  an optional email allowlist, and audit records for every admin action.
- **Least privilege at Google:** the only Drive scope is `drive.file`, so the
  app can only see what it created. Google tokens are only ever sent to
  `https://*.googleapis.com`.
- **Uploaders cannot choose folders, names or sizes:** the destination is the
  folder ID the admin picked, the file name and MIME type are chosen by the
  server, and Google enforces the declared size. Original names are sanitised
  (no paths, control or bidi characters, reserved names, unsafe characters).
- **File checks:** allowed extensions plus a fixed blocklist of executable and
  script types; a declared MIME-type check; size checked before upload,
  enforced by Drive during upload, and re-verified afterwards; a signature
  check of the first 64 bytes (PDF, images, Office/zip, legacy Office, media),
  with executables rejected whatever their extension. Rejected files are moved
  to the Drive trash.
- **Tokens:** share tokens are 256-bit random values, stored as a SHA-256 hash
  plus AES-GCM ciphertext, and kept in the URL fragment. Submission secrets are
  256-bit and stored hashed. Google access and refresh tokens are encrypted with
  AES-256-GCM (context-bound) and never sent to browsers.
- **Logs:** an allowlist-based logger with URL and token redaction. Upload
  session URIs, access tokens, share tokens, field values and file contents are
  never logged (covered by a test).
- **HTTP:** strict CSP (no inline script or style; `connect-src` limited to
  self and `www.googleapis.com` for chunk uploads), HSTS, `X-Frame-Options:
  DENY`, `nosniff`, `Referrer-Policy: no-referrer`. The API sends no CORS
  headers, refuses preflights, and requires same-origin, JSON-only
  state-changing requests (CSRF protection).
- **Abuse:** the Workers Rate Limiting binding allows 120 requests/min per
  client on public endpoints and 10/min for new submissions. Submission slots
  are reserved atomically, and each file can request at most 20 upload sessions.
- **Report sheet:** values are written with `valueInputOption=RAW`, so
  formula-like input is stored as text.

**Known limitations**

- Direct browser-to-Google chunk uploads rely on Google allowing CORS for
  resumable sessions started with the site's `Origin`. If the `Range` header of
  a `308` response is not readable from the browser, the uploader assumes the
  chunk was stored, and the server-side size check then catches any gap. Both
  are verified in the post-deployment test with a real Google account, not in
  automated tests.
- With `drive.file`, the dashboard cannot browse folders or spreadsheets you
  created yourself in Drive; create them from the dashboard instead.
- `npm audit` is clean at the time of writing. Re-run it before each release.

## Tests

`npm test` runs the suite inside the Workers runtime (`@cloudflare/vitest-plugin`
with Miniflare and a real local D1), using a fake Google OAuth/Drive/Sheets
backend and a fake Access issuer:

| File | Covers |
|---|---|
| `access.test.ts` | Access JWT signature, audience, issuer, expiry, service tokens, allowlist, dev bypass, admin UI gate, CORS/CSRF, security headers |
| `public-api.test.ts` | Expired, unpublished, closed, exhausted and invalid links; atomic slot reservation; server-side field and file validation; path control; publish-time report-column validation |
| `upload-flow.test.ts` | End-to-end upload, idempotent completion, restart and resume, size and signature rejection, link visibility, no secrets in logs, admin search |
| `report-sync.test.ts` | `excel_pending` with backoff, duplicate prevention after lost responses and partial writes, leases, max attempts and admin retry, abandoned uploads |
| `mapping.test.ts` | Column mapping validation, row building, A1 ranges |
| `google-admin.test.ts` | OAuth URL and scopes, connect callback and single-use state, folder creation and paths, report spreadsheet creation and selection |
| `state.test.ts` | State machine, conditional transitions, backoff caps |
| `filenames.test.ts` / `validation.test.ts` | Sanitisation, traversal, reserved names, field/file/session validation |
| `tokens.test.ts` | Refresh, rotation, concurrent refresh, revoked grants, keep-alive, revoke on disconnect |
| `crypto-magic.test.ts` | AES-GCM, context binding, key rotation, token entropy, file signatures |
| `admin-sessions.test.ts` | Create, edit, publish, unpublish, duplicate, close, QR SVG, rate limiting |
