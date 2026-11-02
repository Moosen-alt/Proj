# Operations runbook: the Linux server

How the hosted server is set up and run: one Linux VM (Hetzner CCX23 in Hillsboro, the migration
plan on epic #429) with the app in Docker, Cloudflare Tunnel and Access in front, backups on three
layers, and updates shipped as images. The Windows desk keeps [OPERATIONS.md](OPERATIONS.md); the
TypeScript ops scripts (`preflight`, `watchdog`, `offbox-sync`, `restore-drill`) are the same on
both, and the unit files and shell scripts for this box live in
[`scripts/ops/linux/`](../scripts/ops/linux/).

**What was run.** Every command in §1, §2, §4 (restic and the off-box sync), §5, §6 and §7 was run
on 2026-11-02 in a scratch Linux machine with Docker 29 and Compose 5.6 against a scratch clone:
two deploys, a deploy that waited out a running job, a code rollback and a rollback with a
database restore, the watchdog, the off-box sync, the restore drill, a restic backup and restore,
and the login lockout through the published port. Lines marked **(untested)** were not: the
Cloudflare dashboard (no account in the sandbox), Litestream, the volume mount commands and
`systemctl` itself (the unit files passed `systemd-analyze verify`). Run them once on the real box
and watch the result. **The image does not build on `main` today (#481)**: until that one-line fix
merges, every deploy fails at the Playwright step.

**How an update ships after the move:** merge to `main`, then on the server
`sudo /opt/keelix/scripts/ops/linux/deploy.sh origin/main`. It builds the new image while the old one
keeps serving, waits until no job is running, takes a named database snapshot, swaps the container,
and confirms `/health` reports the new commit (§6). Rolling back is one command (§7).

```
customer / teammate ──https──▶ Cloudflare edge ──(Access: Google sign-in, or Bypass for customer links)
                                     │
                               cloudflared (outbound tunnel, no inbound ports)
                                     │ http://127.0.0.1:4173
                               docker: app container (sign-in on, AUTH_ENABLED=true)
                                     │
             /srv/keelix/backend-data  (state volume)    /mnt/keelix-offbox (second volume)
                                     │                              │
                         restic nightly + Litestream ──▶ object storage in the US (another provider)
```

## 1. The box

Ubuntu 24.04, a Hetzner Cloud firewall that allows **SSH only**, a 100 GB volume for state and a
small second volume for the backup copy (§4). As root:

```bash
# Docker (Compose 2.24+ for the !override tags), plus the tools the scripts use
apt-get update && apt-get install -y ca-certificates curl jq git restic
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
# (untested: the sandbox had Docker preinstalled)

# State: ONE folder, flat (#430). The container's node user is uid 1000.
mkdir -p /srv/keelix/backend-data /mnt/keelix-offbox
chown -R 1000:1000 /srv/keelix /mnt/keelix-offbox

# The code
git clone https://github.com/Moosen-alt/Proj /opt/keelix
cp /opt/keelix/scripts/ops/linux/docker-compose.override.yml /opt/keelix/
```

[`docker-compose.override.yml`](../scripts/ops/linux/docker-compose.override.yml) publishes the
port on `127.0.0.1` only, mounts `/srv/keelix/backend-data` at `/app/backend/data`
(`AUTOPILOT_STATE_DIR`: database, documents, backups, portal profiles, the draft ledger, run bundles,
screenshots and logs, all in that one folder) and the second volume at `/app/offbox`, and runs the
image tag `solar-submission-autopilot:current` that §6 sets. Since #430 the separate `/srv/keelix/data`
and `/srv/keelix/portal-profiles` mounts from the first migration plan are not needed: everything is
under `backend-data`, so on cutover the draft ledger goes to `/srv/keelix/backend-data/portal-drafts.jsonl`.

The first start is a deploy with nothing to wait for: write `.env` (§2), then
`/opt/keelix/scripts/ops/linux/deploy.sh origin/main --not-running`.

## 2. Settings (`/opt/keelix/.env`, chmod 600)

```ini
NODE_ENV=production
AUTH_ENABLED=true                 # the WORD true; "1" is ignored (backend/src/auth.ts)
ADMIN_EMAIL=<a new address>       # first sign-in only; then add the team on the Team panel (#431)
ADMIN_PASSWORD=<long passphrase>  # delete this line after the first sign-in (preflight warns)
AUTH_SECRET=<openssl rand -base64 32>        # its own value, never the session key
SESSION_ENCRYPTION_KEY=<from the password manager>   # the desk's key, unchanged, or saved logins are unreadable
AUTH_COOKIE_SECURE=true
TRUST_PROXY=uniquelocal           # see below
SERVER_IS_SHARED=1                # shared-server dashboard (#439); not detected behind a loopback tunnel
PUBLIC_BASE_URL=https://keelix.<your domain>
ALLOWED_ORIGINS=https://keelix.<your domain>
ANTHROPIC_API_KEY=<a key for the server>
PORTAL_HEADLESS=true
PORTAL_HEADED_RETRY=0             # until the image has a virtual display (#434)
DOCUMENT_FETCH_BROWSER=0          # no headed fallback for walled documents: a server has no display
SEED_TEST_INSTALLER=false
MONITOR_INTERVAL_MINUTES=15
# Concurrency, from SCALE_DEPLOYMENT.md (16 GB box): the two knobs equal, and the profile wait
# longer than (slots - 1) x PORTAL_RUN_MAX_MS = 75 min, or a queued filing for a busy portal gives up.
JOB_CONCURRENCY=4
MAX_CONCURRENT_PORTAL_RUNS=4
MAX_JOBS_PER_TICK=20
PORTAL_PROFILE_WAIT_MS=5400000
# Backups (§4); BACKUP_SECOND_DIR is set in the compose override, next to its mount
BACKUP_INTERVAL_HOURS=2
BACKUP_KEEP=84
BACKUP_SECOND_KEEP=84
# Alerts (§5)
WATCHDOG_ALERT_TO=<you>, <second person>
WATCHDOG_WEBHOOK_URL=https://ntfy.sh/<long-random-topic>
WATCHDOG_WEBHOOK_FORMAT=text
WATCHDOG_HEARTBEAT_URL=https://hc-ping.com/<uuid>
WATCHDOG_NAME=Keelix server
# Client email and the tracking inbox (§5.1): the desk's lines where it has them
SMTP_HOST=<mail server>
SMTP_FROM=<the address clients see>
SMTP_PORT=587
SMTP_USER=<mail account>
SMTP_PASS=<app password>
EMAIL_IMAP_HOST=<shared inbox's IMAP server>   # or the GMAIL_* lines, with GMAIL_REDIRECT_URI moved (§5.1)
EMAIL_IMAP_USER=<shared inbox>
EMAIL_IMAP_PASS=<app password>
STAFF_ALERT_TO=<you>, <your PM>   # staff alerts (#487); and/or STAFF_ALERT_WEBHOOK_URL
```

Leave out `PORT` (the image listens on 4173, which the override publishes) and the per-path settings
(`AUTOPILOT_DB_PATH`, `PROJECT_DOCS_DIR`, `PORTAL_PROFILES_DIR`, `BACKUP_DIR`): each wins over the
state root and would split the state again (DEPLOY.md §3).

**`PORTAL_ALLOW_FINAL_SUBMIT` stays unset** on this server until #436 lands (the owner's 2026-10-31
ruling): on a headless box the one-click run would file with nobody seeing the review page. Until then
staff finish NEM drafts by hand in the portal. With sign-in off it is a preflight FAIL in any case.

**Why `TRUST_PROXY=uniquelocal`.** The login lockout (8 failures lock an address for 15 minutes)
keys on the client address. cloudflared connects to `127.0.0.1:4173`, and Docker hands that
connection to the container from its bridge network (172.18.0.1 in the test), not from loopback. With
the default (`loopback`) every teammate is that one address: in the test, 8 wrong passwords from one
client locked out the next client's correct password (HTTP 429). With `uniquelocal` Express trusts
that private hop and reads the client from `X-Forwarded-For`, taking the right-most entry Cloudflare
appended, so a client-written entry cannot dodge the lockout (both checked in the test). `true` would
trust the client-written left-most entry; preflight warns on it.

## 3. Cloudflare Tunnel and Access

No inbound ports: `cloudflared` on the host dials out to Cloudflare, and only Cloudflare can send
traffic in. **(untested: no Cloudflare account in the sandbox.)**

1. **Tunnel.** Zero Trust dashboard, Networks, Tunnels: create a tunnel (type Cloudflared), and run the
   install command it shows on the server (`cloudflared service install <token>`; it installs the
   `cloudflared` systemd service). Add a public hostname `keelix.<your domain>`, service
   `HTTP`, URL `127.0.0.1:4173`.
2. **Access for the team.** Access, Applications: add a self-hosted application on
   `keelix.<your domain>` (no path: the whole host) with an **Allow** policy for the team: Google as the
   identity provider, and the team's addresses (or the company's Google Workspace domain). Session
   duration 24 h. App sign-in stays on behind it: Access says who may reach the server, the app says
   who did what.
3. **Bypass for customer links.** Add a second self-hosted application named "Keelix customer links"
   with one destination per path below on the same hostname, and a single **Bypass** policy (Include:
   Everyone). The more specific path wins over the whole-host application, so these paths skip the
   Google sign-in and reach the app, whose own tokens gate them. If the dashboard limits destinations
   per application, split the list over several applications with the same policy.

<!-- access-bypass:begin (generated: npx tsx scripts/ops/linux/access-bypass.ts; pinned by backend/test/accessBypass.test.ts) -->
| Path (on `keelix.<your domain>`) | What it is |
| --- | --- |
| `/status` | customer status page (link carries a token) |
| `/api/public/status/*` | the status page's data, token-scoped, read-only |
| `/intake` | customer intake page (link carries a token) |
| `/api/intake/*` | the intake page's data, token-scoped |
| `/credentials` | one-time portal-credential drop box (link carries a token) |
| `/api/public/credential-request/*` | the drop box's data, token-scoped, one use |
| `/portal` | per-client tracker page (link carries a token) |
| `/api/public/portal/*` | the tracker's data, token-scoped, read-only |
| `/api/public/review/*` | shared review report, token-scoped, read-only |
| `/styles.css` | stylesheet the logged-out pages load |
| `/favicon.ico` | tab icon |
| `/assets/brand/*` | logo images on the logged-out pages |
| `/vendor/*` | vendored font and libraries the logged-out pages load |
<!-- access-bypass:end -->

The list is exactly the paths the app itself serves without a login (`requireAuth` in
`backend/src/auth.ts`), and nothing wider: `backend/test/accessBypass.test.ts` drives the real gate
over every route and file and fails if a bypass path could reach anything the app gates (hard rule 6)
or if the app opens a path that is neither here nor deliberately kept behind Access (`/login`,
`/api/auth/*`, `/health`). Never bypass `/api/*` or the whole host. Add a path here only by changing
`backend/src/accessBypass.ts` and re-running the script.

4. **Service token for the recorder (#433).** Access, Service Auth: create a service token
   "keelix-recorder", and add a **Service Auth** policy that includes it to the whole-host application.
   The recorder CLI sends it as `CF-Access-Client-Id` / `CF-Access-Client-Secret`; until #433 ships
   that, recording stays on the desk.
5. **Check from the outside:**

   ```bash
   /opt/keelix/scripts/ops/linux/keelix-ops.sh preflight --probe-edge
   ```

   The EDGE lines must read `PASS Access on staff paths` (`/health` from outside is sent to the
   Cloudflare sign-in), `PASS Access bypass` (`/status` reaches the app's page) and `PASS via Cloudflare`.
   A FAIL on staff paths means the app answers the internet without Access; fix it before anyone uses
   the address.

## 4. Backups: three layers

| Layer | What | Where | How often | Loses at most |
| --- | --- | --- | --- | --- |
| Snapshots | the database (`backups/autopilot-<stamp>.sqlite` + `.sha256`) and the document mirror | state volume | every 2 h, kept 7 days (the server's own scheduler) | 2 h |
| Second copy | the snapshots, re-hashed, and the document mirror | the second volume, `/mnt/keelix-offbox` | every 2 h (`keelix-offbox-sync.timer`) | survives the state volume being lost, full or damaged |
| Off-site | the whole state folder, encrypted (restic); the live database continuously (Litestream, optional) | object storage in the US at another provider | nightly; seconds | survives losing the box, the volumes, or the Hetzner account |

Hetzner's backup feature covers the server's own disk, not attached volumes, so it does not back up
the state; leave it on for the system disk. Hetzner Storage Boxes are in Germany and Finland only, which
is why the off-site copy goes to a US bucket instead (Backblaze B2 US West, or Cloudflare R2 with a
North America location hint); the plan chose Hillsboro to keep customer data in the US.

**The second volume.** Create a 20 GB Hetzner volume, attach it to the server, and mount it at
`/mnt/keelix-offbox` (the console shows the `/etc/fstab` line; add `nofail`), then
`chown 1000:1000 /mnt/keelix-offbox`. **(untested)** The sync unit refuses to run when nothing is
mounted there, and preflight now says "same filesystem as the database" when the second copy is on
the state volume's own disk (judged by device, not by drive letter).

**Install the timers** (the unit files are in `scripts/ops/linux/`):

```bash
cd /opt/keelix/scripts/ops/linux
cp keelix-watchdog.service keelix-watchdog.timer keelix-offbox-sync.service keelix-offbox-sync.timer \
   keelix-restic.service keelix-restic.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now keelix-watchdog.timer keelix-offbox-sync.timer keelix-restic.timer
systemctl list-timers 'keelix-*'          # (untested: no systemd in the sandbox; units passed systemd-analyze verify)
```

**restic (off-site).** Make a bucket and an application key limited to it, then:

```bash
mkdir -p /etc/keelix && chmod 700 /etc/keelix
openssl rand -base64 32 > /etc/keelix/restic.pass && chmod 600 /etc/keelix/restic.pass
cat > /etc/keelix/restic.env <<'EOF'
RESTIC_REPOSITORY=s3:https://<the bucket's S3 endpoint>/<bucket>/keelix
RESTIC_PASSWORD_FILE=/etc/keelix/restic.pass
AWS_ACCESS_KEY_ID=<key id>
AWS_SECRET_ACCESS_KEY=<application key>
EOF
chmod 600 /etc/keelix/restic.env
set -a; . /etc/keelix/restic.env; set +a
restic init
/opt/keelix/scripts/ops/linux/restic-backup.sh      # first copy by hand; the timer runs it nightly
```

[`restic-backup.sh`](../scripts/ops/linux/restic-backup.sh) copies the whole state folder except the
live database file and its `-wal`/`-shm` (a file copy of a database being written can be torn); the
newest 2-hourly snapshot is the database in that copy. It keeps 14 daily, 8 weekly and 6 monthly
copies and reads back a slice every Sunday. Tested against a local repository: the live database was
excluded, the snapshots and their checksums were in, and `restic restore latest --target <dir>`
brought the folder back.

**Escrow.** Put the restic password (`/etc/keelix/restic.pass`) in the company password manager next
to `SESSION_ENCRYPTION_KEY`, with a second person given access. Without it the off-site copy cannot be
read; without the session key no saved portal login can.

**Litestream (optional, continuous).** **(untested)** Install the Litestream `.deb` from its GitHub
release, write `/etc/keelix/litestream.env` (`LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT`,
`LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, chmod 600), then
`cp keelix-litestream.service /etc/systemd/system/ && systemctl enable --now keelix-litestream`. It
runs as uid 1000 with [`scripts/ops/linux/litestream.yml`](../scripts/ops/linux/litestream.yml); stop it
before any database restore (`rollback.sh` refuses while it runs).

**Restore drill, on the server, with the escrowed key** (monthly, and after any backup change):

```bash
read -rs SESSION_ENCRYPTION_KEY && export SESSION_ENCRYPTION_KEY    # paste from the password manager
/opt/keelix/scripts/ops/linux/keelix-ops.sh restore-drill --no-dotenv --from /app/offbox
unset SESSION_ENCRYPTION_KEY
```

It must end `RESTORE DRILL: PASS` with every saved login decrypting (OPERATIONS.md §5.4 explains each
line). Once a quarter, restore the restic copy onto a fresh VM and run the drill there: that is the
test that the box can die.

## 5. Watchdog

`keelix-watchdog.timer` runs `scripts/ops/watchdog.ts --once` every 5 minutes in a one-off container
([`keelix-ops.sh`](../scripts/ops/linux/keelix-ops.sh)), so it can report the app container being down.
It reaches the app by its compose name (`http://app:4173/health`) and keeps its state in the state
folder (`ops/`). What it watches, and the message wording, are OPERATIONS.md §6. Set the alert lines in
§2, then:

```bash
K=/opt/keelix/scripts/ops/linux/keelix-ops.sh
$K watchdog --print-config
$K watchdog --test-alert          # must arrive on every channel (untested: no real channel in the sandbox)
$K watchdog --once --dry-run      # evaluates everything, sends nothing
```

`WATCHDOG_HEARTBEAT_URL` (healthchecks.io, 5 min period, 15 min grace) is what tells you when the whole
VM is off.

### 5.1 Notifications: client email, the tracking inbox and customer links

Nothing stops the server from running with these unset, which is why they go missing: without SMTP every
client update is saved as a draft and never sent; without a tracking inbox no correction, approval or
utility email is ever read; with a wrong `PUBLIC_BASE_URL` every link a client gets is dead. Preflight
has a NOTIFICATIONS block for them (WARN, with the line to add) and counts the client emails waiting.

1. **Client email.** The `SMTP_*` lines in §2: the mail account client updates should come from
   (the watchdog's email uses it too). Restart the app (`docker compose up -d app`) after any `.env` change.
2. **Tracking inbox.** Either the shared inbox clients forward agency mail to, over IMAP
   (`EMAIL_IMAP_HOST`, `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASS`; port 993 with TLS unless
   `EMAIL_IMAP_PORT` / `EMAIL_IMAP_TLS=false` say otherwise), or Gmail. For Gmail, copy
   `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`, and either copy the desk's `GMAIL_REFRESH_TOKEN` or
   authorize again from the server: add `https://keelix.<your domain>/api/gmail/oauth/callback` as a
   redirect URI on the Google OAuth client, set
   `GMAIL_REDIRECT_URI=https://keelix.<your domain>/api/gmail/oauth/callback`, restart, open
   `https://keelix.<your domain>/api/gmail/auth-url` signed in, follow the `url` it returns, and put
   the `GMAIL_REFRESH_TOKEN=` line the callback page shows into `.env`. Restart. The inbox is read on
   every monitor tick, so leave `MONITOR_INTERVAL_MINUTES` at 15 (preflight warns on 0, which only a
   test copy should have).
3. **Customer links.** `PUBLIC_BASE_URL=https://keelix.<your domain>` (§2); preflight FAILs on a
   localhost or missing value.
4. **Staff alerts.** The watchdog's `WATCHDOG_ALERT_TO` and ntfy lines (§5) cover the server being
   down. Alerts to the team when a run stops or a job changes state, and the morning digest, come with
   #487: `STAFF_ALERT_TO=<you>, <your PM>` (uses SMTP) and/or `STAFF_ALERT_WEBHOOK_URL=<ntfy topic>`,
   and `STAFF_DIGEST_HOUR`. Preflight's `staff alerts` line reads those names; they do nothing until
   #487 is deployed.
5. **Test send, to yourself:**

   ```bash
   K=/opt/keelix/scripts/ops/linux/keelix-ops.sh
   $K preflight                                  # NOTIFICATIONS: every line PASS
   $K test-email --to you@yourcompany.com        # prints the mail server's answer; exit 0 = accepted
   ```

   `test-email` sends one fixed message to the one address named, never to a client, and prints what
   the mail server answered (`250 ...` when it took the message, or its refusal, such as
   `535 5.7.8` for a wrong password). Then check the inbox, and the spam folder: mail landing in spam
   means the sending domain needs SPF/DKIM for that mail server. The message shows the address client
   links start with; open it from a phone off the office network. **(untested against a real mail
   server: the sandbox has none.)**
6. **Waiting client emails.** If preflight's `unsent client emails` line counts any (drafts saved
   while SMTP was off, or sends that failed), list them and, once steps 1 and 3 pass, re-send them:

   ```bash
   cd /opt/keelix
   docker compose stop app     # when /health shows jobs.running = 0, as for the recipe restore (§6)
   U="docker compose run --rm --no-deps -T -v /opt/keelix/scripts:/app/scripts:ro -e AUTOPILOT_DB_PATH=/app/backend/data/autopilot.sqlite app npx tsx scripts/undelivered.ts"
   $U            # lists them; sends nothing
   $U --send     # re-sends each one to the client's current address
   docker compose start app
   ```

   Read the list first: a message about a job that has since moved on may be better left unsent.

## 6. Deploying a new version

```bash
sudo /opt/keelix/scripts/ops/linux/deploy.sh origin/main     # or a tag or a sha that passed CI
```

[`deploy.sh`](../scripts/ops/linux/deploy.sh), in order, stopping at the first failure:

1. Checks out the ref (detached) and builds `solar-submission-autopilot:<sha>` with `BUILD_SHA` and
   `BUILD_DATE`, so `/health` says which commit runs. The server keeps serving while it builds (about
   90 s with a warm cache). It refuses when the checkout has local edits to tracked files.
2. Remembers the running build from `/health`: the rollback point.
3. Waits until `/health` shows `jobs.running = 0`, polling every 15 s for up to 30 minutes, so no
   portal run is cut off mid-form.
4. Takes a **named** snapshot, `backups/autopilot-pre-deploy-<old sha>-<time>.sqlite`, through SQLite's
   online backup inside the running container. Named snapshots are never rotated away.
5. Points `:current` at the new image and recreates the container (seconds of downtime; migrations
   run on its first start).
6. Waits until `/health` reports the new sha, appends a line to `/srv/keelix/deploys.log`, prints
   preflight, and prints the exact rollback command.

**After a deploy that pulls in recipe fixes**, restore the demoted recipes, as on the desk
(OPERATIONS.md §7.1, step 4). The script is not in the image, so it runs in a one-off container with
the app stopped; the dry run first:

```bash
cd /opt/keelix
docker compose stop app
R="docker compose run --rm --no-deps -T -v /opt/keelix/scripts:/app/scripts:ro -e AUTOPILOT_DB_PATH=/app/backend/data/autopilot.sqlite app npx tsx scripts/restore-demoted-recipes.ts"
$R            # lists RESTORE / KEEP per recipe; writes nothing
$R --apply
docker compose start app
```

A Submit that a portal guards with a browser `confirm()` dialog, on a run handed to a person (#472),
is answered in the browser's own dialog by that person; nothing on the server answers it.

Before step 5 nothing in production changes, and a failure puts the checkout back where it was.
Never run `docker compose up --build` on the server: it builds an unstamped image (`unknown build`)
and skips the wait and the snapshot. `KEELIX_BUILD_FLAGS` passes extra `docker build` flags (for
example `--network host` behind an egress proxy).

## 7. Rolling back

```bash
sudo /opt/keelix/scripts/ops/linux/rollback.sh <old sha>
sudo /opt/keelix/scripts/ops/linux/rollback.sh <old sha> --restore /srv/keelix/backend-data/backups/autopilot-pre-deploy-<old sha>-<time>.sqlite
```

The first form swaps the code only: the older image (still on the box from its deploy) runs against
today's database. That is right unless the newer build applied a migration the older code cannot read;
then use the second form, which also puts the database back to the named snapshot. Everything written
after that snapshot leaves the live database, so it asks you to type `restore`, stops the app, moves
the current database aside to `backups/pre-rollback-<time>/` (never deleted), copies the snapshot in,
and starts the old build. In the test the code rollback took 5 s, and a row written after the snapshot
was gone after the restore and present in the set-aside copy. Decide on a rollback within the first
day: work done after the snapshot has to be re-entered.

`docker images solar-submission-autopilot` lists the builds on the box; remove old ones now and then
with `docker image rm solar-submission-autopilot:<sha>`, keeping the last three.

## 8. Routine

| When | What | Look for |
| --- | --- | --- |
| After every deploy | the deploy's own preflight output | no FAIL |
| Weekly | `keelix-ops.sh preflight --probe-edge` | no FAIL; the three EDGE lines PASS; NOTIFICATIONS all PASS |
| Weekly | `systemctl list-timers 'keelix-*'` and `journalctl -u keelix-restic --since -7d` | every timer ran; restic ended without errors |
| Monthly | restore drill with the escrowed key (§4) | `RESTORE DRILL: PASS`, all logins decrypt |
| Quarterly | restic copy restored onto a fresh VM, drill there | PASS |

## 9. Files

| File | What it is |
| --- | --- |
| `scripts/ops/linux/docker-compose.override.yml` | loopback-only port, the two mounts, the `:current` image tag |
| `scripts/ops/linux/deploy.sh`, `rollback.sh`, `lib.sh` | §6 and §7 |
| `scripts/ops/linux/keelix-ops.sh` | runs `preflight`, `watchdog`, `offbox-sync`, `restore-drill` or `test-email` in a one-off container |
| `scripts/ops/linux/keelix-watchdog.{service,timer}` | §5, every 5 min |
| `scripts/ops/linux/keelix-offbox-sync.{service,timer}` | §4, every 2 h at :20 |
| `scripts/ops/linux/keelix-restic.{service,timer}`, `restic-backup.sh` | §4, nightly 03:30 |
| `scripts/ops/linux/keelix-litestream.service`, `litestream.yml` | §4, optional |
| `scripts/ops/linux/access-bypass.ts` | prints the §3 bypass list from `backend/src/accessBypass.ts` |
| `/srv/keelix/deploys.log` | one line per deploy and rollback |
