// THE INFORMATION-PAGE PASS'S ONE PREDICATE, PURE (#344, option B: shared/src/infoPagePass.ts).
//
// A synthetic DevHub-like "Permitting Information" material (no tenant, no live page) is digested
// and judged. Pinned here, in Node, with no browser:
//   DIGEST  — the same material gives the same six hashes; one change per component moves that
//             component and the identity; a golden identity forces an INFO_PAGE_IDENTITY_VERSION bump.
//   SHAPE   — the DevHub shape refuses nothing; every review-page shape refuses (a field, a summary,
//             a submit-worded control, GET, another origin, a target, a file input, a frame, extra
//             body names, a filing / payment action, a draft notice, an unnamed or image submitter).
//   RUN     — only goto / entry clicks / admitted advances, every flag false, the exact prefix.
//   BACKSTOP— locked, a window, an approved slot, a stopping abort, an own write, a 4th admission,
//             a page the backstop would not hold.
//   REQUEST — Chromium-shaped multipart and urlencoded bodies parse; every substitution refuses.
//   GREP    — the predicate is called only from shared/src/infoPagePass.ts and filingBackstop.ts;
//             the pass tables are written only by backend/src/infoPages.ts.
//
//   npx tsx portal-bot/src/infoPagePass.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INFO_PAGE_IDENTITY_VERSION, INFO_PAGE_NO_MATCH, digestInfoPageIdentity, infoPageBackstopRefusals, infoPageEvidence, infoPageMatchRefusals,
  infoPageObservedRequest, infoPagePassRefusals, infoPagePrefixOf, infoPageProjectValueRefusals, infoPageRequestRefusals, infoPageRunStateRefusals,
  infoPageShapeRefusals, infoPageVerifyWarnings, isMatchClassRefusal, mayPassInfoPage, parseFormBodyFields, verifiedInfoPageFromCandidate,
  type InfoPageBackstopState, type InfoPageIdentityMaterial, type InfoPagePassContext, type InfoPageRunState,
} from "../../shared/src/infoPagePass";
import { isInterstitialForwardLabel, portalSafetyFactory } from "../../shared/src/portalSafety";
import type { VerifiedInfoPage } from "../../shared/src/types";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const ORIGIN = "https://permits.example.test";
const ACTION = `${ORIGIN}/permits/sfjsp`;
const PROSE = "This is a permit request only. A Permit Tech will review your submission for minimum submittal standards, and if met, a permit will be created. Once your permit has been deemed complete for intake, you will be provided with instructions via email for how to pay your intake fees. Please do not submit additional requests for the same scope of work.";
const devhub = (): InfoPageIdentityMaterial => ({
  version: INFO_PAGE_IDENTITY_VERSION,
  page: { origin: ORIGIN, path: "/permits/sfjsp", query: [] },
  title: "Development Hub Fixture",
  structure: {
    headings: [["1", "Development Hub Fixture"], ["2", "Online License & Permit Services"]],
    forms: [{ id: "smartguide_ApplyForAPermit", name: "", method: "post", enctype: "multipart/form-data", action: ACTION, target: "", elements: [["button", "button", "", null], ["button", "submit", "t_p1685049573549", null], ["button", "submit", "t_n1685049573549", null]] }],
    fillable: [],
    clickables: [["button", "button", "", -1, ""], ["a", "", "", 0, `${ORIGIN}/permits/sfjsp?interviewID`], ["button", "submit", "t_p1685049573549", 0, ""], ["button", "submit", "t_n1685049573549", 0, ""]],
    frames: [],
  },
  facts: { fileInputsInForm: 0, customFormElements: 0, summaryOutsideChrome: 0, summaryInForm: 0, controlLabels: ["Placeholder Solar Co", "Toggle navigation", "Previous", "Next"], hiddenNames: [], masked: 0, baseTarget: "" },
  text: `Placeholder Solar Co Development Hub Fixture Permitting Information ${PROSE} Previous Next`,
  control: { tag: "button", type: "submit", name: "t_n1685049573549", value: "", label: "Next", formIndex: 0, submitterIndex: 1, method: "post", action: ACTION, enctype: "multipart/form-data", target: "" },
  request: { method: "POST", url: ACTION, media: "multipart/form-data", body: [["t_n1685049573549", ""]] },
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ---------------------------------------------------------------------------------------------
console.log("\nDIGEST");
{
  const a = digestInfoPageIdentity(devhub());
  const b = digestInfoPageIdentity(devhub());
  check("the same material gives the same six component hashes and the same identity",
    JSON.stringify(a.components) === JSON.stringify(b.components) && a.identitySha256 === b.identitySha256);
  const variants: Array<[string, keyof typeof a.components, (m: InfoPageIdentityMaterial) => void]> = [
    ["a field added", "structureSha", (m) => { m.structure.fillable.push(["input", "text", "addr", 0]); }],
    ["the form's action changed", "structureSha", (m) => { m.structure.forms[0].action = `${ORIGIN}/permits/sfjsp2`; }],
    ["the enctype changed", "structureSha", (m) => { m.structure.forms[0].enctype = "application/x-www-form-urlencoded"; }],
    ["the submitter renamed", "controlSha", (m) => { m.control.name = "t_n9"; }],
    ["the submitter's value changed", "controlSha", (m) => { m.control.value = "go"; }],
    ["one character of text", "textSha", (m) => { m.text = m.text.replace("only.", "only!"); }],
    ["a hidden input added", "structureSha", (m) => { m.structure.forms[0].elements.push(["input", "hidden", "__csrf", "abc"]); }],
    ["a hidden value changed", "structureSha", (m) => { m.structure.forms[0].elements.push(["input", "hidden", "__csrf", "abd"]); }],
    ["the title", "titleSha", (m) => { m.title = "Development Hub Fixture 2"; }],
    ["a query value", "pageSha", (m) => { m.page.query = [["x", "1"]]; }],
    ["the host / port", "pageSha", (m) => { m.page.origin = "https://permits.example.test:8443"; }],
    ["an iframe added", "structureSha", (m) => { m.structure.frames.push(["iframe", `${ORIGIN}/wizard`, 600, 400, true]); }],
    ["a heading changed", "structureSha", (m) => { m.structure.headings[0][1] = "Review and Submit"; }],
    ["a <dl> added", "structureSha", (m) => { m.facts.summaryOutsideChrome = 1; }],
    ["the request body changed", "requestSha", (m) => { m.request.body = [["t_n1685049573549", ""], ["addr", "1 Test St"]]; }],
  ];
  const withHidden = digestInfoPageIdentity((() => { const m = devhub(); m.structure.forms[0].elements.push(["input", "hidden", "__csrf", "abc"]); return m; })());
  for (const [what, comp, mutate] of variants) {
    const m = devhub();
    mutate(m);
    const d = digestInfoPageIdentity(m);
    const base = what === "a hidden value changed" ? withHidden : a;
    check(`${what}: moves ${comp} and the identity`, d.components[comp] !== base.components[comp] && d.identitySha256 !== base.identitySha256,
      `${comp} ${d.components[comp].slice(0, 8)} vs ${base.components[comp].slice(0, 8)}`);
  }
  check("raw hidden values are never kept in the digest", !JSON.stringify(withHidden).includes("\"abc\""));
  check("raw text is never kept in the digest", !JSON.stringify(a).includes("Permit Tech"));
  // GOLDEN: any change to the material's shape or the digest's canonical form moves this value. If
  // this check fails, bump INFO_PAGE_IDENTITY_VERSION (every verified page is then void) and pin the
  // new value — never just re-pin it.
  const GOLDEN = "fbcfc5534ef8cd9cfe93fd2915529ac49ca02ef49e3a781bc8fcce72312fdc1b";
  check(`golden identitySha256 for the fixed material (version ${INFO_PAGE_IDENTITY_VERSION})`, a.identitySha256 === GOLDEN, `got ${a.identitySha256}`);
}

// ---------------------------------------------------------------------------------------------
console.log("\nSHAPE");
{
  const d = digestInfoPageIdentity(devhub());
  check("the DevHub-like page refuses nothing", infoPageShapeRefusals(d.shape).length === 0, JSON.stringify(infoPageShapeRefusals(d.shape)));
  const warns = infoPageVerifyWarnings(d.shape, devhub().text);
  check("'how to pay your intake fees' is a WARNING, never a refusal",
    warns.some((w) => /payment or fees/.test(w)) && !infoPageShapeRefusals(d.shape).some((r) => /pay/i.test(r)), JSON.stringify(warns));
  const refuse: Array<[string, (m: InfoPageIdentityMaterial) => void, RegExp]> = [
    ["GET method", (m) => { m.request.method = "GET"; m.control.method = "get"; }, /not POST/],
    ["a cross-origin action", (m) => { m.request.url = "https://other.example.test/permits/sfjsp"; }, /another origin/],
    ["target=_blank", (m) => { m.control.target = "_blank"; }, /another window/],
    ["<base target=_blank>", (m) => { m.facts.baseTarget = "_blank"; }, /<base>/],
    ["a file input", (m) => { m.facts.fileInputsInForm = 1; }, /file input/],
    ["one fillable control anywhere (visible or not)", (m) => { m.structure.fillable.push(["input", "text", "q", -1]); }, /fillable/],
    ["a body name beyond hidden + submitter", (m) => { m.request.body.push(["addr", "1 Test St"]); }, /beyond the hidden/],
    ["an unnamed submitter", (m) => { m.control.name = ""; }, /no name/],
    ["an input[type=image] submitter", (m) => { m.control.tag = "input"; m.control.type = "image"; }, /not a submit button/],
    ["the label 'Submit'", (m) => { m.control.label = "Submit"; }, /plain forward|submit-/],
    ["the label 'Pay and Continue'", (m) => { m.control.label = "Pay and Continue"; }, /plain forward|pay-worded/],
    ["the label 'Continue Application'", (m) => { m.control.label = "Continue Application"; }, /plain forward|submit-/],
    ["the label 'Previous'", (m) => { m.control.label = "Previous"; }, /plain forward/],
    ["the label 'Save and Continue'", (m) => { m.control.label = "Save and Continue"; }, /saves as it goes/],
    ["action /submitApplication", (m) => { m.request.url = `${ORIGIN}/permits/submitApplication`; }, /filing or a payment/],
    ["action /payment", (m) => { m.request.url = `${ORIGIN}/permits/payment`; }, /filing or a payment/],
    ["a visible 'Submit Request' button", (m) => { m.facts.controlLabels.push("Submit Request"); }, /Submit Request/],
    ["a <dl> summary inside the form", (m) => { m.facts.summaryInForm = 2; }, /summary/],
    ["a <dl> / <th> summary outside the chrome", (m) => { m.facts.summaryOutsideChrome = 1; }, /summary/],
    ["a rendered iframe", (m) => { m.structure.frames.push(["iframe", "https://x.example.test/w", 600, 400, false]); }, /frame/],
    ["a hidden same-origin iframe", (m) => { m.structure.frames.push(["iframe", `${ORIGIN}/w`, 0, 0, true]); }, /frame/],
    ["a text/plain form", (m) => { m.request.media = "text/plain"; }, /only multipart/],
    ["a draft-in-progress notice", (m) => { m.text += " You have an application in progress. Draft 2026-0141."; }, /draft/],
    ["an application number on the page", (m) => { m.text += " Application number: BLD-2026-0141."; }, /draft|number/],
    ["two maskable toggles", (m) => { m.facts.masked = 2; }, /tenant mask/],
  ];
  for (const [what, mutate, re] of refuse) {
    const m = devhub();
    mutate(m);
    const r = infoPageShapeRefusals(digestInfoPageIdentity(m).shape);
    check(`refused: ${what}`, r.some((x) => re.test(x)), JSON.stringify(r));
  }
  check("the project's own street on the page refuses", infoPageProjectValueRefusals(`${PROSE} Site: 1 Test St, Springfield`, ["1 Test St", "Jordan Testcase"]).length === 1);
  check("the project's system size on the page refuses", infoPageProjectValueRefusals("System size 7.6 kW DC", ["7.6 kW"]).length === 1);
  check("DevHub's own text names none of a synthetic project's values (phone 503-000-0000, TTY 711)",
    infoPageProjectValueRefusals(`${PROSE} 503-000-0000 711`, ["1 Test St", "Jordan Testcase", "7 kW", "R1234567"]).length === 0);
  check("isInterstitialForwardLabel (moved into the shared factory) answers the golden list unchanged",
    ["Next", "Continue", "Proceed", "Begin", "Start", "Get Started", "Next »", "Save and Continue", "Continue >"].every(isInterstitialForwardLabel)
    && !["Previous", "Back", "Cancel", "Continue Later", "Save and Exit", "Submit", "Continue Application", "Pay Fees", "Next Record", "Continue Draft"].some(isInterstitialForwardLabel));
  const f = portalSafetyFactory() as unknown as Record<string, unknown>;
  check("the factory exports infoPageIdentityInPage, isInterstitialForwardLabel and INFO_PAGE_IDENTITY_VERSION",
    typeof f.infoPageIdentityInPage === "function" && typeof f.isInterstitialForwardLabel === "function" && f.INFO_PAGE_IDENTITY_VERSION === INFO_PAGE_IDENTITY_VERSION);
}

// ---------------------------------------------------------------------------------------------
console.log("\nRUN STATE, BACKSTOP STATE, MATCH");
const PREFIX_STEPS = [
  { action: "goto", note: "entry url", value: `${ORIGIN}/permits/sfjsp?interviewID=Home` },
  { action: "click", note: "application entry: Apply For A Permit" },
  { action: "click", note: "permit type: Solar Permit Request" },
];
const cleanRun = (): InfoPageRunState => ({
  priorSteps: clone(PREFIX_STEPS), formPageSeen: false, continuedDraft: false, draftResume: false, signatureCheck: false,
  signatureStep: false, signatureDone: false, writes: 0, gapFills: 0, priorProgress: false, projectValues: ["1 Test St", "Jordan Testcase"],
});
const liveBackstop = (): InfoPageBackstopState => ({
  installed: true, disposed: false, locked: false, windowsOpen: false, approvedSlotOpen: false, approvedEverOpened: false,
  stoppingAbort: false, everWrote: false, admissions: 0, admittedEntryIds: [], wideTerminal: true,
});
const entryFor = (m: InfoPageIdentityMaterial, prefix = PREFIX_STEPS, id = "pass-1"): VerifiedInfoPage => {
  const d = digestInfoPageIdentity(m);
  return { id, verifiedAt: "2026-10-15T00:00:00.000Z", ...verifiedInfoPageFromCandidate({ identityVersion: d.version, identitySha256: d.identitySha256, digest: d, prefix: infoPagePrefixOf(prefix) }) };
};
const ctxWith = (o: Partial<{ run: InfoPageRunState; backstop: InfoPageBackstopState; material: InfoPageIdentityMaterial; entries: VerifiedInfoPage[] }> = {}): InfoPagePassContext => {
  const m = o.material ?? devhub();
  return {
    backstop: o.backstop ?? liveBackstop(),
    run: o.run ?? cleanRun(),
    identity: { ok: true, digest: digestInfoPageIdentity(m), projectValueHits: [] },
    entries: o.entries ?? [entryFor(devhub())],
  };
};
{
  const ok = ctxWith();
  check("PASSES only on the exact prefix [goto, application entry, permit type] with every flag false or 0",
    mayPassInfoPage(ok) && infoPagePassRefusals(ok).length === 0, JSON.stringify(infoPagePassRefusals(ok)));
  check("mayPassInfoPage === (refusals.length === 0)", mayPassInfoPage(ok) === (infoPagePassRefusals(ok).length === 0));
  const steps: Array<[string, { action: string; note?: string; value?: string; admitted?: boolean }]> = [
    ["fill", { action: "fill", note: "Site Address" }], ["check", { action: "check", note: "I agree" }], ["uncheck", { action: "uncheck", note: "x" }],
    ["select", { action: "select", note: "Type" }], ["upload", { action: "upload", note: "site plan" }], ["press", { action: "press", note: "Enter" }],
    ["stopForReview", { action: "stopForReview", note: "review" }], ["a terms check", { action: "check", note: "accept entry terms" }],
    ["'advance: Yes' (tw)", { action: "click", note: "advance: Yes" }], ["'record type:' (k1)", { action: "click", note: "record type: Residential - Structural" }],
    ["'choice tile:'", { action: "click", note: "choice tile: New" }], ["'navigate to application:'", { action: "click", note: "navigate to application: X" }],
    ["'create application:'", { action: "click", note: "create application: X" }], ["'work location:'", { action: "click", note: "work location: X" }],
    ["'e-signature:'", { action: "click", note: "e-signature: X" }], ["'accela:'", { action: "click", note: "accela: re-enter" }],
    ["an unadmitted 'advance: Next' (lrp / lrn)", { action: "click", note: "advance: Next" }],
  ];
  for (const [what, step] of steps) {
    const run = cleanRun();
    run.priorSteps.push(step);
    const entries = [entryFor(devhub(), [...PREFIX_STEPS, step])];
    const r = infoPagePassRefusals(ctxWith({ run, entries }));
    check(`refused even with an exact entry for that prefix: a recorded ${what}`, r.some((x) => /is not an entry click/.test(x)), JSON.stringify(r));
  }
  const flags: Array<[keyof InfoPageRunState, unknown]> = [["formPageSeen", true], ["continuedDraft", true], ["draftResume", true], ["signatureCheck", true],
    ["signatureStep", true], ["signatureDone", true], ["writes", 1], ["gapFills", 1], ["priorProgress", true]];
  for (const [k, v] of flags) {
    const run = cleanRun() as unknown as Record<string, unknown>;
    run[k] = v;
    check(`refused: run ${String(k)}=${String(v)}`, !mayPassInfoPage(ctxWith({ run: run as unknown as InfoPageRunState })));
  }
  for (const k of Object.keys(cleanRun()) as Array<keyof InfoPageRunState>) {
    const run = cleanRun() as unknown as Record<string, unknown>;
    delete run[k];
    check(`refused: run state missing ${String(k)}`, !mayPassInfoPage(ctxWith({ run: run as unknown as InfoPageRunState })));
  }
  const bsCases: Array<[string, Partial<InfoPageBackstopState>]> = [
    ["everWrote", { everWrote: true }], ["locked (4a)", { locked: true }], ["approvedEverOpened", { approvedEverOpened: true }],
    ["an approved slot open", { approvedSlotOpen: true }], ["a prior stopping abort", { stoppingAbort: true }], ["an open window", { windowsOpen: true }],
    ["a fourth admission", { admissions: 3 }], ["disposed", { disposed: true }], ["not installed", { installed: false }],
    ["the page is not wide-terminal (the click would not be held)", { wideTerminal: false }], ["the wide reading unknown", { wideTerminal: null }],
  ];
  for (const [what, patch] of bsCases) {
    check(`refused: backstop ${what}`, !mayPassInfoPage(ctxWith({ backstop: { ...liveBackstop(), ...patch } })), JSON.stringify(infoPageBackstopRefusals({ ...liveBackstop(), ...patch })));
  }
  check("refused: the same entry admitted twice on a run", !mayPassInfoPage(ctxWith({ backstop: { ...liveBackstop(), admissions: 1, admittedEntryIds: ["pass-1"] } })));
  check("refused: no backstop at all", !mayPassInfoPage({ ...ctxWith(), backstop: null }));
  check("refused: no entries — and the refusal is match-class (a candidate may be recorded)",
    (() => { const r = infoPagePassRefusals(ctxWith({ entries: [] })); return r.length === 1 && isMatchClassRefusal(r[0]); })(), JSON.stringify(infoPagePassRefusals(ctxWith({ entries: [] }))));
  const old = entryFor(devhub());
  old.identityVersion = INFO_PAGE_IDENTITY_VERSION - 1;
  check("refused: an entry of an older identity version", !mayPassInfoPage(ctxWith({ entries: [old] })));
  const otherControl = entryFor(devhub());
  otherControl.controlName = "t_p1685049573549";
  check("refused: an entry whose control differs", !mayPassInfoPage(ctxWith({ entries: [otherControl] })));
  const otherReq = entryFor(devhub());
  otherReq.request = { ...otherReq.request, body: [["t_n1685049573549", "x"]] };
  check("refused: an entry whose request differs", !mayPassInfoPage(ctxWith({ entries: [otherReq] })));
  // Critique [0]: a different tile to the same page.
  const tileB = cleanRun();
  tileB.priorSteps[2] = { action: "click", note: "permit type: Trade Permits" };
  const rB = infoPagePassRefusals(ctxWith({ run: tileB }));
  check("refused: the same page reached through a DIFFERENT permit-type tile (exact prefix)", rB.some((x) => /different steps/.test(x)), JSON.stringify(rB));
  const gotoElsewhere = cleanRun();
  gotoElsewhere.priorSteps[0] = { action: "goto", note: "entry url", value: `${ORIGIN}/other?interviewID=Home` };
  check("refused: the same page reached from a different entry URL", !mayPassInfoPage(ctxWith({ run: gotoElsewhere })));
  check("refused: the identity unread", !mayPassInfoPage({ ...ctxWith(), identity: { ok: false, why: "x" } }));
  check("refused: the project-value check not done", !mayPassInfoPage({ ...ctxWith(), identity: { ok: true, digest: digestInfoPageIdentity(devhub()) } }));
  // Drift naming: the date, never the person.
  const changed = devhub();
  changed.text += " Your card on file will be charged $350 now.";
  const m = infoPageMatchRefusals(digestInfoPageIdentity(changed), [entryFor(devhub())], infoPagePrefixOf(PREFIX_STEPS));
  check("a near-miss names what drifted and the date, never a person",
    m.entry === null && m.refusals.length === 1 && m.refusals[0].startsWith(INFO_PAGE_NO_MATCH) && /text/.test(m.refusals[0]) && /2026-10-15/.test(m.refusals[0]), JSON.stringify(m.refusals));
  check("undefined context refuses", !mayPassInfoPage(undefined) && infoPagePassRefusals(undefined).length > 0);
}

// ---------------------------------------------------------------------------------------------
console.log("\nREQUEST");
{
  const B = "----WebKitFormBoundaryAbC123xYz";
  const ct = `multipart/form-data; boundary=${B}`;
  const mp = (parts: Array<[string, string, string?]>): string => `${parts.map(([n, v, extra]) => `--${B}\r\nContent-Disposition: form-data; name="${n}"${extra ?? ""}\r\n\r\n${v}\r\n`).join("")}--${B}--\r\n`;
  const expected = digestInfoPageIdentity(devhub()).expected;
  const obs = (body: string | null, contentType = ct, url = ACTION, method = "POST") => infoPageObservedRequest(method, url, contentType, body === null ? null : Buffer.from(body, "latin1"));
  check("the multipart Next body passes", infoPageRequestRefusals(expected, obs(mp([["t_n1685049573549", ""]]))).length === 0, JSON.stringify(infoPageRequestRefusals(expected, obs(mp([["t_n1685049573549", ""]])))));
  const uM = devhub();
  uM.request.media = "application/x-www-form-urlencoded";
  const uExp = digestInfoPageIdentity(uM).expected;
  check("the urlencoded body passes against a urlencoded entry", infoPageRequestRefusals(uExp, obs("t_n1685049573549=", "application/x-www-form-urlencoded")).length === 0);
  const bad: Array<[string, ReturnType<typeof obs>]> = [
    ["requestSubmit() with no submitter (empty body)", obs(`--${B}--\r\n`)],
    ["an added 'addr' part", obs(mp([["addr", "1 Test St"], ["t_n1685049573549", ""]]))],
    ["a hidden __csrf that is not expected", obs(mp([["__csrf", "abc"], ["t_n1685049573549", ""]]))],
    ["a filename= part", obs(mp([["t_n1685049573549", ""], ["f", "x", "; filename=\"a.pdf\""]]))],
    ["a null body", obs(null)],
    ["a malformed boundary", obs(mp([["t_n1685049573549", ""]]), "multipart/form-data; boundary=nope")],
    ["a query added to the URL", obs(mp([["t_n1685049573549", ""]]), ct, `${ACTION}?x=1`)],
    ["method PUT", obs(mp([["t_n1685049573549", ""]]), ct, ACTION, "PUT")],
    ["urlencoded vs multipart", obs("t_n1685049573549=", "application/x-www-form-urlencoded")],
    ["a submitter value mismatch", obs(mp([["t_n1685049573549", "1"]]))],
    ["text/plain", obs("t_n1685049573549=\r\n", "text/plain")],
  ];
  for (const [what, o] of bad) check(`refused: ${what}`, infoPageRequestRefusals(expected, o).length > 0, JSON.stringify(o));
  const csrfM = devhub();
  csrfM.structure.forms[0].elements.push(["input", "hidden", "__csrf", "abc"]);
  csrfM.request.body = [["__csrf", "abc"], ["t_n1685049573549", ""]];
  csrfM.facts.hiddenNames = ["__csrf"];
  const csrfExp = digestInfoPageIdentity(csrfM).expected;
  check("__csrf expected and sent unchanged passes", infoPageRequestRefusals(csrfExp, obs(mp([["__csrf", "abc"], ["t_n1685049573549", ""]]))).length === 0);
  check("refused: __csrf expected but its value changed", infoPageRequestRefusals(csrfExp, obs(mp([["__csrf", "abd"], ["t_n1685049573549", ""]]))).length > 0);
  check("refused: the same fields in a different order", infoPageRequestRefusals(csrfExp, obs(mp([["t_n1685049573549", ""], ["__csrf", "abc"]]))).length > 0);
  const q = parseFormBodyFields(ct, Buffer.from(mp([["a%22b%0D%0Ac", "v"]]), "latin1"));
  check("Chromium's %22 / %0D%0A quoted names parse back", !!q && q.fields[0][0] === "a\"b\r\nc", JSON.stringify(q));
}

// ---------------------------------------------------------------------------------------------
console.log("\nEVIDENCE");
{
  const m = devhub();
  m.structure.forms[0].elements.push(["input", "hidden", "__csrf", "SECRETVALUE"]);
  const ev = infoPageEvidence(m, (s) => s.replace(/Placeholder Solar Co/g, "[account]"));
  check("evidence carries no field value (hidden values dropped)", !JSON.stringify(ev).includes("SECRETVALUE"));
  check("evidence text goes through the caller's scrub", !ev.text.includes("Placeholder Solar Co") && ev.text.includes("[account]"));
}

// ---------------------------------------------------------------------------------------------
console.log("\nGREP PINS");
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const files = [...walk(path.join(root, "shared/src")), ...walk(path.join(root, "portal-bot/src")), ...walk(path.join(root, "backend/src"))]
    .filter((f) => !/\.test\.ts$|\.smoke\.ts$/.test(f));
  const rel = (f: string): string => path.relative(root, f).replace(/\\/g, "/");
  const callers = files.filter((f) => /infoPagePassRefusals\(|mayPassInfoPage\(|infoPagePassEntry\(/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
  check("the pass predicate is called only from shared/src/infoPagePass.ts and portal-bot/src/filingBackstop.ts",
    JSON.stringify(callers) === JSON.stringify(["portal-bot/src/filingBackstop.ts", "shared/src/infoPagePass.ts"]), JSON.stringify(callers));
  const writers = files.filter((f) => /(INSERT\s+INTO|UPDATE)\s+portal_info_page_(passes|candidates)\b/i.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
  check("portal_info_page_passes / _candidates are written only by backend/src/infoPages.ts",
    JSON.stringify(writers) === JSON.stringify(["backend/src/infoPages.ts"]), JSON.stringify(writers));
  const learner = fs.readFileSync(path.join(root, "portal-bot/src/adapters/autoLearnAdapter.ts"), "utf8");
  check("the learner opens an information-page pass at exactly one place", (learner.match(/\.openInfoPagePass\(/g) ?? []).length === 1);
  const replay = fs.readFileSync(path.join(root, "portal-bot/src/adapters/recipeAdapter.ts"), "utf8");
  check("replay never opens one (learner-only in this change: replay stops as on main)", !/openInfoPagePass/.test(replay));
  const infoFiles = files.filter((f) => /infoPage/i.test(fs.readFileSync(f, "utf8")) && /allowApprovedFiling/.test(fs.readFileSync(f, "utf8")))
    .filter((f) => !/filingBackstop\.ts$|recipeAdapter\.ts$/.test(f)).map(rel);
  check("no info-page code path calls allowApprovedFiling", infoFiles.length === 0, JSON.stringify(infoFiles));
}

if (failures) { console.error(`\n${failures}/${total} infoPagePass.test check(s) FAILED.`); process.exit(1); }
console.log(`\nAll ${total}/${total} infoPagePass.test checks passed.`);
process.exit(0);
