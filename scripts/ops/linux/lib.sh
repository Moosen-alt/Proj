# Shared helpers for the Linux server scripts (docs/OPERATIONS_LINUX.md, #437). Sourced, not run.
#
# Settings (all optional; the defaults are the runbook's layout):
#   KEELIX_REPO     the git checkout docker compose runs from      (default /opt/keelix)
#   KEELIX_STATE    host folder mounted at /app/backend/data       (default /srv/keelix/backend-data)
#   KEELIX_PORT     host port the app is published on, 127.0.0.1   (default 4173)
#   KEELIX_IMAGE    image repository                               (default solar-submission-autopilot)
#   KEELIX_QUIET_TIMEOUT  seconds to wait for jobs.running = 0     (default 1800)
#   KEELIX_DEPLOY_LOG     one line per deploy and rollback         (default /srv/keelix/deploys.log)
#   KEELIX_BUILD_FLAGS    extra docker build flags (deploy.sh)     (default none)
# Needs: docker (Compose v2.24+), curl, jq, git.

KEELIX_REPO="${KEELIX_REPO:-/opt/keelix}"
KEELIX_STATE="${KEELIX_STATE:-/srv/keelix/backend-data}"
KEELIX_PORT="${KEELIX_PORT:-4173}"
KEELIX_IMAGE="${KEELIX_IMAGE:-solar-submission-autopilot}"
KEELIX_QUIET_TIMEOUT="${KEELIX_QUIET_TIMEOUT:-1800}"
KEELIX_DEPLOY_LOG="${KEELIX_DEPLOY_LOG:-/srv/keelix/deploys.log}"
KEELIX_HEALTH="http://127.0.0.1:${KEELIX_PORT}/health"
# The state folder as the container sees it (AUTOPILOT_STATE_DIR in the image).
KEELIX_STATE_IN_CONTAINER="/app/backend/data"

say() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

compose() { docker compose --project-directory "$KEELIX_REPO" "$@"; }

# /health as JSON, or nothing when the server does not answer.
health_json() { curl -fsS --max-time 5 "$KEELIX_HEALTH" 2>/dev/null || true; }

# The short sha of the running build, or "" (not up, or an unstamped image).
running_sha() { health_json | jq -r '.build.sha // empty' 2>/dev/null | cut -c1-7; }

# Block until no job is running, so no portal run is cut off mid-form by the swap. A run that is
# filling a portal when the container stops leaves a half-filled draft on a real account.
wait_quiet() {
  local waited=0 running
  while :; do
    running="$(health_json | jq -r '.jobs.running // empty' 2>/dev/null)"
    [ -n "$running" ] || die "the server is not answering $KEELIX_HEALTH; nothing to wait for (use --not-running to skip)"
    [ "$running" = "0" ] && { say "quiet: jobs.running = 0"; return 0; }
    [ "$waited" -ge "$KEELIX_QUIET_TIMEOUT" ] && die "still $running job(s) running after ${KEELIX_QUIET_TIMEOUT}s; try again later"
    say "waiting: $running job(s) running"
    sleep 15; waited=$((waited + 15))
  done
}

# A named, consistent copy of the live database, taken through SQLite's online backup inside the
# running container. The name does not match autopilot-<digit>..., so rotation never deletes it.
# Prints the host path. $1 = label, e.g. pre-deploy-1a2b3c4.
named_snapshot() {
  local name="autopilot-$1-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  compose exec -T app node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.argv[1], { fileMustExist: true });
    db.backup(process.argv[2]).then(() => { db.close(); }).catch((e) => { console.error(e.message); process.exit(1); });
  ' "$KEELIX_STATE_IN_CONTAINER/autopilot.sqlite" "$KEELIX_STATE_IN_CONTAINER/backups/$name" >&2 \
    || die "snapshot failed; nothing was changed"
  [ -s "$KEELIX_STATE/backups/$name" ] || die "snapshot $name is missing or empty on the host"
  printf '%s\n' "$KEELIX_STATE/backups/$name"
}

# Wait until /health reports build $1 (short sha). Fails after $2 seconds (default 180).
wait_build() {
  local want="$1" limit="${2:-180}" waited=0 have
  while :; do
    have="$(running_sha)"
    [ "$have" = "$want" ] && { say "/health reports build $have"; return 0; }
    [ "$waited" -ge "$limit" ] && die "/health still reports '${have:-no answer}' after ${limit}s, wanted $want (docker compose logs app)"
    sleep 3; waited=$((waited + 3))
  done
}

# Point the tag docker-compose.override.yml runs (":current") at $1 and recreate the container.
swap_to() {
  docker image inspect "$KEELIX_IMAGE:$1" >/dev/null 2>&1 || die "no image $KEELIX_IMAGE:$1 on this box (docker images $KEELIX_IMAGE)"
  docker tag "$KEELIX_IMAGE:$1" "$KEELIX_IMAGE:current"
  compose up -d --no-build app
}

log_deploy() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$KEELIX_DEPLOY_LOG" 2>/dev/null || true; }
