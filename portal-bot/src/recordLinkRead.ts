// #512 — READ A LOGIN-WALLED RECORD LINK WITH THE CLIENT'S OWN STORED LOGIN.
//
// A utility's record page (PowerClerk's MvcProjects/LandingPage?ProgramId=…&ProjectId=…) is behind a
// login, and so are many permit portals' record pages. The monitor had two signed-in doors — the
// utility's recorded recipe and a saved browser session — and a filing with neither was read
// anonymously, met the sign-in page and read nothing, although the client's own login for that very
// portal was stored and the card held the record's own link (owner, 2026-11-02: "I don't know how
// else we'll be able to get live updates from them if not").
//
// THE SAME SHAPE ON EVERY PORTAL, SO NOTHING PER PLATFORM (owner: "Remember, universality"): open the
// link; when it shows a sign-in form, sign in with performLogin (the learner's and replay's own
// sign-in); open the link again; read the record's status with findFilingStatus (the signed-in
// reader every status check uses: labelled status rows first, the number's own window otherwise,
// redacted). Nothing is clicked on the record — the only form ever submitted is the portal's login.
//
// SAFETY
// - Rule 1: the filing backstop is installed before the first page loads, so no filing or payment
//   request can leave the session whatever a page script does; the read itself only navigates.
// - Rules 5 and 6 are the caller's: it passes only a track-safe link, and credentialFor answers only
//   with the project's own client's login stored for the sign-in page the portal led to (host + tenant
//   path). Here, the read stays on the link's host: a sign-in or a redirect that lands elsewhere reads
//   nothing, and no login is even asked for there.
// - A second factor or a CAPTCHA is never answered: the read stops and says so. A refused login is
//   reported as such (loginRefused), so the caller marks it stale and stops knocking.
// - The credential never appears in a reason, a log line or the returned text.
import { closePortal, openPortal, type OpenedPortal } from "./browser";
import { installFilingBackstop, type FilingBackstop } from "./filingBackstop";
import { loginFormPresent, loginWasRefused, performLogin, type Credential } from "./adapters/loginFlow";
import { findFilingStatus, hostOf } from "./statusFinder";
import { smartWait } from "./safeAction";

export type SignedInLinkOutcome = "read" | "no_status" | "no_credential" | "sign_in_failed" | "mfa" | "off_host" | "error";

export interface SignedInLinkRead {
  /** The record's status text (redacted by findFilingStatus), or null. */
  text: string | null;
  /** Why nothing was read, worded for the card and the log; "" when text was read. Never a secret. */
  reason: string;
  outcome: SignedInLinkOutcome;
  /** True when this read had to sign in (false: the profile's session was still valid). */
  signedIn: boolean;
  /** True only when the portal REFUSED the login (loginWasRefused: the one predicate that marks a
   *  stored credential stale) — never for an MFA screen, a hand-off or a session that would not stick. */
  loginRefused?: boolean;
}

export interface SignedInLinkOptions {
  /** A login the caller already resolved for this portal. */
  credential?: Credential;
  /** THE PORTAL NAMES ITS OWN SIGN-IN PAGE: asked with the URL of the sign-in page the record link
   *  led to, so the caller picks the stored login for THAT page (host + tenant path) — a record on a
   *  shared host (one Accela host, many cities) leads to its own city's sign-in, and a PowerClerk
   *  record (/MvcProjects/…) to its tenant's /MvcAccount/Login. null: no stored login fits; nothing
   *  is typed. Never called for a page on another host. */
  credentialFor?: (signInPageUrl: string) => Credential | null | undefined;
  /** The client+portal persistent profile, so a session survives between checks (one sign-in reused). */
  userDataDir?: string;
  headless?: boolean;
  /** Bound for the status read on the record page (findFilingStatus). */
  budgetMs?: number;
}

const GOTO_TIMEOUT_MS = 45_000;

async function openRecord(opened: OpenedPortal, url: string): Promise<void> {
  await opened.page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
  await smartWait(opened.page, 2000);
}

/** Read one record's status through its own link, signing in with the stored login when the link
 *  is behind a sign-in form. Never throws: a failure is an outcome with its reason. */
export async function readRecordLinkSignedIn(url: string, applicationNumbers: string[], opts: SignedInLinkOptions = {}): Promise<SignedInLinkRead> {
  const host = hostOf(url);
  if (!host) return { text: null, reason: "the record link is not a web address", outcome: "error", signedIn: false };
  if (!opts.credential && !opts.credentialFor) {
    return { text: null, reason: `no stored login for ${host} on this client`, outcome: "no_credential", signedIn: false };
  }
  let opened: OpenedPortal | null = null;
  let backstop: FilingBackstop | null = null;
  let signedIn = false;
  try {
    opened = await openPortal({ userDataDir: opts.userDataDir, headless: opts.headless ?? true });
    backstop = await installFilingBackstop(opened.page, "record link read");
    await openRecord(opened, url);

    if (await loginFormPresent(opened.page)) {
      const signInPage = opened.page.url();
      if (hostOf(signInPage) !== host) {
        return { text: null, reason: `the record link led to a sign-in page away from ${host}; nothing was typed`, outcome: "off_host", signedIn: false };
      }
      const credential = opts.credential ?? opts.credentialFor?.(signInPage) ?? null;
      if (!credential?.username || !credential?.password) {
        return { text: null, reason: `no stored login fits ${host}'s sign-in page on this client; nothing was typed`, outcome: "no_credential", signedIn: false };
      }
      const login = await performLogin(opened.page, credential, { parkMs: 0 });
      if (login.status === "mfa_captcha") {
        return { text: null, reason: `${host} asked for a second factor or a CAPTCHA at sign-in; a person has to sign in (a status read never answers one)`, outcome: "mfa", signedIn: false };
      }
      if (!login.ok) {
        return { text: null, reason: `the sign-in failed on ${host} (${login.status})`, outcome: "sign_in_failed", signedIn: false, loginRefused: loginWasRefused(login.message) };
      }
      signedIn = true;
      // The portal may land the sign-in on its home page: open the record itself again.
      await openRecord(opened, url);
      if (await loginFormPresent(opened.page)) {
        return { text: null, reason: `the sign-in failed: ${host} showed its sign-in form again after signing in`, outcome: "sign_in_failed", signedIn };
      }
    }

    if (hostOf(opened.page.url()) !== host) {
      return { text: null, reason: `the record link led away from ${host}; nothing was read there`, outcome: "off_host", signedIn };
    }
    const found = await findFilingStatus(opened.page, applicationNumbers, { maxPages: 1, budgetMs: opts.budgetMs ?? 60_000 });
    if (!found.text) return { text: null, reason: found.reason || `the record page on ${host} held no status`, outcome: "no_status", signedIn };
    return { text: found.text, reason: "", outcome: "read", signedIn };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: null, reason: `the record read on ${host} failed: ${msg.slice(0, 160)}`, outcome: "error", signedIn };
  } finally {
    if (backstop) await backstop.dispose().catch(() => undefined);
    if (opened) await closePortal(opened).catch(() => undefined);
  }
}
