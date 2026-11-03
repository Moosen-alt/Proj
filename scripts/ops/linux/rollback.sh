#!/usr/bin/env bash
# ROLL BACK TO AN EARLIER BUILD ON THE LINUX SERVER (docs/OPERATIONS_LINUX.md §7, #437).
#
#   sudo /opt/keelix/scripts/ops/linux/rollback.sh <sha>                              # code only
#   sudo /opt/keelix/scripts/ops/linux/rollback.sh <sha> --restore <snapshot.sqlite>  # code + database
#
# Code only: points :current back at $KEELIX_IMAGE:<sha> (built by an earlier deploy.sh, still on
# this box) and recreates the container. The database stays as it is. That is right unless the
# newer build applied a migration the older code cannot read.
#
# --restore also puts the database back to a named snapshot (the "pre-deploy-<sha>" file deploy.sh
# printed). EVERYTHING written since that snapshot is lost from the live database (new projects,
# status changes, staged drafts recorded): it asks you to type the word restore first. The
# current database is moved aside into backups/pre-rollback-<stamp>/, never deleted.
# Stop Litestream first if you run it (systemctl stop keelix-litestream); the script refuses
# while it is active, because Litestream would replicate the swap as a new history.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

sha="${1:-}"; [ -n "$sha" ] || die "usage: rollback.sh <sha> [--restore <snapshot.sqlite>]"
snap=""
if [ "${2:-}" = "--restore" ]; then
  snap="${3:-}"; [ -f "$snap" ] || die "--restore needs an existing snapshot file (ls $KEELIX_STATE/backups/autopilot-pre-deploy-*)"
fi
docker image inspect "$KEELIX_IMAGE:$sha" >/dev/null 2>&1 || die "no image $KEELIX_IMAGE:$sha here (docker images $KEELIX_IMAGE)"

now="$(running_sha)"
say "running now: ${now:-not answering}; rolling back to $sha"
[ -n "$now" ] && wait_quiet

if [ -n "$snap" ]; then
  if systemctl is-active --quiet keelix-litestream 2>/dev/null; then
    die "keelix-litestream is running: systemctl stop keelix-litestream, then run this again"
  fi
  echo "This replaces the live database with $(basename "$snap")."
  echo "Everything written after that snapshot is taken out of the live database (kept aside, not deleted)."
  read -r -p "Type restore to go on: " answer
  [ "$answer" = "restore" ] || die "not confirmed; nothing changed"
  say "stopping the app"
  compose stop app
  aside="$KEELIX_STATE/backups/pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$aside"
  for f in autopilot.sqlite autopilot.sqlite-wal autopilot.sqlite-shm; do
    [ -e "$KEELIX_STATE/$f" ] && mv "$KEELIX_STATE/$f" "$aside/"
  done
  cp "$snap" "$KEELIX_STATE/autopilot.sqlite"
  chown -R 1000:1000 "$aside" "$KEELIX_STATE/autopilot.sqlite"
  say "database restored from $(basename "$snap"); the replaced one is in $aside"
fi

# Keep the checkout on the same commit, so the ops scripts the timers mount match the running build.
if git -C "$KEELIX_REPO" cat-file -e "$sha^{commit}" 2>/dev/null; then
  git -C "$KEELIX_REPO" -c advice.detachedHead=false checkout --quiet --detach "$sha"
fi
swap_to "$sha"
wait_build "$sha" 300
log_deploy "rollback to $sha (was ${now:-none})${snap:+ restore=$(basename "$snap")}"
echo "Rolled back to $sha."
