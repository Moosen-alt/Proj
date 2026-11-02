#!/usr/bin/env bash
# RUN ONE OF THE OPS SCRIPTS AGAINST THE SERVER'S OWN SETTINGS AND STATE (docs/OPERATIONS_LINUX.md).
#
#   /opt/keelix/scripts/ops/linux/keelix-ops.sh preflight [--probe-edge]
#   /opt/keelix/scripts/ops/linux/keelix-ops.sh watchdog --once
#   /opt/keelix/scripts/ops/linux/keelix-ops.sh offbox-sync
#   /opt/keelix/scripts/ops/linux/keelix-ops.sh restore-drill [--no-dotenv] [--from /app/offbox]
#   /opt/keelix/scripts/ops/linux/keelix-ops.sh test-email --to you@yourcompany.com
#
# The scripts (scripts/ops/*.ts) are not in the image, so this starts a ONE-OFF container from the
# running image with the checkout's scripts/ mounted read-only: the same .env, the same state
# volume, the same Node and node_modules as the server, and no published port. It works while the
# app container is down, which is the point for the watchdog. WATCHDOG_HEALTH_URL reaches the app
# by its compose service name.
#
# Key escrow test: export SESSION_ENCRYPTION_KEY in this shell (pasted from the password manager)
# and pass --no-dotenv to restore-drill; the shell's value then wins over the one in .env.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"

name="${1:-}"; shift || true
case "$name" in
  preflight|watchdog|offbox-sync|restore-drill|test-email) ;;
  *) die "usage: keelix-ops.sh preflight|watchdog|offbox-sync|restore-drill|test-email [args]" ;;
esac
extra=()
[ -n "${SESSION_ENCRYPTION_KEY:-}" ] && extra+=(-e SESSION_ENCRYPTION_KEY)
exec docker compose --project-directory "$KEELIX_REPO" run --rm --no-deps -T \
  -v "$KEELIX_REPO/scripts:/app/scripts:ro" \
  -e "WATCHDOG_HEALTH_URL=${WATCHDOG_HEALTH_URL:-http://app:4173/health}" \
  -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  "${extra[@]}" \
  app npx tsx "scripts/ops/$name.ts" "$@"
