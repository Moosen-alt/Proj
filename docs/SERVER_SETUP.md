# Server Setup — cloud access for your workers

## Local machine setup (Windows / Mac dev or operator workstation)

1. Install Node 20+ (nodejs.org LTS) and Git.
2. ```
   git clone <repo> SOLAR-Proj && cd SOLAR-Proj
   npm install
   npx playwright install chromium
   ```
3. Create `.env` in the repo root (gitignored):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   SESSION_ENCRYPTION_KEY=<any long random string — keep it; it locks stored portal logins>
   ```
   (Local dev can skip AUTH_ENABLED; NEVER skip it on anything reachable
   from outside the machine.) Leave SERVER_HOST unset here: the server then
   listens on 127.0.0.1, so only this machine can reach it.
4. `npm run dev` → dashboard at http://localhost:4000. `npm run smoke` to
   verify the install.
5. Updating: `git pull && npm install && npm run smoke` — DB migrations
   apply themselves on next start. Your DB lives at backend/data/ (or
   AUTOPILOT_DB_PATH); back it up before big pulls.
6. Windows notes: run commands in PowerShell; if `npx tsx` complains about
   execution policy, `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
   Portal RECORDING (visible browser) always runs on a local machine like
   this — use the "Record this portal" button's generated command/.bat.
   A server started in a console window (`cmd /k npm start`, `start.bat`)
   turns QuickEdit off for that window at boot, so a click or text selection
   in it can no longer freeze the server (#360). No launcher change is needed;
   `AUTOPILOT_KEEP_QUICKEDIT=1` keeps QuickEdit on. Edit → Mark and Ctrl+S
   (scroll lock) still pause console output until Esc is pressed.


## Deploy (one VM, ~$20–40/mo: Hetzner / DigitalOcean / Lightsail; 4GB+ RAM)

```bash
git clone <repo> && cd SOLAR-Proj && npm install
npx playwright install --with-deps chromium
```

Create `/etc/solar-autopilot.env` (chmod 600):
```
AUTH_ENABLED=true
SERVER_HOST=0.0.0.0                     # listen beyond loopback ON PURPOSE (the default is 127.0.0.1)
SERVER_IS_SHARED=1                      # dashboard hides/relabels controls that read the SERVER'S disk (#439); detected anyway with the two lines above
ADMIN_EMAIL=you@company.com
ADMIN_PASSWORD=<strong password>        # first login; change after
ANTHROPIC_API_KEY=sk-ant-...
SESSION_ENCRYPTION_KEY=<openssl rand -hex 32>   # portal credentials at rest — LOSING THIS LOSES STORED LOGINS
ALLOWED_ORIGINS=https://autopilot.yourco.com     # lock CORS to your domain
AUTOPILOT_DB_PATH=/var/lib/solar/autopilot.db   # persistent disk
PORTAL_HEADLESS=true
DOCUMENT_FETCH_BROWSER=0                # no headed-browser fallback for walled documents: a server has no display
PUBLIC_BASE_URL=https://autopilot.yourco.com   # client-facing links in emails; NEVER leave the localhost default in production
PORT=4000
```

systemd unit (`/etc/systemd/system/solar.service`):
```
[Service]
WorkingDirectory=/opt/SOLAR-Proj
EnvironmentFile=/etc/solar-autopilot.env
ExecStart=/usr/bin/npx tsx backend/src/server.ts
Restart=always
[Install]
WantedBy=multi-user.target
```

HTTPS front door (Caddy — automatic certificates):
`caddy reverse-proxy --from autopilot.yourco.com --to localhost:4000`

Rules: ONE instance only (SQLite). Updates: `git pull && npm install
&& npm run smoke && systemctl restart solar` — migrations self-apply.
Confirm the restart took: the banner / `curl localhost:4000/health` → `build.label`
reads the new commit (`2026.09.24 · 0c466bb`; date version from the running code's
own git commit — see DEPLOY.md §4). A git checkout needs no `BUILD_*` env vars.
NEVER run with AUTH_ENABLED unset on a public interface.

Where the server listens (#82): with no `SERVER_HOST` it binds `127.0.0.1`, so
only this machine reaches it. Caddy on the same box proxies to `localhost:4000`
and works with that default; set `SERVER_HOST=0.0.0.0` only when something on
another machine (a load balancer, Fly's proxy, a published Docker port) must
connect directly. With `AUTH_ENABLED` off and a non-loopback `SERVER_HOST`, the
server refuses to start and says why; `ALLOW_UNAUTHENTICATED_NETWORK=1` overrides
that, and then every customer's data is open to the network without a login.

Outbound document fetches (#391): blank forms and fee schedules are downloaded
server-side, and the form-fill tool (`/api/tools/form-fill/*`, reachable with an
org API key) fetches URLs its caller chose. Every such fetch refuses private,
loopback and link-local addresses (cloud metadata included) on the URL and on
every redirect hop. Those tool routes never open the headed-browser fallback;
`DOCUMENT_FETCH_BROWSER=0` turns it off for every caller and belongs on any
server. Leave `DOCUMENT_FETCH_ALLOW_ORIGINS` unset: it exists for the test
suites' local stub servers.

### Backups — two halves, and you need both

Project state lives in **two** places: rows in SQLite, and the uploaded files
(plan sets, sealed structural letters, meter photos, split sheets) under
`PROJECT_DOCS_DIR` (default `backend/data/project-documents`). A database-only
backup restores clean-looking projects whose every document 404s, so each
snapshot does both:

- `POST /api/admin/backup` / the scheduler writes `backups/autopilot-<ts>.sqlite`
  and mirrors new document files into `backups/documents/`. The mirror is
  append-only and is deliberately NOT pruned with the rotating snapshots — a
  14-day-old snapshot restored tomorrow still needs the files it referenced.
- Each run also counts document rows whose file is missing from the live tree
  and logs `[backup] WARNING: N document row(s) point at files missing…`. That
  line means data has already been lost locally; look for the copy in
  `backups/documents/`.

`litestream.yml` replicates **only the SQLite file** — continuous DB replication,
not files. So the off-box copy still matters: nightly `restic`/`rclone` of the
whole data dir (or at minimum `backups/`) to S3/R2. Restore = `litestream restore`
(or the newest snapshot) **plus** the document tree; do the files first, so the
restored rows point at something.

Env: `BACKUP_DIR`, `BACKUP_KEEP` (snapshots, default 14), `BACKUP_INTERVAL_HOURS`
(default 24), `PROJECT_DOCS_DIR`.

## Employee logins

- Log in as admin (ADMIN_EMAIL/PASSWORD) at the dashboard → session cookie.
- Give teammates logins from the dashboard: **Team** → **Add**, fill name and
  email, type a **Sign-in password** (10+ characters; Operator or Admin), Save.
  Tell them the password privately. For someone already on the team without a
  login, select them and use **Set password** in the **Sign-in** section; the
  same section resets a password and switches a login off (they are signed out
  on their next click) or back on. Everyone changes their own password under
  **Change my password** (asks for the current one). Admins only, your own org
  only, every action in the audit log with who did it. With sign-in off these
  sections say so and do nothing.
  API behind it: `GET/POST /api/staff/logins`,
  `POST /api/staff/logins/:id/password {"password"}`,
  `POST /api/staff/logins/:id/active {"active"}`,
  `POST /api/auth/password {"currentPassword","newPassword"}`.
  The older `POST /api/orgs/:id/users {"email","name","password"}` still works.
  Passwords hashed; API keys sha256 + shown once.
- A password reset does not end a session already open elsewhere (sessions are
  signed cookies, up to AUTH_SESSION_HOURS). To cut someone off at once,
  deactivate the login.
- Assign projects per user (`projects.assigned_user_id`, dashboard selector).
- `/api/auth/login` / `/api/auth/logout`; everything else 401s without a
  session or `x-api-key`.

## Client-facing links (work without a login — safe to send)

- **Project status page**: dashboard → "Share status link" →
  `https://<host>/status?token=…` backed by `/api/public/status/:token`
  (revocable per project; token-scoped, read-only, no PII beyond status).
- **Review reports**: shareable read-only report links per review submission
  (`/api/public/review/...`) — what an AHJ/applicant sees from the Plan
  Review product.
- Both paths are explicitly exempted in `auth.ts` (`/api/public/`); anything
  new that clients should see belongs under that prefix.

## Recording portals after the move

The human "record this portal" capture runs on an operator's LOCAL machine
(needs a visible browser) and talks to the server API — set the server URL in
the record command the dashboard generates. Learning/staging runs headless on
the server itself.

## Stripe — collecting client payments (per-submission billing)

Today (no code needed):
1. Create a Stripe account → Payment Links (or Invoices) for your common
   totals, or create one ad-hoc per quote (the Payment screen shows the
   client total = real permit fees + your service fee).
2. Send the client the link; when Stripe shows it paid, click **Mark paid**
   on the project's Payment panel and paste the Stripe payment/invoice id
   into the reference field — it lands in `submission_payments.payment_reference`
   and the staging gate unlocks. Waive covers comped jobs.

When you want it automatic (small build, ~a day):
- `npm i stripe`; env `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.
- On quote: create a Checkout Session/Payment Link for `totalUsd`, store its
  id on the payment row, show the URL on the Payment panel.
- Webhook `POST /api/public/stripe/webhook` (public prefix, signature-verified
  with the webhook secret): on `checkout.session.completed`, call
  `markSubmissionPaid` with the session id as the reference. Never trust the
  client side — only the signed webhook marks paid.
- SaaS metering later: Stripe usage records wired into `checkReviewQuota`.
