# File uploader: upload sessions to OneDrive for Business

A Cloudflare-hosted web app that lets an administrator create public, shareable
**upload sessions**. External users open a link (or scan a QR code), fill in a
short form and upload files. **The files go straight from their browser to the
administrator's OneDrive for Business**, and every file is reported as a row in
an Excel Online table.

- **Stack:** TypeScript, React (Vite), Cloudflare Workers + Static Assets, D1,
  Cloudflare Access, Microsoft Graph (OneDrive + Excel), `qrcode` (PNG + SVG).
- **No file bytes pass through Cloudflare.** The Worker only creates Microsoft
  Graph resumable upload sessions, then verifies the result. The only file
  content the Worker reads is a file's first 64 bytes, to check its type
  signature after upload.

## Contents

1. [Architecture](#architecture)
2. [Features](#features)
3. [Project layout](#project-layout)
4. [Local development](#local-development)
5. [Microsoft Entra ID setup](#microsoft-entra-id-setup)
6. [Cloudflare setup](#cloudflare-setup)
7. [D1 migrations](#d1-migrations)
8. [OneDrive and Excel setup](#onedrive-and-excel-setup)
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
                         │                       • OAuth: connect Microsoft account ───┼──▶ login.microsoftonline.com
                         │                       • folder/workbook picker, sessions    │        (Entra ID, PKCE)
                         │                                                             │
 External uploader ─────▶│ Static assets (/u/#token)  +  Worker (/api/public)          │
  (browser)              │                       • validates link, fields, file rules  │
     │                   │                       • creates Graph upload session ───────┼──▶ graph.microsoft.com
     │                   │                       • verifies uploaded file, size, type  │     (OneDrive + Excel,
     │                   │                       • queues + retries Excel rows         │      delegated token)
     │                   │                                                             │
     │                   │ D1: sessions, submissions, files, audit, retry state,       │
     │                   │     AES-GCM-encrypted refresh token        Cron: */5 min ───┼──▶ Excel retries,
     │                   └─────────────────────────────────────────────────────────────┘     abandoned uploads,
     │                                                                                       token keep-alive
     └── file bytes: PUT 5 MiB chunks to the pre-authenticated upload URL ─▶ *.sharepoint.com (OneDrive)
```

**Upload sequence**

1. The browser reads the share token from the URL fragment (`/u/#<token>`) and
   POSTs it to `/api/public/session`. The fragment is never sent in requests, so
   tokens do not appear in access logs, Referer headers or analytics.
2. `POST /api/public/submissions` validates fields and the declared files (count,
   extension, size, MIME), atomically reserves a submission slot, and creates
   the submission (`created`) with a per-submission secret held only by the
   browser.
3. For each file: `POST …/files/:id/upload-url`. The Worker creates a Graph
   resumable upload session in the session's configured folder, using a
   server-generated file name (`uploading`).
4. The browser PUTs 5 MiB chunks (a multiple of 320 KiB) directly to Microsoft
   and resumes from `nextExpectedRanges` after interruptions. If the upload
   session expires, it requests a new one and restarts that file.
5. `POST …/files/:id/complete`. The Worker looks the file up **by its own path**,
   checks folder, size and signature (deleting it to the recycle bin if it
   fails), then records the item ID, path and web URL. When every file is
   verified, the submission moves to `uploaded`, then `excel_pending`.
6. The Excel row insert runs immediately (`waitUntil`) and, on failure, from the
   cron job with capped exponential backoff. Success marks it `complete`.

**Submission states:** `created → uploading → uploaded → excel_pending →
complete`. `failed` is reachable from any non-final state (upload window
expired, or Excel failed 12 times). Only Excel failures can be retried, back to
`excel_pending`. Every transition is a conditional `UPDATE … WHERE status IN
(allowed predecessors)`, so concurrent requests cannot corrupt state.

## Features

- **Admin dashboard** (`/admin/`, protected by Cloudflare Access): list sessions
  with status, expiry, destination folder, submission count, share link and QR
  code (PNG and SVG). Create, edit, publish, unpublish, duplicate, close, and
  replace a leaked link.
- **Per-session configuration:** title, instructions, OneDrive folder (picker,
  stored as the stable Graph drive and item IDs), expiry, maximum submissions,
  allowed extensions, maximum size per file, maximum files per submission, and
  form fields (label, internal key, type, required, dropdown options, optional
  Excel column).
- **Submissions page:** search by reference, file name, field value or session;
  filter by session and status; OneDrive links; retry Excel.
- **Settings:** connect or disconnect the Microsoft account, choose the Excel
  workbook and table, and view recent audit activity.
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
  microsoft/         OAuth, encrypted token store, Graph, OneDrive, Excel
  excel/             column mapping (pure) and idempotent sync with retries
  state.ts           submission state machine     scheduled.ts  cron jobs
shared/              validation, filename sanitisation and types used by Worker and browser
web/                 React apps: u/ (public), admin/ (dashboard), index.html (landing)
migrations/          D1 SQL migrations
test/                Vitest tests running in the Workers runtime (Miniflare)
docs/                Excel workbook specification and sample workbook
scripts/             smoke test, key generator, sample-workbook generator
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
MS_TENANT_ID=<tenant GUID>       # only needed to connect Microsoft locally
MS_CLIENT_ID=<client id>
MS_CLIENT_SECRET=<client secret>
```

`DEV_ADMIN_EMAIL` lets you use `/admin/` without Cloudflare Access. It only works
when `ENVIRONMENT=development` **and** the request host is `localhost` or
`127.0.0.1`. Production sets `ENVIRONMENT=production` in `wrangler.jsonc`.
To connect Microsoft locally, also add
`http://localhost:8787/api/admin/microsoft/callback` as a redirect URI in the
Entra app (Microsoft allows `http` only for localhost).

For front-end hot reload, run `npm run dev:web` (Vite on :5173, proxying `/api`
to :8787) alongside `npx wrangler dev`.

Checks: `npm run typecheck`, `npm test`.

## Microsoft Entra ID setup

The app uses the **authorisation-code flow with PKCE** as a confidential client,
with **delegated** permissions. It acts as the one administrator account you
connect and only touches that account's OneDrive. Personal Microsoft accounts
cannot sign in, because the app is single-tenant. The callback also rejects any
account whose drive type is not `business`.

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) as
   an Application Administrator (or Global Administrator).
2. **Identity → Applications → App registrations → New registration**
   - Name: `Upload sessions` (any name)
   - Supported account types: **Accounts in this organizational directory only
     (Single tenant)**
   - Redirect URI: platform **Web**, value
     `https://<your-host>/api/admin/microsoft/callback`
     (for example `https://uploads.example.com/api/admin/microsoft/callback`, or
     your `*.workers.dev` URL). It must match `PUBLIC_BASE_URL` exactly.
   - Click **Register**.
3. On **Overview**, copy the **Application (client) ID** → `MS_CLIENT_ID` and the
   **Directory (tenant) ID** → `MS_TENANT_ID`. These are not secrets.
4. **Certificates & secrets → Client secrets → New client secret.** Choose an
   expiry (put a renewal reminder in your calendar). Copy the secret's
   **Value**, not its Secret ID; it is shown only once. You will paste it
   into `wrangler secret put MS_CLIENT_SECRET`, never into a file.
5. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**, and add exactly:
   - `Files.ReadWrite`: read and write the signed-in user's own files (create
     upload sessions, verify uploads, edit the workbook)
   - `User.Read`: identify the connected account (usually present by default)
   - `offline_access`: issue a refresh token so retries can run in the
     background

   Remove anything else. Do **not** add `Files.ReadWrite.All` or
   `Sites.ReadWrite.All` (needed only for folders owned by other users or
   SharePoint sites, which this app does not use) or any application
   permissions.
6. Click **Grant admin consent for <tenant>** and confirm. This is required if
   your tenant blocks user consent, and recommended either way so the connect
   step does not prompt.
7. Optional hardening: **Enterprise applications → Upload sessions →
   Properties**: set *Assignment required* to **Yes**, then under **Users and
   groups** assign only the administrator account(s) that will connect.

## Cloudflare setup

You need a Cloudflare account. A zone (domain) on that account is strongly
recommended, so that Access can protect only the admin paths.

### 1. Cloudflare Access (Zero Trust)

1. **Zero Trust → Settings → Custom pages / Team domain:** note your team domain,
   for example `https://example.cloudflareaccess.com` → `ACCESS_TEAM_DOMAIN`.
2. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
   - Add **two** destinations (public hostnames) on your upload hostname:
     path `admin` and path `api/admin`. These cover `/admin`, `/admin/*`,
     `/api/admin/*` and the Microsoft OAuth callback.
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

## OneDrive and Excel setup

1. Upload [`docs/sample/UploadsReport.xlsx`](docs/sample/UploadsReport.xlsx) (or
   your own workbook that meets the
   [workbook specification](docs/excel-workbook-spec.md)) to the OneDrive of the
   account you will connect. Add a column for each form-field key you plan to
   use (the sample has `table_number` and `description`).
2. Create the destination folder(s) for uploads in the same OneDrive.
3. In the dashboard: **Settings → Connect Microsoft account**, then sign in
   with that work account and accept the permissions.
4. **Settings → Choose workbook**, pick the `.xlsx` file, then pick the table.
   The app checks that all standard columns exist before saving.
5. **Sessions → New session**: choose the folder, set the expiry, rules and
   fields, then **Save and publish**. Publishing validates the folder and the
   live Excel column mapping.

## Deployment

Prerequisites: run `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`). For an API token, use **My Profile → API Tokens →
Create Token → "Edit Cloudflare Workers"** template and add **Account → D1 →
Edit** (and **Zone → Workers Routes → Edit** plus **DNS → Edit** for a custom
domain).

```bash
# 1. Database
npx wrangler d1 create fileuploader                  # put database_id in wrangler.jsonc

# 2. Non-secret configuration: edit "vars" in wrangler.jsonc
#    PUBLIC_BASE_URL, ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAILS, MS_TENANT_ID, MS_CLIENT_ID

# 3. Secrets (prompted; values are not echoed or stored in files)
npx wrangler secret put MS_CLIENT_SECRET             # paste the Entra client secret value
node scripts/generate-key.mjs                        # generates TOKEN_ENCRYPTION_KEY and pipes it to wrangler

# 4. Build, migrate, deploy (runs typecheck + tests first)
npm run deploy

# 5. Custom domain (optional, recommended): add to wrangler.jsonc
#    "routes": [{ "pattern": "uploads.example.com", "custom_domain": true }]
#    then npm run deploy again and update PUBLIC_BASE_URL + the Entra redirect URI.

# 6. Smoke test
SMOKE_BASE_URL=https://uploads.example.com npm run smoke
```

The deploy creates the Worker with static assets, D1 binding, two rate-limit
bindings, and a cron trigger (`*/5 * * * *`) for Excel retries,
abandoned-upload cleanup, token keep-alive and key-rotation re-encryption.

## Backups

- **D1 Time Travel** (built in, no setup) lets you restore to any minute within
  the retention window (30 days on Workers Paid, 7 days on Free):
  `npx wrangler d1 time-travel info fileuploader` and
  `npx wrangler d1 time-travel restore fileuploader --timestamp=<RFC3339>`.
- **Exports:** `npx wrangler d1 export fileuploader --remote --output=backup-$(date +%F).sql`.
  Store exports encrypted. They contain submitted field values and
  *encrypted* tokens; without `TOKEN_ENCRYPTION_KEY` the tokens are useless.
- **Files** live in OneDrive and are covered by OneDrive version history, the
  recycle bin and your Microsoft 365 retention policies. Rejected files are
  deleted to the recycle bin, not permanently.
- **Excel** is a reporting copy and can be rebuilt from D1 (see
  [Recovery](#recovery)).
- Keep a copy of `TOKEN_ENCRYPTION_KEY` in your password manager. Cloudflare
  secrets cannot be read back.

## Token revocation and key rotation

| Goal | Action |
|---|---|
| Stop the app using Microsoft immediately | Dashboard **Settings → Disconnect** (deletes the encrypted tokens from D1). |
| Revoke the grant at Microsoft | Entra admin center → **Users → (the account) → Revoke sessions** (invalidates refresh tokens), and/or **Enterprise applications → Upload sessions → Permissions → Review permissions / delete the app**. The app detects `invalid_grant` and shows **Reconnect needed**. |
| Rotate the client secret | Create a new secret in Entra → `npx wrangler secret put MS_CLIENT_SECRET` → delete the old secret in Entra. |
| Rotate the encryption key | `npx wrangler secret put TOKEN_ENCRYPTION_KEY_PREVIOUS` (old value) and `node scripts/generate-key.mjs` (new value). Within a day the cron re-encrypts the refresh token and share tokens with the new key; then `npx wrangler secret delete TOKEN_ENCRYPTION_KEY_PREVIOUS`. |
| A share link leaked | Session editor → **Replace link** (the old link stops working at once), or **Unpublish** / **Close**. |
| Remove an admin | Remove them from the Access policy (and `ADMIN_EMAILS`). |

Refresh tokens rotate on every refresh. Writes use optimistic concurrency, so a
slower concurrent refresh can never overwrite a newer token. The cron refreshes
at least daily, keeping the 90-day inactivity window alive.

## Recovery

- **"Reconnect needed" banner:** the refresh token was revoked or expired, or the
  client secret is wrong or expired. Fix the secret if needed, then
  **Settings → Reconnect**. Submissions waiting on Excel retry automatically.
- **Lost `TOKEN_ENCRYPTION_KEY`:** set a new key, then reconnect Microsoft. Share
  links keep working (lookup is by hash), but the dashboard cannot display them.
  Use **Replace link** on live sessions to issue new links and QR codes.
- **Excel stuck or failed:** check **Submissions** (status filter
  `excel_pending` / `failed`; the last error is shown), fix the workbook (a
  missing column, a renamed table or a locked file), then click **Retry
  Excel**. Retries never insert a duplicate row for a file already present.
- **Workbook deleted or replaced:** choose the new workbook and table in
  Settings, then queue every file for re-reporting (duplicates are skipped):

  ```bash
  npx wrangler d1 execute DB --remote --command "UPDATE submission_files SET excel_status='pending' WHERE status='uploaded'; UPDATE submissions SET status='excel_pending', excel_attempts=1, excel_next_attempt_at=0, excel_lock_until=NULL WHERE status IN ('complete') OR (status='failed' AND failure_stage='excel');"
  ```

- **Abandoned uploads:** after 24 hours, unfinished submissions become `failed`
  (stage `upload`) and release their slot. Files that did finish stay in
  OneDrive and are listed on the submission.
- **Bad deploy:** `npx wrangler rollback` reverts to the previous Worker
  version. Restore data with D1 Time Travel if a migration went wrong.

## Security notes

- **Admin:** Cloudflare Access plus in-Worker JWT verification (fail closed),
  an optional email allowlist, and audit records for every admin action.
- **Uploaders cannot choose folders or names:** the destination is the folder
  ID the admin picked, and the file name is generated by the server.
  Original names are sanitised (no paths, control or bidi characters, reserved
  names, unsafe characters). Lookups use server-built paths only.
- **File checks:** allowed extensions plus a fixed blocklist of executable and
  script types; a declared MIME-type check; size checked before upload and
  re-verified in OneDrive (a mismatched file is deleted); a signature check of
  the first 64 bytes (PDF, images, Office/zip, legacy Office, media), with
  executables rejected whatever their extension.
- **Tokens:** share tokens are 256-bit random values, stored as a SHA-256 hash
  plus AES-GCM ciphertext, and kept in the URL fragment. Submission secrets are
  256-bit and stored hashed. Graph access and refresh tokens are encrypted with
  AES-256-GCM (context-bound) and never sent to browsers.
- **Logs:** an allowlist-based logger with URL and token redaction. Upload URLs,
  access tokens, share tokens, field values and file contents are never logged
  (covered by a test).
- **HTTP:** strict CSP (no inline script or style; `connect-src` limited to
  self and `*.sharepoint.com` for chunk uploads), HSTS, `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy: no-referrer`. The API sends no CORS headers,
  refuses preflights, and requires same-origin, JSON-only state-changing
  requests (CSRF protection).
- **Abuse:** the Workers Rate Limiting binding allows 120 requests/min per
  client on public endpoints and 10/min for new submissions. Submission slots
  are reserved atomically, and each file can request at most 20 upload sessions.
- **Excel:** formula-like values are written as text.

**Known limitations**

- Microsoft Graph cannot enforce a maximum size while an upload is in progress
  for OneDrive for Business. Size is checked before the upload starts and
  re-verified afterwards, and oversized files are deleted.
- Direct browser-to-SharePoint chunk uploads depend on Microsoft's CORS support
  for upload URLs. They are verified in the post-deployment smoke test with a
  real tenant, not in automated tests.
- `npm audit` is clean at the time of writing. Re-run it before each release.

## Tests

`npm test` runs the suite inside the Workers runtime (`@cloudflare/vitest-plugin`
with Miniflare and a real local D1), using a fake Microsoft Graph and Access
issuer:

| File | Covers |
|---|---|
| `access.test.ts` | Access JWT signature, audience, issuer, expiry, service tokens, allowlist, dev bypass, admin UI gate, CORS/CSRF, security headers |
| `public-api.test.ts` | Expired, unpublished, closed, exhausted and invalid links; atomic slot reservation; server-side field and file validation; path control; publish-time Excel validation |
| `upload-flow.test.ts` | End-to-end upload, idempotent completion, restart and resume, size and signature rejection, link visibility, no secrets in logs, admin search |
| `excel-sync.test.ts` | `excel_pending` with backoff, duplicate prevention after lost responses and partial writes, leases, max attempts and admin retry, abandoned uploads |
| `mapping.test.ts` | Column mapping validation, row building, formula neutralisation |
| `state.test.ts` | State machine, conditional transitions, backoff caps |
| `filenames.test.ts` / `validation.test.ts` | Sanitisation, traversal, reserved names, field/file/session validation |
| `tokens.test.ts` | Refresh, rotation, concurrent refresh, revoked grants, keep-alive |
| `crypto-magic.test.ts` | AES-GCM, context binding, key rotation, token entropy, file signatures |
| `admin-sessions.test.ts` | Create, edit, publish, unpublish, duplicate, close, QR SVG, rate limiting |
