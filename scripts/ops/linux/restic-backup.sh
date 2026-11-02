#!/usr/bin/env bash
# NIGHTLY RESTIC COPY OF THE STATE FOLDER (keelix-restic.timer, docs/OPERATIONS_LINUX.md §4).
#
# Settings come from /etc/keelix/restic.env (chmod 600, root): RESTIC_REPOSITORY,
# RESTIC_PASSWORD_FILE and the bucket keys (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for
# S3-compatible storage such as Cloudflare R2 or Backblaze B2). The restic password is the ONLY
# way to read this copy: escrow it with SESSION_ENCRYPTION_KEY.
#
# WHAT IS COPIED: everything under the state folder (documents, the backups/ snapshots and their
# document mirror, the draft ledger, portal profiles, run bundles, logs) EXCEPT the live database
# file and its -wal/-shm: a file copy of a database that is being written can be torn. The newest
# backups/autopilot-<stamp>.sqlite (at most BACKUP_INTERVAL_HOURS old) is the database in this copy;
# Litestream, when on, covers the minutes in between.
set -euo pipefail
STATE="${KEELIX_STATE:-/srv/keelix/backend-data}"
: "${RESTIC_REPOSITORY:?set in /etc/keelix/restic.env}"

restic backup "$STATE" \
  --tag keelix-nightly \
  --exclude "$STATE/autopilot.sqlite" \
  --exclude "$STATE/autopilot.sqlite-wal" \
  --exclude "$STATE/autopilot.sqlite-shm" \
  --exclude "$STATE/autopilot.sqlite-litestream" \
  --exclude "$STATE/.autopilot.sqlite-litestream"
restic forget --tag keelix-nightly --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune
# Sundays: read back a slice of the stored data, so a damaged copy is found before it is needed.
if [ "$(date +%u)" = 7 ]; then restic check --read-data-subset=1/20; fi
