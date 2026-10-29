// #358: which redirects re-send the request (and so are judged as a fresh request before Chromium
// follows them), and how a refused redirect reads. The real-browser cells are in
// filingBackstopRedirect.dom.smoke.ts.
import { backstopSentLine, describeBackstopAbort, isStoppingAbort, redirectKeepsMethod } from "./filingBackstop";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail ? ` (${detail})` : ""}`); }
};

for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
  check(`307 keeps ${m}`, redirectKeepsMethod(307, m));
  check(`308 keeps ${m}`, redirectKeepsMethod(308, m));
  check(`303 turns ${m} into a GET`, !redirectKeepsMethod(303, m));
}
check("301 / 302 turn a POST into a GET", !redirectKeepsMethod(301, "POST") && !redirectKeepsMethod(302, "post"));
check("301 / 302 keep a PUT and a DELETE", redirectKeepsMethod(301, "PUT") && redirectKeepsMethod(302, "DELETE"));
check("a 200 and a 304 are not redirects", !redirectKeepsMethod(200, "POST") && !redirectKeepsMethod(304, "PUT"));

const hop = { rule: "filing-url" as const, method: "POST", where: "http://127.0.0.1:9/SubmitApplication", why: "a filing endpoint, and no named approval covers this request (run)", resourceType: "document", redirect: { from: "http://127.0.0.1:9/step", status: 307, hop: 1 } };
const line = describeBackstopAbort(hop);
check("a refused redirect names its status, the request that reached the portal and the Location it was not followed to",
  /REFUSED A 307 REDIRECT of POST http:\/\/127\.0\.0\.1:9\/step \(that request reached the portal\) to http:\/\/127\.0\.0\.1:9\/SubmitApplication/.test(line) && /not followed$/.test(line), line);
check("…and never says it aborted the first request", !/BACKSTOP ABORTED/.test(line), line);
check("a refused redirect stops the run", isStoppingAbort(hop));
const sent = backstopSentLine(hop);
check("a refused redirect's stop says the first request reached the portal and never \"Nothing was sent\"",
  /The request to http:\/\/127\.0\.0\.1:9\/step reached the portal, which answered with a 307 redirect/.test(sent) && !/nothing was sent/i.test(sent), sent);
check("an ordinary abort still says nothing was sent", backstopSentLine({ ...hop, redirect: undefined }) === "Nothing was sent.");
check("a later hop says how many redirects in a row", /redirect 3 in a row/.test(describeBackstopAbort({ ...hop, redirect: { ...hop.redirect, hop: 3 } })));

// #394: a page open at install whose loaded document the response pause cannot re-bind is NAMED —
// redirectsJudged false for it, and a note the run puts in its warnings — until it loads a new
// document (created under the browser-level pause). A double with no browser warns nothing.
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bed = (opts: { attach: "throws" | "ok"; browser?: boolean; workers?: number }): { page: any; fire: (ev: string) => void } => {
    const listeners = new Map<string, Array<() => void>>();
    const session = { on: () => undefined, send: async () => ({}), detach: async () => undefined };
    const browser = { newBrowserCDPSession: async () => session };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = {
      on: (ev: string, fn: () => void) => { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); },
      off: () => undefined,
      mainFrame: () => ({ evaluate: async () => false, url: () => "http://127.0.0.1:9/home" }),
      frames: () => [],
      url: () => "http://127.0.0.1:9/home",
    };
    const ctx = {
      route: async () => undefined, unroute: async () => undefined, on: () => undefined, off: () => undefined,
      pages: () => [page],
      newCDPSession: async () => { if (opts.attach === "throws") throw new Error("Protocol error: Target closed"); return session; },
      browser: () => (opts.browser === false ? null : browser),
      serviceWorkers: () => Array.from({ length: opts.workers ?? 0 }, () => ({})),
    };
    page.context = () => ctx;
    return { page, fire: (ev) => { for (const fn of listeners.get(ev) ?? []) fn(); } };
  };
  const { installFilingBackstop } = await import("./filingBackstop");
  {
    const t = bed({ attach: "throws" });
    const bs = (await installFilingBackstop(t.page, "learn run"))!;
    check("uncovered: a page whose loaded document cannot be re-bound is not judged (redirectsJudged, redirectsJudgedOn)", !!bs && bs.redirectsJudged === false && bs.redirectsJudgedOn(t.page) === false, String(bs?.redirectsJudged));
    check("uncovered: the run gets a note naming the gap and the run", /Redirect guard \(#394\): a page already open when the learn run began could not be covered/.test(bs?.redirectGuardNote ?? ""), bs?.redirectGuardNote);
    t.fire("domcontentloaded");
    check("uncovered: once it loads a new document it is judged, and the note is gone", bs.redirectsJudged === true && bs.redirectGuardNote === "", `${bs.redirectsJudged} ${bs.redirectGuardNote}`);
    await bs.dispose();
  }
  {
    const t = bed({ attach: "ok" });
    const bs = (await installFilingBackstop(t.page, "replay run"))!;
    check("covered: a page re-bound at install is judged, with no note", bs.redirectsJudged === true && bs.redirectGuardNote === "", `${bs.redirectsJudged} ${bs.redirectGuardNote}`);
    await bs.dispose();
  }
  {
    // A service worker already running at install: its own fetch has no page to re-bind.
    const t = bed({ attach: "ok", workers: 1 });
    const bs = (await installFilingBackstop(t.page, "replay run"))!;
    check("a service worker running at install: not judged, and the note names it (even after a new document)",
      bs.redirectsJudged === false && /a service worker was already running when the replay run began/.test(bs.redirectGuardNote) && !/a page already open/.test(bs.redirectGuardNote), `${bs.redirectsJudged} ${bs.redirectGuardNote}`);
    t.fire("domcontentloaded");
    check("…the worker note is sticky for the run", bs.redirectsJudged === false && /service worker/.test(bs.redirectGuardNote), bs.redirectGuardNote);
    await bs.dispose();
  }
  {
    const t = bed({ attach: "throws", browser: false });
    const bs = (await installFilingBackstop(t.page, "replay run"))!;
    check("a double with no browser: not judged, and no note (nothing joined to fall short of)", bs.redirectsJudged === false && bs.redirectGuardNote === "", `${bs.redirectsJudged} ${bs.redirectGuardNote}`);
    await bs.dispose();
  }
}

if (failures) { console.error(`\nfilingBackstopRedirect: ${failures} FAILED`); process.exit(1); }
console.log("\nfilingBackstopRedirect: all checks passed");
