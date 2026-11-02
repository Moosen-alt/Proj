#!/bin/sh
# Container entrypoint (#434): start a virtual display, then run the app.
#
# WHY. Some portals answer only a real browser window (coosbayor.gov returns 403 to headless
# Chromium and 200 to headed), so staging and auto-learn retry ONCE with a headed browser on a
# bot block (repository.ts / autoLearn.ts, PORTAL_HEADED_RETRY). A server has no screen, so on
# Linux that headed launch failed before it started and the retry could not help. Xvfb is a
# display server with no screen: the headed window opens on it and nobody can see or click it.
#
# WHAT IT DOES NOT CHANGE. PORTAL_HEADLESS keeps its default (headless): every run still starts
# headless, and only the bot-block retry asks for a window. PORTAL_HEADED_RETRY=0 still turns that
# retry off. A window on this display is automation's window: no person can reach it, so the
# review-page hand-over (#333) never sees a person's input there and lets nothing through
# (pinned by portal-bot/src/headedDisplay.image.smoke.ts, run against the built image in CI).
#
# Skipped when DISPLAY is already set (a real or forwarded display wins), when
# PORTAL_VIRTUAL_DISPLAY=0, or when Xvfb is not installed. If Xvfb does not come up the app
# still starts, without a display, exactly as before this change: headed retries fail and the
# headless result stands.
set -e

if [ -z "${DISPLAY:-}" ] && [ "${PORTAL_VIRTUAL_DISPLAY:-1}" != "0" ] && command -v Xvfb >/dev/null 2>&1; then
  n="${PORTAL_VIRTUAL_DISPLAY_NUMBER:-99}"
  # A container restarted by Docker keeps its /tmp, so the last run's lock and socket are still
  # there; Xvfb would refuse the display as "already active". Nothing else in this container
  # starts an X server, so they are stale.
  rm -f "/tmp/.X${n}-lock" "/tmp/.X11-unix/X${n}"
  # -nolisten tcp: the display is reachable only through its socket inside this container.
  Xvfb ":${n}" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  i=0
  while [ ! -S "/tmp/.X11-unix/X${n}" ] && [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
  done
  if [ -S "/tmp/.X11-unix/X${n}" ]; then
    export DISPLAY=":${n}"
    echo "[entrypoint] virtual display :${n} is up (headed retries can open a window)"
  else
    echo "[entrypoint] WARNING: Xvfb did not start; headed retries will fail as before. See /tmp/xvfb.log" >&2
  fi
fi

exec "$@"
