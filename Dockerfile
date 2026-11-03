# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Solar Submission Autopilot — production image
# Includes Playwright/Chromium for portal automation (headless, cloud-ready), and a virtual
# display (Xvfb) so the one headed retry on a bot-blocked portal can open a window (#434).
# ---------------------------------------------------------------------------

# ---- builder: install production deps (incl. native better-sqlite3) -------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production

# System deps for Playwright's Chromium on Debian bookworm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libnspr4 libnss3 \
      libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libgbm1 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
      libpango-1.0-0 libcairo2 libasound2 \
      procps \
      libreoffice-writer-nogui \
      xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
# xvfb (#434): a display server with no screen. The entrypoint starts it and exports DISPLAY, so
# the headed retry on a portal that refuses headless browsers (coosbayor.gov: 403 headless, 200
# headed) opens its window there instead of failing to launch. Runs stay headless by default
# (PORTAL_HEADLESS); only that retry goes headed. /tmp/.X11-unix is made root-owned and sticky here
# because Xvfb runs as `node` and cannot create it the way X expects.
# libreoffice-writer-nogui: headless DOCX→PDF for the standalone Form Filler tool
# (backend/src/formFiller.ts convertDocxToPdf). Provides `soffice`. If image size
# is a concern and DOCX upload isn't needed, drop this line — the PDF path and the
# tool's clear "save as PDF" fallback still work without it.

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared
COPY portal-bot ./portal-bot
COPY backend/data/reference-ahj-processes.json backend/data/reference-code-profiles.json /app/reference/
ENV AHJ_PROCESS_REFERENCE_PATH=/app/reference/reference-ahj-processes.json
ENV CODE_PROFILE_REFERENCE_PATH=/app/reference/reference-code-profiles.json
# Build identity (backend/src/buildInfo.ts). The image has no .git (.dockerignore) and no git
# binary, so without these the app honestly reports "unknown build". Stamp at build time:
#   docker build --build-arg BUILD_SHA=$(git rev-parse --short HEAD) \
#                --build-arg BUILD_DATE=$(git log -1 --format=%cI) -t solar-submission-autopilot .
# Empty (the default) means "not stamped", never a version.
ARG BUILD_SHA=""
ARG BUILD_DATE=""
ENV BUILD_SHA=$BUILD_SHA BUILD_DATE=$BUILD_DATE

# Playwright Chromium binary — stored at a fixed path outside node_modules
# so it survives volume mounts and is not duplicated per node_modules copy.
# `playwright` is a runtime dependency (portal-bot does `import("playwright")`), so it
# survives `npm ci --omit=dev`. Do NOT swallow install failures: a missing Chromium means
# every portal run (auto-learn + replay) fails silently at runtime, so fail the build instead.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-cache
# Run the package's own CLI, not `npx playwright`: under `npm ci --omit=dev` the `playwright` bin
# is not linked into node_modules/.bin (the dev-only @playwright/test declares the same bin name),
# so `npx playwright` failed with "playwright: not found" and the image did not build (#434). This installs the full Chromium (the
# headed retry's browser) and the headless shell (every other run).
RUN node -e "require('playwright')" \
 && node node_modules/playwright/cli.js install chromium

# The entrypoint starts the virtual display (above) and then execs the command (CMD below). The
# sed strips the CRLF a Windows checkout may give the script (sh would not run it).
COPY scripts/docker-entrypoint.sh /usr/local/bin/solar-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/solar-entrypoint && chmod 755 /usr/local/bin/solar-entrypoint

# ONE STATE ROOT (#430): the database, documents, backups, portal login profiles, the draft
# ledger, learn/replay runs, screenshots, portal-debug and logs all resolve under
# AUTOPILOT_STATE_DIR (backend/src/statePaths.ts). Mount a persistent volume at exactly this path
# in production. It is the old backend/data path on purpose: an existing volume keeps its
# database, documents and backups where they are.
ENV AUTOPILOT_STATE_DIR=/app/backend/data
RUN mkdir -p backend/data backend/data/backups \
 && chown -R node:node /app

USER node

EXPOSE 4173
# Inside a container the app must listen on every interface or nothing outside it (a published
# Docker port, a reverse proxy on the host) can reach it; the server's own default is 127.0.0.1 (#82). This is
# the "on purpose" SERVER_HOST. With AUTH_ENABLED off the server then REFUSES to start unless
# ALLOW_UNAUTHENTICATED_NETWORK=1 is also set: turn login on for anything reachable.
ENV SERVER_HOST=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4173)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/solar-entrypoint"]
CMD ["npm", "start"]
