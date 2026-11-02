#!/usr/bin/env bash
# DEPLOY A NEW VERSION ON THE LINUX SERVER (docs/OPERATIONS_LINUX.md §6, #437).
#
#   sudo /opt/keelix/scripts/ops/linux/deploy.sh <git ref>            # a tag, a sha or origin/main
#   sudo /opt/keelix/scripts/ops/linux/deploy.sh <git ref> --not-running   # first start: nothing to wait for or snapshot
#
# In order, stopping at the first failure with production untouched until step 5:
#   1. check out <ref> (detached) in KEELIX_REPO and build it as $KEELIX_IMAGE:<sha>, stamped with
#      BUILD_SHA/BUILD_DATE so /health says which commit runs. The server keeps running meanwhile.
#   2. remember the running build: that is the rollback point.
#   3. wait until /health shows jobs.running = 0 (no portal run is cut off mid-form).
#   4. take a NAMED snapshot of the live database (never rotated away): the restore point if this
#      version's migrations must be undone.
#   5. tag the new image :current and recreate the container (seconds of downtime; migrations run
#      on its first start).
#   6. wait until /health reports the new build, then print preflight.
# Rollback: scripts/ops/linux/rollback.sh <previous sha> (printed at the end).
#
# Never `docker compose up --build` on the server: it builds an unstamped image ("unknown build")
# and skips the wait and the snapshot.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

ref="${1:-}"; [ -n "$ref" ] || die "usage: deploy.sh <git ref> [--not-running]"
not_running=0; [ "${2:-}" = "--not-running" ] && not_running=1

cd "$KEELIX_REPO"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "$KEELIX_REPO has local edits to tracked files; the image would not match any commit"
say "fetching"
git fetch --quiet --tags origin
before_head="$(git rev-parse HEAD)"
# Until the swap, a failure puts the checkout back where it was, so the scripts the timers run
# keep matching the build that is still serving.
swapping=0
on_exit() {
  local rc=$?
  if [ "$rc" != 0 ] && [ "$swapping" = 0 ]; then
    git -c advice.detachedHead=false checkout --quiet --detach "$before_head" 2>/dev/null || true
    echo "deploy stopped before the swap; the running server was not touched" >&2
  fi
}
trap on_exit EXIT
git -c advice.detachedHead=false checkout --quiet --detach "$ref"
sha="$(git rev-parse --short=7 HEAD)"
date="$(git log -1 --format=%cI)"

say "building $KEELIX_IMAGE:$sha (the server keeps running)"
# KEELIX_BUILD_FLAGS: extra `docker build` flags, e.g. "--network host" on a box whose egress goes
# through a proxy. Word-split on purpose.
# shellcheck disable=SC2086
docker build --quiet ${KEELIX_BUILD_FLAGS:-} \
  --build-arg BUILD_SHA="$sha" --build-arg BUILD_DATE="$date" \
  -t "$KEELIX_IMAGE:$sha" . >/dev/null

prev=""
if [ "$not_running" = 0 ]; then
  prev="$(running_sha)"
  [ -n "$prev" ] || die "/health does not answer with a build; is the server up? (--not-running for a first start)"
  [ "$prev" != "$sha" ] || { say "build $sha is already running; nothing to do"; exit 0; }
  say "running now: $prev (the rollback point)"
  wait_quiet
  snap="$(named_snapshot "pre-deploy-$prev")"
  say "named snapshot: $snap"
fi

say "swapping the container to $sha"
swapping=1
swap_to "$sha"
wait_build "$sha" 300
log_deploy "deploy $sha (was ${prev:-none}) ref=$ref"

say "preflight:"
"$KEELIX_REPO/scripts/ops/linux/keelix-ops.sh" preflight || true
echo
if [ -n "$prev" ]; then
  echo "Deployed $sha. To roll back: sudo $KEELIX_REPO/scripts/ops/linux/rollback.sh $prev"
  echo "If a migration must be undone too: add --restore $snap"
else
  echo "Deployed $sha."
fi
