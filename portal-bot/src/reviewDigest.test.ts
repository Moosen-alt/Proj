// #436 PR1 — THE STAGED DRAFT'S REVIEW DIGEST: what it reads, what changes it, and what it refuses.
//
// reviewDigest.ts is the ONE reader a Stage (and, in PR2, the submit run) uses. This pins it without
// a browser: the pure builder over readings, and the walk over a stub DigestNavigator.
//   (a) an EMPTY value is a row: emptying a box (or filling an empty one) changes the digest.
//   (b) an UNCHECKED box is a row: unticking an attestation changes the digest.
//   (c) a 3-CELL table row counts every cell: a change in the third cell changes the digest.
//   (d) a same-origin FRAME's rows count (the reader prefixes them "frame N: ").
//   (e) DUPLICATE labels are counted by ordinal: swapping two same-labelled values, or dropping one,
//       changes the digest; the ordinals are 1, 2.
//   (f) UNREADABLE, by name, never hashed: over 400 rows, over 64 KB, nothing read, a dialog, a
//       cross-origin frame, a step that opens by a script, no step links on a multi-page recipe,
//       writes blocked during the walk, two reads that disagree, no key, no draft id, a walk the
//       navigator refuses before it opens anything (f6), fewer step pages opened than the recipe
//       walks (f7, the page-count floor).
//   (g) RULING 7, pinned: the cue and token patterns are exactly these; "Last saved 2:41 PM" and
//       "Last saved 3:05 PM" read the same, but the name beside it, a control's value, and a time on
//       a line with no cue all still count.
//   (h) MULTI-PAGE: one section per step, review first, steps in tab order; a change on step 2 alone
//       changes the row's digest and that section's, and no other section's.
//   (i) the key: same key + nonce → the same digest; another key → another keyId and digest; another
//       nonce (another row) → no mac in common (the same number on two projects never links).
//   (j) the label output: labels are redacted (secrets to a last 4) and capped at 80.
//   (k) the recipe's page count (recipeAdapter.stagedReviewExpectedPages) reads the engine's one
//       advancing-click predicate: a hand-patched "Next" with no "advance:" note is a page, so a
//       review page with no step links is refused for it; the final submit and "Add New" are not pages.
//
// KILL TESTS (run by hand, each turns this file red):
//   K1 normalizedValue: return the raw value (no ruling-7 drop) → (g) fails.
//   K2 dropSelfChangingTimestamps: drop the cue test (always strip) → (g) "no cue" fails.
//   K3 itemMacs: key the ordinal on kind only → (e) fails.
//   K4 finishDigestReading: drop the row cap → (f) "over 400 rows" fails.
//   K5 walkStagedDraft: push a non-navigable link as read → (f) "opens by a script" fails.
//   K6 buildStagedReviewCapture: approvable ignores `why` → every (f) case fails.
//   K10 walkStagedDraft: ignore nav.refusal() → (f6) fails (the refused walk opens the review page).
//   K11 walkStagedDraft: drop the page-count floor → (f7) fails (1 of 3 step pages read, approvable).
//   K9 stagedReviewExpectedPages: count only /^advance\b/ notes (the pre-fix heuristic) → (k) fails.
//
//   npx tsx portal-bot/src/reviewDigest.test.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildStagedReviewCapture, DIGEST_MAX_BYTES, DIGEST_MAX_ROWS, dropSelfChangingTimestamps, finishDigestReading,
  SELF_CHANGING_CUE, SELF_CHANGING_TOKEN, walkStagedDraft,
  type DigestKey, type DigestNavigator, type DigestPageItem, type DigestStepLink, type DigestWalk, type RawDigestReading,
} from "./reviewDigest";

let failures = 0;
let total = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  total++;
  try { await fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const KEY: DigestKey = { key: crypto.createHash("sha256").update("unit-test-key-a").digest(), keyId: "aaaaaaaaaaaaaaaa" };
const KEY_B: DigestKey = { key: crypto.createHash("sha256").update("unit-test-key-b").digest(), keyId: "bbbbbbbbbbbbbbbb" };
const NONCE = "0123456789abcdef0123456789abcdef";
const REVIEW_URL = "https://utility.powerclerk.example/MvcProjects/EditForm?ProjectId=4417&FormId=9";

const reading = (items: DigestPageItem[], url = REVIEW_URL): RawDigestReading => ({ title: "Review and Submit", url, items, unreadable: "" });
const f = (label: string, value: string): DigestPageItem => ({ kind: "field", label, value });

/** A one-section walk (the review page), both reads the same. */
const walkOf = (items: DigestPageItem[], extra: Partial<DigestWalk> = {}): DigestWalk => ({
  sections: [{ step: "review", where: "https://utility.powerclerk.example/MvcProjects/EditForm", first: reading(items), second: reading(items), unreadable: "" }],
  reasons: [], stepsFound: 0, stepsRead: 0, writesBlocked: 0, reviewUrl: REVIEW_URL, ...extra,
});
const digestOf = (items: DigestPageItem[], key: DigestKey = KEY, nonce = NONCE): string => {
  const c = buildStagedReviewCapture({ walk: walkOf(items), secrets: [], key, nonce });
  assert.ok(c.approvable, `fixture not approvable: ${c.why.join("; ")}`);
  return c.digest;
};

const BASE: DigestPageItem[] = [
  f("System Size (kW DC)", "7.2"),
  f("Inverter Manufacturer", "Enphase"),
  { kind: "check", label: "I certify the information is correct", value: "checked" },
  { kind: "row", label: "Module", value: "Qcells | 20" },
  { kind: "line", label: "", value: "Review and Submit" },
];

await check("(a) an empty value is a row: emptying a box, or filling an empty one, changes the digest", () => {
  const withEmpty = [...BASE, f("Battery Model", "")];
  const d0 = digestOf(withEmpty);
  assert.notEqual(digestOf([...BASE, f("Battery Model", "Powerwall 3")]), d0, "filling an empty box left the digest unchanged");
  assert.notEqual(digestOf(BASE), d0, "dropping an empty box left the digest unchanged");
  const c = buildStagedReviewCapture({ walk: walkOf(withEmpty), secrets: [], key: KEY, nonce: NONCE });
  assert.ok(c.sections[0].items.some((i) => i.label === "Battery Model"), "the empty box is not in the section's items");
});

await check("(b) an unchecked box is a row: unticking the attestation changes the digest", () => {
  const unticked = BASE.map((i) => (i.kind === "check" ? { ...i, value: "unchecked" } : i));
  assert.notEqual(digestOf(unticked), digestOf(BASE));
});

await check("(c) a 3-cell row counts its third cell", () => {
  const three = [...BASE, { kind: "row" as const, label: "Inverter", value: "IQ8M | 20 | 325 W" }];
  const changed = [...BASE, { kind: "row" as const, label: "Inverter", value: "IQ8M | 20 | 290 W" }];
  assert.notEqual(digestOf(changed), digestOf(three));
});

await check("(d) a same-origin frame's rows count (prefixed by frame)", () => {
  const framed = [...BASE, f("frame 1: Meter Location", "North wall")];
  assert.notEqual(digestOf([...BASE, f("frame 1: Meter Location", "South wall")]), digestOf(framed));
  const c = buildStagedReviewCapture({ walk: walkOf(framed), secrets: [], key: KEY, nonce: NONCE });
  assert.ok(c.sections[0].items.some((i) => i.label === "frame 1: Meter Location"));
});

await check("(e) duplicate labels are counted by ordinal: a swap or a drop changes the digest", () => {
  const two = [...BASE, f("Name", "Preparer Pat"), f("Name", "Customer Cam")];
  const c = buildStagedReviewCapture({ walk: walkOf(two), secrets: [], key: KEY, nonce: NONCE });
  assert.deepEqual(c.sections[0].items.filter((i) => i.label === "Name").map((i) => i.ordinal), [1, 2]);
  assert.notEqual(digestOf([...BASE, f("Name", "Customer Cam"), f("Name", "Preparer Pat")]), digestOf(two), "a swap of two same-labelled values went unseen");
  assert.notEqual(digestOf([...BASE, f("Name", "Preparer Pat")]), digestOf(two), "dropping one of two same-labelled rows went unseen");
});

await check("(f1) over the cap, nothing read: refused by name (finishDigestReading)", () => {
  const many = Array.from({ length: DIGEST_MAX_ROWS + 1 }, (_, i) => f(`Row ${i}`, "x"));
  assert.match(finishDigestReading(REVIEW_URL, "t", many).unreadable, /more than 400 rows/);
  assert.equal(finishDigestReading(REVIEW_URL, "t", many.slice(0, DIGEST_MAX_ROWS)).unreadable, "", "exactly 400 rows is readable");
  const big = [f("Notes", "x".repeat(DIGEST_MAX_BYTES + 1))];
  assert.match(finishDigestReading(REVIEW_URL, "t", big).unreadable, /more than 64 KB/);
  assert.match(finishDigestReading(REVIEW_URL, "t", []).unreadable, /reads nothing/);
});

/** A stub navigator over a fixed set of pages (by href). */
const stubNav = (pages: Record<string, RawDigestReading | RawDigestReading[]>, links: DigestStepLink[], opts: { writes?: number; openFail?: Record<string, string> } = {}) => {
  const reads: Record<string, number> = {};
  let at = REVIEW_URL;
  const nav: DigestNavigator & { visited: string[] } = {
    visited: [],
    openReview: async () => { at = REVIEW_URL; nav.visited.push(at); return opts.openFail?.[REVIEW_URL] ?? ""; },
    read: async () => {
      const p = pages[at];
      const n = reads[at] = (reads[at] ?? 0) + 1;
      if (Array.isArray(p)) return p[Math.min(n - 1, p.length - 1)];
      return p ?? { title: "", url: at, items: [], unreadable: "the page reads nothing" };
    },
    stepLinks: async () => links,
    openStep: async (l) => { at = l.href; nav.visited.push(at); return opts.openFail?.[l.href] ?? ""; },
    writesBlocked: () => opts.writes ?? 0,
    sleep: async () => undefined,
    close: async () => undefined,
  };
  return nav;
};
const S1 = "https://utility.powerclerk.example/MvcProjects/EditForm?ProjectId=4417&FormId=1";
const S2 = "https://utility.powerclerk.example/MvcProjects/EditForm?ProjectId=4417&FormId=2";
const link = (label: string, href: string): DigestStepLink => ({ label, href, navigable: true, why: "" });
const STEP1 = [f("Customer Name", "Avery Fenwick"), f("Service Address", "12 Larch Ln")];
const STEP2 = [f("System Size (kW DC)", "7.2"), { kind: "check" as const, label: "Battery", value: "unchecked" }];
const pagesOf = (step2: DigestPageItem[] = STEP2) => ({ [REVIEW_URL]: reading(BASE), [S1]: reading(STEP1, S1), [S2]: reading(step2, S2) });

await check("(f2) refused by name: a step that opens by a script, no step links on a multi-page recipe, writes blocked", async () => {
  const scripted = await walkStagedDraft(stubNav(pagesOf(), [link("Customer", S1), { label: "Equipment", href: "", navigable: false, why: "it opens by a script" }]), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c1 = buildStagedReviewCapture({ walk: scripted, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c1.approvable, false);
  assert.ok(c1.why.some((w) => /step "Equipment" cannot be opened by navigation alone \(it opens by a script\)/.test(w)), c1.why.join(" | "));

  const noLinks = await walkStagedDraft(stubNav(pagesOf(), []), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 4 });
  const c2 = buildStagedReviewCapture({ walk: noLinks, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c2.approvable, false);
  assert.ok(c2.why.some((w) => /other 3 step page\(s\) cannot be opened by navigation alone/.test(w)), c2.why.join(" | "));
  // A one-page recipe with no step links is the whole draft: MUST PASS.
  const onePage = await walkStagedDraft(stubNav(pagesOf(), []), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 1 });
  assert.equal(buildStagedReviewCapture({ walk: onePage, secrets: [], key: KEY, nonce: NONCE }).approvable, true);

  const wrote = await walkStagedDraft(stubNav(pagesOf(), [link("Customer", S1)], { writes: 2 }), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c3 = buildStagedReviewCapture({ walk: wrote, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c3.approvable, false);
  assert.ok(c3.why.some((w) => /tried to send 2 request\(s\) while being read/.test(w)), c3.why.join(" | "));
});

await check("(f3) refused by name: a dialog, a cross-origin frame, an unreadable step, the review page not reopening, two reads that disagree", async () => {
  const dialog = { ...reading([]), unreadable: "a dialog is open on the page" };
  const xo = { ...reading([], S2), unreadable: "a cross-origin frame (chat.example.net) is on the page" };
  const w1 = await walkStagedDraft(stubNav({ ...pagesOf(), [REVIEW_URL]: dialog }, []), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c1 = buildStagedReviewCapture({ walk: w1, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c1.approvable, false);
  assert.equal(c1.digest, "", "an unreadable row carries a digest");
  assert.deepEqual(c1.sections[0].items, [], "an unreadable page was hashed");
  assert.ok(c1.why.some((w) => /a dialog is open/.test(w)), c1.why.join(" | "));

  const w2 = await walkStagedDraft(stubNav({ ...pagesOf(), [S2]: xo }, [link("Customer", S1), link("Equipment", S2)]), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c2 = buildStagedReviewCapture({ walk: w2, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c2.approvable, false);
  assert.ok(c2.why.some((w) => /cross-origin frame/.test(w)), c2.why.join(" | "));

  const w3 = await walkStagedDraft(stubNav(pagesOf(), [], { openFail: { [REVIEW_URL]: "the portal answered 404" } }), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c3 = buildStagedReviewCapture({ walk: w3, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c3.approvable, false);
  assert.ok(c3.why.some((w) => /review page does not reopen by its link/.test(w)), c3.why.join(" | "));

  const flip = [reading(STEP2, S2), reading([f("System Size (kW DC)", "7.6"), STEP2[1]], S2)];
  const w4 = await walkStagedDraft(stubNav({ ...pagesOf(), [S2]: flip }, [link("Customer", S1), link("Equipment", S2)]), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c4 = buildStagedReviewCapture({ walk: w4, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c4.approvable, false);
  assert.ok(c4.why.some((w) => /Equipment: the page changed between two reads \(System Size \(kW DC\)\)/.test(w)), c4.why.join(" | "));
});

await check("(f6) a walk the navigator refuses (dialogs unwatchable, or the window already the person's) opens nothing and is named", async () => {
  const nav = stubNav(pagesOf(), [link("Customer", S1)]);
  const refused = Object.assign(nav, { refusal: () => "native dialogs on the draft's pages could not be watched (no DevTools session), so the walk did not start" });
  const walk = await walkStagedDraft(refused, { reviewUrl: REVIEW_URL, gapMs: 0 });
  assert.deepEqual(nav.visited, [], "a refused walk opened a page");
  const c = buildStagedReviewCapture({ walk, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c.approvable, false);
  assert.equal(c.digest, "");
  assert.ok(c.why.some((w) => /could not be watched/.test(w)), c.why.join(" | "));
  // MUST PASS: a navigator with no refusal walks as before.
  const ok = await walkStagedDraft(Object.assign(stubNav(pagesOf(), [link("Customer", S1)]), { refusal: () => "" }), { reviewUrl: REVIEW_URL, gapMs: 0 });
  assert.equal(buildStagedReviewCapture({ walk: ok, secrets: [], key: KEY, nonce: NONCE }).approvable, true);
});

await check("(f7) the page-count floor: a recipe of 4 pages whose review page opened 1 step page is refused by that count, named", async () => {
  // The skeptic's shape: the step list offered 5 tabs, the reader found 1 link (the rest were named
  // or missed); the recipe walks 4 pages. Before the floor this read approvable with no reason.
  const one = await walkStagedDraft(stubNav(pagesOf(), [link("Customer Information", S1)]), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 4 });
  const c = buildStagedReviewCapture({ walk: one, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c.approvable, false, "MUST-EXCLUDE: 1 of 3 step pages read and the row is approvable");
  assert.equal(c.digest, "");
  assert.ok(c.why.some((w) => /the recipe walks 4 page\(s\) but only 1 step page\(s\) besides the review page could be opened by navigation alone/.test(w)), c.why.join(" | "));
  // MUST PASS: as many step pages as the recipe walks (or more) is the floor met.
  const met = await walkStagedDraft(stubNav(pagesOf(), [link("Customer", S1), link("Equipment", S2)]), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 3 });
  assert.equal(buildStagedReviewCapture({ walk: met, secrets: [], key: KEY, nonce: NONCE }).approvable, true, "3 pages walked, 2 step pages + review read: refused");
  const more = await walkStagedDraft(stubNav(pagesOf(), [link("Customer", S1), link("Equipment", S2)]), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 1 });
  assert.equal(buildStagedReviewCapture({ walk: more, secrets: [], key: KEY, nonce: NONCE }).approvable, true, "a one-page recipe whose draft shows two more steps: refused");
  // A step that is found but not opened does not count toward the floor.
  const named = await walkStagedDraft(stubNav(pagesOf(), [link("Customer", S1), { label: "Interconnection Request", href: "", navigable: false, why: "its name or its link reads as an action, so the walk never opens it" }]), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 3 });
  const cn = buildStagedReviewCapture({ walk: named, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(cn.approvable, false);
  assert.ok(cn.why.some((w) => /step "Interconnection Request" cannot be opened by navigation alone \(its name or its link reads as an action/.test(w)), cn.why.join(" | "));
  assert.ok(cn.why.some((w) => /the recipe walks 3 page\(s\) but only 1 step page/.test(w)), cn.why.join(" | "));
});

await check("(f5) ruling 3: an uploaded file the draft's pages list is 'listed'; one they do not list is named and the row is not approvable", () => {
  const items = [...BASE, { kind: "line" as const, label: "", value: "site-plan.pdf  uploaded 11/02/2026" }];
  const listed = buildStagedReviewCapture({ walk: walkOf(items), secrets: [], key: KEY, nonce: NONCE, uploads: [{ fileName: "site-plan.pdf", docType: "site_plan" }] });
  assert.ok(listed.approvable, listed.why.join("; "));
  assert.deepEqual(listed.attachments.map((a) => [a.name, a.listed]), [["site-plan.pdf", true]]);
  const absent = buildStagedReviewCapture({ walk: walkOf(items), secrets: [], key: KEY, nonce: NONCE, uploads: [{ fileName: "one-line.pdf", docType: "sld" }] });
  assert.equal(absent.approvable, false);
  assert.ok(absent.why.some((w) => /attachment: one-line\.pdf is not listed on the draft's pages/.test(w)), absent.why.join(" | "));
});

await check("(f4) refused by name: no key (nothing hashed), and no draft id in the review link", () => {
  const c1 = buildStagedReviewCapture({ walk: walkOf(BASE), secrets: [], key: null, nonce: NONCE });
  assert.equal(c1.approvable, false);
  assert.ok(c1.why.some((w) => /SESSION_ENCRYPTION_KEY is not set/.test(w)));
  assert.ok(c1.sections.every((s) => s.items.length === 0 && s.digest === ""), "a keyless capture carries macs");
  const c2 = buildStagedReviewCapture({ walk: { ...walkOf(BASE), reviewUrl: "https://utility.powerclerk.example/MvcProjects/Review" }, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c2.approvable, false);
  assert.ok(c2.why.some((w) => /carries no draft id/.test(w)));
});

await check("(g) ruling 7, pinned: the exact cue and token patterns", () => {
  assert.equal(SELF_CHANGING_CUE.source, "\\b(?:saved|updated|modified|edited)\\b|\\bas\\s+of\\b");
  assert.equal(SELF_CHANGING_CUE.flags, "i");
  assert.equal(SELF_CHANGING_TOKEN.flags, "gi");
  assert.equal(SELF_CHANGING_TOKEN.source,
    "\\b(?:\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?"
    + "|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}"
    + "|(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun),?\\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?"
    + "|(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun),?\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?:,?\\s+\\d{4})?"
    + "|\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]\\.?\\s?m\\.?)?"
    + "|\\d{1,2}\\s*[ap]\\.?\\s?m\\.?)(?![\\w/:])");
  // The token forms it drops on a cue line.
  for (const [line, want] of [
    ["Last saved 2:41 PM", "Last saved ⟨time⟩"],
    ["Updated 11/03/2026 at 14:41:05", "Updated ⟨time⟩ at ⟨time⟩"],
    ["Modified 2026-11-03T14:41:05Z", "Modified ⟨time⟩"],
    ["As of Monday, November 3, 2026 2:41 p.m.", "As of ⟨time⟩ ⟨time⟩"],
    ["Last edited 3 Nov 2026", "Last edited ⟨time⟩"],
    ["Draft saved at 9am", "Draft saved at ⟨time⟩"],
  ] as const) assert.equal(dropSelfChangingTimestamps(line), want, line);
  // NOT dropped: no cue on the line; a number that is no time or date.
  assert.equal(dropSelfChangingTimestamps("Total 2:41"), "Total 2:41");
  assert.equal(dropSelfChangingTimestamps("Install date 11/03/2026"), "Install date 11/03/2026");
  assert.equal(dropSelfChangingTimestamps("System size updated to 7.2 kW"), "System size updated to 7.2 kW");
});

await check("(g) ruling 7 in the digest: the ignored token reads the same; the real change beside it still counts", () => {
  const at = (line: string, extra: DigestPageItem[] = []) => digestOf([...BASE, { kind: "line", label: "", value: line }, ...extra]);
  assert.equal(at("Last saved 2:41 PM"), at("Last saved 3:05 PM"), "MUST PASS: a self-changing 'last saved' time refused the page");
  assert.notEqual(at("Last saved 2:41 PM by Alice"), at("Last saved 3:05 PM by Bob"), "the name beside the dropped time went unseen");
  assert.notEqual(at("Total 2:41"), at("Total 3:05"), "a time on a line with no cue was dropped");
  // A <dl> pair whose LABEL carries the cue drops the date in its value...
  const pair = (v: string) => digestOf([...BASE, { kind: "pair", label: "Last Updated", value: v }]);
  assert.equal(pair("11/03/2026"), pair("11/04/2026"));
  // ...a control's value never: "Date updated" on a box is an answer the person files.
  const box = (v: string) => digestOf([...BASE, f("Date panel updated", v)]);
  assert.notEqual(box("11/03/2026"), box("11/04/2026"), "a control's date value was dropped by ruling 7");
});

await check("(h) multi-page: one section per step (review first, then tab order); a change on step 2 changes only that section", async () => {
  const walk = await walkStagedDraft(stubNav(pagesOf(), [link("Customer", S1), link("Equipment", S2)]), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: 3 });
  const c = buildStagedReviewCapture({ walk, secrets: [], key: KEY, nonce: NONCE });
  assert.ok(c.approvable, c.why.join("; "));
  assert.deepEqual(c.sections.map((s) => s.step), ["review", "Customer", "Equipment"]);
  assert.equal(c.walk.stepsFound, 2);
  assert.equal(c.walk.stepsRead, 2);
  const walk2 = await walkStagedDraft(stubNav(pagesOf([f("System Size (kW DC)", "7.6"), STEP2[1]]), [link("Customer", S1), link("Equipment", S2)]), { reviewUrl: REVIEW_URL, gapMs: 0 });
  const c2 = buildStagedReviewCapture({ walk: walk2, secrets: [], key: KEY, nonce: NONCE });
  assert.notEqual(c2.digest, c.digest, "a change on a step page left the row's digest unchanged");
  assert.equal(c2.sections[0].digest, c.sections[0].digest, "the review section changed");
  assert.equal(c2.sections[1].digest, c.sections[1].digest, "step 1 changed");
  assert.notEqual(c2.sections[2].digest, c.sections[2].digest, "step 2's section did not change");
  // Each page is read twice, and nothing but the step links is opened.
  const nav = stubNav(pagesOf(), [link("Customer", S1), link("Equipment", S2)]);
  await walkStagedDraft(nav, { reviewUrl: REVIEW_URL, gapMs: 0 });
  assert.deepEqual(nav.visited, [REVIEW_URL, S1, S2]);
});

await check("(i) the key: same key and nonce give the same digest; another key or nonce share nothing", () => {
  assert.equal(digestOf(BASE), digestOf(BASE), "the digest is not deterministic");
  const a = buildStagedReviewCapture({ walk: walkOf(BASE), secrets: [], key: KEY, nonce: NONCE });
  const b = buildStagedReviewCapture({ walk: walkOf(BASE), secrets: [], key: KEY_B, nonce: NONCE });
  assert.notEqual(a.keyId, b.keyId);
  assert.notEqual(a.digest, b.digest);
  const n2 = buildStagedReviewCapture({ walk: walkOf(BASE), secrets: [], key: KEY, nonce: "fedcba9876543210fedcba9876543210" });
  const macs = new Set(a.sections[0].items.map((i) => i.mac));
  assert.ok(n2.sections[0].items.every((i) => !macs.has(i.mac)), "two rows (two nonces) share a mac: the same value links across projects");
  assert.ok(a.sections[0].items.every((i) => /^[0-9a-f]{64}$/.test(i.mac)));
});

await check("(j) the label output: redacted (a secret to its last 4) and at most 80 characters", () => {
  const items = [...BASE, f("Account 8813009274 on file", "8813009274"), f("L".repeat(200), "x")];
  const c = buildStagedReviewCapture({ walk: walkOf(items), secrets: ["8813009274"], key: KEY, nonce: NONCE });
  const json = JSON.stringify(c);
  assert.ok(!/8813009274/.test(json), "the secret is in the capture");
  assert.ok(c.sections[0].items.every((i) => i.label.length <= 80));
  const row = c.fieldReport.find((r) => /^Account/.test(r.label));
  assert.ok(row && /\*+9274/.test(row.display), `the field report did not mask the account: ${JSON.stringify(row)}`);
});

await check("(k) the recipe's page count reads every advancing click: a hand-patched 'Next' is a page, the final submit is not", async () => {
  const { stagedReviewExpectedPages } = await import("./adapters/recipeAdapter");
  const fill = { action: "fill", selector: { label: "Customer Name" }, field: "customerName" } as const;
  const steps = [
    { action: "goto", value: REVIEW_URL } as const,
    fill,
    { action: "click", selector: { role: "button", name: "Next" }, note: "human-patch: Next" } as const,
    fill,
    { action: "click", selector: { role: "button", name: "Save and Continue" }, note: "advance: Save and Continue" } as const,
    { action: "stopForReview" } as const,
    { action: "click", selector: { role: "button", name: "Submit and Continue" }, note: "final submit: Submit and Continue", isFinalSubmit: true } as const,
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(stagedReviewExpectedPages(steps as any), 3, "the hand-patched Next (no 'advance:' note) was not counted, or the final submit was");
  // ...so a review page that offers no step link is refused for the two pages it cannot open.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = await walkStagedDraft(stubNav(pagesOf(), []), { reviewUrl: REVIEW_URL, gapMs: 0, expectedPages: stagedReviewExpectedPages(steps as any) });
  const c = buildStagedReviewCapture({ walk, secrets: [], key: KEY, nonce: NONCE });
  assert.equal(c.approvable, false);
  assert.ok(c.why.some((w) => /other 2 step page\(s\) cannot be opened by navigation alone/.test(w)), c.why.join(" | "));
  // MUST PASS: an in-page "Add New" or "Search" click is not a page.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(stagedReviewExpectedPages([fill, { action: "click", selector: { role: "button", name: "Add New Contact" }, note: "human-patch: Add New Contact" }, { action: "stopForReview" }] as any), 1);
});

console.log(failures === 0 ? `\nAll ${total}/${total} reviewDigest checks passed.` : `\n${failures}/${total} reviewDigest check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
