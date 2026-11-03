// THE CLOUDFLARE ACCESS BYPASS LIST, AND THE PATHS THAT STAY BEHIND ACCESS (#437, epic #429).
//
// On the hosted server the whole hostname sits behind a Cloudflare Access application: a person
// signs in with their Google account at Cloudflare before the request ever reaches the app, and
// then signs in to the app as well (AUTH_ENABLED=true stays on behind Access). Customers have no
// Google login on our team, so the links we send them (status, intake, credential drop box, the
// per-client tracker, shared review reports) need a BYPASS policy: Access lets those paths through
// and the app's own token checks are the only gate, exactly as on the desk install today.
//
// TWO GATES, ONE LIST. requireAuth (auth.ts) decides which paths the app serves without a login;
// this file decides which paths Cloudflare serves without a Google sign-in. They must agree:
//   - a bypass entry wider than requireAuth opens nothing (the app still sends a stranger to
//     /login or a 401), but it says the edge protects something it does not, and it is how a
//     future route under a bypassed prefix would be one forgotten check away from public. Hard
//     rule 6: the bypass must never cover an /api/* route the app does not already leave open.
//   - a bypass entry narrower than requireAuth breaks a customer link: the customer lands on a
//     Cloudflare Google sign-in they cannot pass.
// backend/test/accessBypass.test.ts drives the real requireAuth over every route server.ts
// registers and every file the dashboard serves, and fails on either drift. It also pins the copy
// of this list printed in docs/OPERATIONS_LINUX.md (`npx tsx scripts/ops/linux/access-bypass.ts`).
//
// Path syntax is Cloudflare's (application "Path" field): no leading host, `*` is a wildcard that
// may span segments, `/x/*` covers `/x/a` but not `/x` itself, and a path with no wildcard is
// inherited by its sub-paths (`/status` also covers `/status/a`). Query strings are not part of
// an Access path, so a token in `?token=` never matters here.

export interface AccessPathEntry {
  /** The Path field of the Access application (hostname is keelix.<your domain>). */
  path: string;
  /** Why this path is where it is. Printed in the runbook table. */
  why: string;
}

/**
 * Paths Cloudflare Access lets through with a Bypass policy. Each is a path requireAuth already
 * serves without a login, and each is token-scoped or a static asset a logged-out page needs.
 * Order is the order printed in the runbook.
 */
export const ACCESS_BYPASS_PATHS: readonly AccessPathEntry[] = [
  { path: "/status", why: "customer status page (link carries a token)" },
  { path: "/api/public/status/*", why: "the status page's data, token-scoped, read-only" },
  { path: "/intake", why: "customer intake page (link carries a token)" },
  { path: "/api/intake/*", why: "the intake page's data, token-scoped" },
  { path: "/credentials", why: "one-time portal-credential drop box (link carries a token)" },
  { path: "/api/public/credential-request/*", why: "the drop box's data, token-scoped, one use" },
  { path: "/portal", why: "per-client tracker page (link carries a token)" },
  { path: "/api/public/portal/*", why: "the tracker's data, token-scoped, read-only" },
  { path: "/api/public/review/*", why: "shared review report, token-scoped, read-only" },
  { path: "/styles.css", why: "stylesheet the logged-out pages load" },
  { path: "/favicon.ico", why: "tab icon" },
  { path: "/assets/brand/*", why: "logo images on the logged-out pages" },
  { path: "/vendor/*", why: "vendored font and libraries the logged-out pages load" },
];

/**
 * Paths requireAuth serves without a login that STAY behind Access on purpose: only staff need
 * them, and staff have a Google sign-in. Listed so the drift test can tell "open in the app and
 * deliberately kept behind Access" from "open in the app and forgotten here".
 */
export const OPEN_IN_APP_BEHIND_ACCESS: readonly AccessPathEntry[] = [
  { path: "/login", why: "staff sign-in page; staff pass Access first" },
  { path: "/login.html", why: "the same page as a static file" },
  { path: "/api/auth/*", why: "staff sign-in, sign-out and who-am-I" },
  { path: "/health", why: "the watchdog and deploy script poll it on the box (127.0.0.1), never through the tunnel" },
];

const lower = (s: string): string => s.toLowerCase();

/**
 * Whether Access DEFINITELY applies `entry` to `urlPath` (the under-approximation): an exact
 * path, its sub-paths, or a trailing-`/*` wildcard's children. Used to prove a customer link is
 * bypassed, so anything uncertain counts as not covered.
 */
export function accessPathSurelyCovers(entryPath: string, urlPath: string): boolean {
  if (entryPath.endsWith("/*") && !entryPath.slice(0, -2).includes("*")) {
    const parent = entryPath.slice(0, -1); // keeps the trailing slash
    return urlPath.startsWith(parent) && urlPath.length > parent.length;
  }
  if (entryPath.includes("*")) return false;
  return urlPath === entryPath || urlPath.startsWith(`${entryPath}/`);
}

/**
 * Whether Access MIGHT apply `entry` to `urlPath` (the over-approximation): case folded, a plain
 * path as a bare string prefix (so `/status` is taken to cover `/statusx` too), and `*` matching
 * anything, slashes included. Used for the safety direction: everything a bypass might open must
 * already be open in the app.
 */
export function accessPathMayCover(entryPath: string, urlPath: string): boolean {
  const e = lower(entryPath);
  const u = lower(urlPath);
  if (!e.includes("*")) return u.startsWith(e);
  const re = new RegExp(`^${e.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}`);
  // `/x/*` may also be read as covering `/x` itself: over-approximate that too.
  return re.test(u) || (e.endsWith("/*") && u === e.slice(0, -2));
}

/** The runbook's bypass table, exactly as docs/OPERATIONS_LINUX.md carries it. */
export function renderAccessBypassTable(): string {
  const rows = ACCESS_BYPASS_PATHS.map((e) => `| \`${e.path}\` | ${e.why} |`);
  return ["| Path (on `keelix.<your domain>`) | What it is |", "| --- | --- |", ...rows].join("\n");
}
