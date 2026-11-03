// PREFLIGHT ON A LINUX SERVER BEHIND CLOUDFLARE (#437, epic #429): the pure checks.
//
// scripts/ops/preflight.ts was written for the Windows desk. On the hosted server two things are
// new and both fail quietly:
//
//   1. TRUST_PROXY. The login lockout (auth.ts: 8 failures lock an address for 15 min) keys on
//      req.ip. Behind cloudflared that is only the CLIENT when Express trusts the hop the tunnel
//      arrives from. Inside Docker the tunnel's requests come from the bridge network (172.x), not
//      loopback, so the default `loopback` makes every teammate the same address: one person's
//      typos lock the whole team out. `true` is the opposite mistake: the left-most
//      X-Forwarded-For, which the client writes, becomes the address, so the lockout is dodged by
//      sending a new header each try.
//   2. Cloudflare Access. Nothing in .env says whether Access is in front. `--probe-edge` asks the
//      public address from the outside: a staff path (/health) must come back as Cloudflare's
//      sign-in redirect, never the app's own answer; a customer path (/status) must reach the app,
//      or every status and credential link a customer opens lands on a Google sign-in.
//
// Plus the wording: the desk's Windows-only advice (the firewall's Public profile, the
// install-watchdog.ps1 task, "same drive" judged by drive letter) is not printed on Linux.
//
// Pure: every input is a parameter (env, platform, whether we run in a container, a fetch), so
// backend/test/opsPreflightEdge.test.ts pins each verdict without a server or a network.

export type Verdict = "PASS" | "WARN" | "FAIL";
export interface PostureRow { area: string; check: string; verdict: Verdict; detail: string }
type Env = Record<string, string | undefined>;

export interface HostShape {
  /** process.platform */
  platform: string;
  /** Running inside a container (/.dockerenv exists). */
  inContainer: boolean;
}

export const isWindows = (shape: HostShape): boolean => shape.platform === "win32";

/** How Express will read the client address, and whether the login lockout keys on the right one. */
export function trustProxyRow(env: Env, shape: HostShape): PostureRow {
  const raw = String(env.TRUST_PROXY ?? "").trim();
  const v = raw.toLowerCase();
  const row = (verdict: Verdict, detail: string): PostureRow => ({ area: "edge", check: "TRUST_PROXY", verdict, detail });
  if (!raw) {
    return shape.inContainer
      ? row("WARN", "unset (loopback): inside a container the tunnel's requests arrive from the Docker network, so every user shares one address and one person's failed logins lock out the team - set TRUST_PROXY=uniquelocal")
      : row("PASS", "unset (loopback): right when the tunnel or reverse proxy runs on this machine");
  }
  if (v === "true") {
    return row("WARN", "true trusts every hop: the left-most X-Forwarded-For, which the client writes, becomes the login lockout's address - use loopback, uniquelocal or a hop count");
  }
  if (v === "false") {
    return row("WARN", "false: forwarded headers are ignored, so behind a tunnel every user is the tunnel's address for the login lockout");
  }
  return row("PASS", `${raw}: forwarded client addresses are read from that hop`);
}

/** The SERVER_HOST WARN's advice, for the platform it is printed on. */
export function exposedHostAdvice(shape: HostShape): string {
  if (isWindows(shape)) return "keep the Node firewall rule off the Public profile";
  if (shape.inContainer) return "inside a container: publish the port on 127.0.0.1 only (docker-compose.override.yml) so only cloudflared reaches it";
  return "keep the port closed in the host and provider firewalls; only the tunnel should reach it";
}

/** Where the watchdog is installed from, for the "has never run here" line. */
export function watchdogInstallHint(shape: HostShape): string {
  return isWindows(shape) ? "install-watchdog.ps1" : "keelix-watchdog.timer, docs/OPERATIONS_LINUX.md";
}

export interface ProbeAnswer {
  status: number;
  location: string;
  contentType: string;
  /** Cloudflare stamps every response it relays with cf-ray. */
  viaCloudflare: boolean;
  /** First few hundred characters of the body, to recognise the app's own /health JSON. */
  bodyStart: string;
}

const isAccessRedirect = (a: ProbeAnswer): boolean =>
  a.status >= 300 && a.status < 400 && /(?:\.cloudflareaccess\.com|\/cdn-cgi\/access\/)/i.test(a.location);

/**
 * Judge the two outside probes. `staff` answered GET <PUBLIC_BASE_URL>/health, `customer` answered
 * GET <PUBLIC_BASE_URL>/status; null = no answer (network error, DNS, timeout).
 */
export function classifyEdgeProbe(staff: ProbeAnswer | null, customer: ProbeAnswer | null): PostureRow[] {
  const rows: PostureRow[] = [];
  const add = (check: string, verdict: Verdict, detail: string): void => { rows.push({ area: "edge", check, verdict, detail }); };
  if (!staff) {
    add("Access on staff paths", "WARN", "no answer from PUBLIC_BASE_URL/health - is the tunnel up and the hostname routed?");
  } else if (isAccessRedirect(staff)) {
    add("Access on staff paths", "PASS", "/health from outside is sent to the Cloudflare Access sign-in");
  } else if (staff.status === 200 && /Solar Submission Autopilot/.test(staff.bodyStart)) {
    add("Access on staff paths", "FAIL", "/health from outside reached the app with no Cloudflare sign-in - the Access application is missing, or a bypass covers it");
  } else {
    add("Access on staff paths", "WARN", `/health from outside answered ${staff.status}${staff.location ? ` -> ${staff.location}` : ""}, neither the Access sign-in nor the app`);
  }
  if (!customer) {
    add("Access bypass", "WARN", "no answer from PUBLIC_BASE_URL/status");
  } else if (isAccessRedirect(customer)) {
    add("Access bypass", "FAIL", "/status from outside is sent to the Cloudflare sign-in: customers cannot open status or credential links - add the bypass application (OPERATIONS_LINUX.md)");
  } else if (customer.status === 200 && /text\/html/i.test(customer.contentType)) {
    add("Access bypass", "PASS", "/status from outside reaches the app's public page");
  } else {
    add("Access bypass", "WARN", `/status from outside answered ${customer.status}`);
  }
  const answers = [staff, customer].filter((a): a is ProbeAnswer => Boolean(a));
  if (answers.length) {
    const cf = answers.some((a) => a.viaCloudflare);
    add("via Cloudflare", cf ? "PASS" : "WARN", cf ? "responses carry cf-ray" : "no cf-ray header: PUBLIC_BASE_URL is not answered through Cloudflare");
  }
  return rows;
}

type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<{
  status: number; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

/** One GET, never following a redirect. Null on any network failure. */
export async function probeOnce(url: string, fetchImpl: FetchLike, timeoutMs = 10_000): Promise<ProbeAnswer | null> {
  try {
    const r = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.text().catch(() => "");
    return {
      status: r.status,
      location: r.headers.get("location") ?? "",
      contentType: r.headers.get("content-type") ?? "",
      viaCloudflare: Boolean(r.headers.get("cf-ray")),
      bodyStart: body.slice(0, 400),
    };
  } catch {
    return null;
  }
}

/** Probe PUBLIC_BASE_URL from the outside and judge it. GETs only; nothing is written. */
export async function probeEdge(baseUrl: string, fetchImpl: FetchLike): Promise<PostureRow[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const [staff, customer] = await Promise.all([probeOnce(`${base}/health`, fetchImpl), probeOnce(`${base}/status`, fetchImpl)]);
  return classifyEdgeProbe(staff, customer);
}
