// ---------------------------------------------------------------------------
// ONE PREDICATE FOR "MAY THE SERVER FETCH THIS URL?" (issue #391).
//
// Every server-side fetch of a URL somebody else chose asks this module: the AHJ form-template
// fetch (ahjForms.fetchFormTemplate, operator input) and the public-document ladder
// (documentFetch.fetchPublicDocument), which the form-fill tool reaches with an org API key.
// The guard used to live inside ahjForms.ts and covered only the first door, so a key holder
// could have the server fetch http://127.0.0.1:4173/..., the cloud-metadata address, or a
// public URL that 302s into the LAN. Two copies of an address list is how one of them goes
// stale, so there is one list, here.
//
// The rule: an http(s) URL whose host resolves ONLY to public addresses. Loopback, RFC 1918,
// CGNAT, link-local (cloud metadata lives at 169.254.169.254), unspecified, multicast and
// reserved space are refused, in IPv4, IPv6, and every IPv6 spelling that embeds an IPv4
// address (::ffff:7f00:1 is 127.0.0.1). A host with ANY private address is refused: a name
// that answers both public and private is a rebinding setup, not an AHJ.
//
// CALLERS CHECK EVERY HOP. A redirect is a new URL; a fetcher that follows redirects itself
// has asked this question once and then gone wherever the far end pointed. Both doors follow
// redirects manually and ask again before each request.
//
// DOCUMENT_FETCH_ALLOW_ORIGINS is the one way past it: a comma-separated list of EXACT origins
// (scheme://host:port) treated as reachable. It exists for the test suites, whose stub servers
// necessarily listen on 127.0.0.1, and for an operator who deliberately serves documents from
// one intranet host. It never matches a different port, scheme or host, so a listed origin that
// redirects anywhere else is still refused at the next hop.
// ---------------------------------------------------------------------------
import dns from "node:dns/promises";
import net from "node:net";
import { HttpError } from "./httpError";

function ipv4IsPrivate(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
  if (o[0] === 169 && o[1] === 254) return true;            // link-local + cloud metadata
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true;
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking 198.18/15
  if (o[0] >= 224) return true;                              // multicast / reserved / broadcast
  return false;
}

/** An IPv6 literal as its eight 16-bit groups, or null when it does not parse. Handles `::`
 *  compression and a trailing dotted quad (::ffff:127.0.0.1). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const quad = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (quad) {
    const o = quad.slice(1).map(Number);
    s = s.slice(0, quad.index) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function ipv6IsPrivate(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  // ::/96 (unspecified, loopback, the deprecated IPv4-compatible form) and ::ffff:0:0/96
  // (IPv4-mapped): the address that is actually dialled is the IPv4 one in the low 32 bits.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    if (g[5] === 0 && g[6] === 0) return true;               // ::, ::1 and everything near them
    return ipv4IsPrivate(v4FromGroups(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return ipv4IsPrivate(v4FromGroups(g[6], g[7]));         // NAT64 64:ff9b::/96
  }
  if (g[0] === 0x2002) return ipv4IsPrivate(v4FromGroups(g[1], g[2])); // 6to4 2002::/16
  if ((g[0] & 0xffc0) === 0xfe80) return true;              // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true;              // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true;              // unique-local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true;              // multicast ff00::/8
  return false;
}

/** True for any address the server must not be pointed at. Not an IP literal → true (unsafe). */
export function ipIsPrivate(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4IsPrivate(ip);
  if (kind === 6) return ipv6IsPrivate(ip);
  return true;
}

/** The exact origins DOCUMENT_FETCH_ALLOW_ORIGINS lets through, read per call (tests set it
 *  after their stub server has a port). */
function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  for (const raw of String(process.env.DOCUMENT_FETCH_ALLOW_ORIGINS ?? "").split(",")) {
    const t = raw.trim();
    if (!t) continue;
    try { out.add(new URL(t).origin); } catch { /* a malformed entry allows nothing */ }
  }
  return out;
}

/**
 * Why this URL may NOT be fetched, or null when it may. Refuses a non-http(s) scheme and any
 * host that resolves to a private address.
 *
 * A NAME THAT DOES NOT RESOLVE IS NOT REFUSED HERE: there is no address to judge, and the fetch
 * that follows asks the same resolver and fails the same way, reported as the network failure it
 * is. Refusing it would add no protection: a DNS server that can fail the first query and answer
 * the second with 127.0.0.1 can equally answer the first with a public address (rebinding), which
 * a check made before the request cannot see either. It would also refuse every test that serves
 * a synthetic host (www.co.flat.or.us) through a stubbed fetch, which never resolves anything.
 */
export async function publicUrlRefusal(raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return `Invalid URL: ${String(raw).slice(0, 120)}`; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `Only http(s) URLs may be fetched (got ${u.protocol}).`;
  }
  if (allowedOrigins().has(u.origin)) return null;
  // URL keeps the brackets on an IPv6 host ("[::1]"), and net.isIP("[::1]") is 0 — which used to
  // send a loopback literal to dns.lookup instead of to the address check.
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); }
    catch { return null; }
  }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a))) {
    return `Refusing to fetch an internal/private address (${u.hostname}).`;
  }
  return null;
}

/** publicUrlRefusal as a route-edge throw: HttpError(400) on a refused URL. */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  const refusal = await publicUrlRefusal(raw);
  if (refusal) throw new HttpError(400, refusal);
}
