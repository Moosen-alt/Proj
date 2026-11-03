// #436 FIX ROUNDS 1-3 — THE STAGED PICTURE'S MASK IS VERIFIED, IN A REAL BROWSER (secretMask.ts).
//
// The adversarial check's probe, re-run: a scriptless page (Emulation.setScriptExecutionDisabled, as
// the staged walk's page is) on 127.0.0.1, 800x600, synthetic ACCOUNT=8814402937 at fixed spots. Each
// picture is decoded and the mask colour (#FF00FF) is counted in each spot's box.
//   MUST-PASS  probe: a collapsed <select> whose chosen option shows the account (top 100), a DISABLED
//              input holding it (top 200), an OPEN declarative shadow root (top 300), a plain div
//              (top 400), a zero-width span whose text overflows its box (top 700), a listbox select
//              (top 800) and a div far below the fold (top 2500) → ok:true, and EVERY one of those
//              boxes is painted over (>= 90% mask colour where its text stands).
//   MUST-EXCL  closed: the checker's exact page (its third spot a CLOSED declarative shadow root) →
//              ok:false, named, and NO file on disk.
//   MUST-EXCL  bodyText: the account as text straight in <body> (no element to tag) → ok:false, no file.
//   MUST-EXCL  twice: a second copy beside a tagged one in the same element → ok:false, no file.
//   MUST-PASS  hidden: the account only in a hidden input and a display:none div → ok:true (nothing of
//              it is painted, so nothing needs a box).
//   THE PIXEL CHECK ITSELF: unpaintedMaskBoxes on an UNMASKED shot of the probe page reports the boxes
//              short; on the masked shot, none.
//   THE LEARNER'S TAGGER (shared): the <select> is tagged, never its <option>; clearSecretTags removes
//              every tag.
//
// Kill (each turns this red, by hand): the tagger without its <select> loop → "probe: ok:true" fails
// (the coverage check refuses the untagged select) and "tagger: the <select>s are tagged" fails; with
// the coverage check's untagged-control refusal off too → the select and listbox pixels are 0;
// maskedFullPageScreenshot screenshotting with no mask → "probe: ok:true" fails (the pixel check
// refuses); no closedShadowRootCount refusal → "closed" ok:true and a file on disk; no residual-text
// check → "bodyText" and "twice" ok:true and a file on disk.
//
// #436 FIX ROUND 2 — WHAT IS PAINTED DECIDES, AND THE PICTURE IS OF THE PAGE THAT WAS CHECKED.
//   MUST-PASS  painted (no extra CSS but the overflow spots): a <noscript>'s own text (top 100) and one
//              split across a <b> (top 200) — the walk's scriptless page paints both —, an input's
//              placeholder (top 300), a <noscript> whose text overflows its zero-width box (top 400),
//              two overflowing spans in one wrapper (top 500) → ok:true, every spot >= 90% mask colour.
//   MUST-PASS  harmless: a broken image whose alt carries nothing, ::after content that carries
//              nothing, a list item, beside a plain masked account → ok:true.
//   MUST-EXCL  imgAlt (a broken <img alt=ACCOUNT>), inputImage (<input type=image alt=ACCOUNT>), after
//              (::after{content:attr(data-acct)}), quotes (an open-quote drawing it), marker (a string
//              list-style-type) → ok:false, named, no file.
//   MUST-EXCL  THE PAGE MOVES (opts.beforeShot, between the check and the shot): reload (the same URL
//              loads again — the checker's meta-refresh race, made deterministic), reloadInto (the
//              first load shows nothing, the reload shows the account: nothing was marked, so the
//              count alone reads 0 = 0), frameReload (a shown iframe reloads), tagsGone (the same
//              document, the marked box's tags gone) → ok:false, named, no file. still: the seam
//              doing nothing → ok:true.
//
// Kill, round 2 (each run by hand against this file, then restored; the failing checks as seen):
//   the read-back's document-mark test dropped (`!st || !st.same` → `!st`) → "reloadInto" ok:true and
//     a file on disk ("reload" and "frameReload" still refused, by the count, not by name);
//   the count test dropped (`if (false)`) → "tagsGone" ok:true and a file on disk;
//   both dropped (round 1's read-back) → "reload", "reloadInto", "frameReload", "tagsGone" all ok:true
//     with a file on disk;
//   the tagger skipping NOSCRIPT again → "painted: ok:true" fails (the coverage check refuses the
//     untagged painted text); with the leftover walk skipping noscript by name too → the three
//     noscript spots read mask share 0.000;
//   textRects skipping SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE by name → the overflowing <noscript> spot
//     reads 0.000 (not measured, so the mask stayed on its zero-width box);
//   `painted` counting every climb, not distinct boxes → "painted: ok:true" fails ("5 of the 6
//     masked box(es) ... found again");
//   the tagger without the placeholder → "painted: ok:true" fails (untagged <input#ph>); with the
//     control check's placeholder off too → the placeholder spot reads 0.000;
//   no alt check → "imgAlt" and "inputImage" ok:true with a file; no generated-content check →
//     "after", "quotes", "marker" ok:true with a file; no quotes term → "quotes"; no list-style-type
//     term → "marker".
//
// #436 FIX ROUND 3 — AN <option>/<optgroup> OUTSIDE A <select> (the round-2 check's one rule-2
// regression vs origin/main). The account is drawn in pure green; nothing else on those pages is.
//   FACE 1, THE LEARNER (section 7, scripts on): main's inline withSecretMask tagger, copied verbatim
//              into this file as the oracle, against the shared tagger, on the check's five pages
//              (strayOption, listboxDivOptions, strayOptionInTable, strayOptgroupLabel,
//              strayOptionLabel), three siblings (a bare option, an option in a stray optgroup, one in
//              an open shadow root), a datalist and three controls (plain, select, input): every
//              element main tags is tagged (or its <select> is), and under the learner's own mask
//              ([data-al-secret]) the account leaves 0 green pixels (main's left 1210 / 650 / 1210 on
//              the two label pages and the shadow root, and 1162 on the select).
//   FACE 2, THE STAGED PICTURE (section 8, scriptless): those eight, plus a stray option whose own box
//              does not hold its text (width:0, text-indent:350px, display:contents on an option and
//              on an optgroup) and three split ones (two halves in two width:0 options in a 20px
//              wrapper; an option's half and a <p>'s half; an optgroup label's half and a span's) →
//              refused with no file, or kept with 0 green. All 15 are refused. MUST-PASS: a datalist's
//              option (paints nothing) beside a plain account → ok:true, 0 green.
//
// Kill, round 3 (each run by hand against secretMask.ts, then restored; the failing checks as seen,
// of 103):
//   the tagger skipping OPTION/OPTGROUP by name everywhere again → 14 fail, all section 7 (the five,
//     the bare option, the stray optgroup, the shadow root; datalist's "main tagged" check); section 8
//     still refuses all 15 (the leftover walk counts the untagged option's text as painted);
//   the tagger not reading stray labels (whole-root guard and element text) → 2: strayOptgroupLabel,
//     strayOptionLabel in section 7;
//   textRects' stray flag off → 5: strayWidth0 1210 px, strayIndent 981, strayContents 1210,
//     strayOptgroupContents 1210, splitTwoOptions 489 kept in clear (the check's five stay at 0: the
//     tagged option's own box happens to hold them there — which is why that box was NOT taken as
//     the measure);
//   the leftover walk without stray labels (SHOW_TEXT only) → 1: splitLabel 966 px;
//   the leftover walk treating a stray option's text as unpainted → 1: splitStrayP 722 px;
//   all three coverage changes off → 7 (the five above and both splits);
//   the whole round-2 secretMask.ts (633cfbc3) → 29: the 14 of section 7 and all 15 of section 8 kept
//     with the account in clear (the check's five at 1210 / 722 / 378 / 1210 / 650 px).
//
//   npx tsx portal-bot/src/secretMask.dom.smoke.ts
import "./smokeArtifactDirs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { clearSecretTags, maskedFullPageScreenshot, secretMaskPatterns, tagSecretsForMask, tagSecretsInPage, unpaintedMaskBoxes } from "./secretMask";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

// Synthetic only.
const ACCOUNT = "8814402937";
const abs = (top: number, extra = ""): string => `position:absolute;left:10px;top:${top}px;${extra}`;
const SPOTS = {
  select: `<select id="sel" style="${abs(100, "width:300px;height:40px;font-size:18px")}"><option>Choose one</option><option selected>${ACCOUNT}</option></select>`,
  disabled: `<input id="dis" disabled value="${ACCOUNT}" style="${abs(200, "width:300px;height:40px;font-size:18px")}">`,
  open: `<div id="openhost" style="${abs(300, "width:400px;height:40px")}"><template shadowrootmode="open"><p style="margin:0;font-size:20px">Open ${ACCOUNT}</p></template></div>`,
  closed: `<div id="closedhost" style="${abs(300, "width:400px;height:40px")}"><template shadowrootmode="closed"><p style="margin:0;font-size:20px">Closed ${ACCOUNT}</p></template></div>`,
  plain: `<div id="plain" style="${abs(400, "width:400px;height:40px;font-size:20px")}">Account ${ACCOUNT}</div>`,
  overflow: `<div id="ovf" style="${abs(700, "width:400px;height:40px")}"><span id="ovfspan" style="display:inline-block;width:0;height:24px;white-space:nowrap;font-size:20px">Acct ${ACCOUNT}</span></div>`,
  listbox: `<select id="lb" size="3" style="${abs(800, "width:300px;height:80px;font-size:16px")}"><option>One</option><option>${ACCOUNT}</option><option>Three</option></select>`,
  below: `<div id="below" style="${abs(2500, "width:400px;height:40px;font-size:20px")}">Far below ${ACCOUNT}</div>`,
};
const doc = (body: string, tall = true): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Review</title></head><body style="margin:0;${tall ? "height:2700px;" : ""}position:relative"><h1 style="margin:0;font-size:20px">Review and Submit</h1>${body}</body></html>`;
const PAGES: Record<string, string> = {
  probe: doc([SPOTS.select, SPOTS.disabled, SPOTS.open, SPOTS.plain, SPOTS.overflow, SPOTS.listbox, SPOTS.below].join("")),
  // The checker's exact shape: select, disabled input, CLOSED shadow root, plain div.
  closed: doc([SPOTS.select, SPOTS.disabled, SPOTS.closed, SPOTS.plain].join(""), false),
  bodyText: `<!doctype html><html><head><title>Review</title></head><body>Account ${ACCOUNT}</body></html>`,
  twice: doc(`<div id="t" style="${abs(100, "font-size:20px")}">${ACCOUNT} <b>${ACCOUNT}</b></div>`, false),
  hidden: doc(`<input type="hidden" name="acct" value="${ACCOUNT}"><div style="display:none">Account ${ACCOUNT}</div><p style="${abs(100)}">Nothing of it shows.</p>`, false),
  // #436 FIX ROUND 2 — painted, never tagged: the checker's shapes, no extra CSS (a scriptless page
  // paints a <noscript>'s content by itself).
  painted: doc([
    `<div id="ns1" style="${abs(100, "font-size:20px")}"><noscript>Account ${ACCOUNT}</noscript></div>`,
    `<div id="ns2" style="${abs(200, "font-size:20px")}"><noscript>Account 8814<b>402937</b></noscript></div>`,
    `<input id="ph" placeholder="${ACCOUNT}" style="${abs(300, "width:300px;height:40px;font-size:18px")}">`,
    // A <noscript> whose own text overflows its zero-width box: it must be MEASURED (its text rects),
    // so the mask climbs to the wrapper that holds it.
    `<div id="ns3" style="${abs(400, "width:400px;height:40px")}"><noscript style="display:inline-block;width:0;height:24px;white-space:nowrap;font-size:20px">Acct ${ACCOUNT}</noscript></div>`,
    // Two tagged spans whose text overflows climb to ONE wrapper: one box to paint, not two.
    `<div id="dup" style="${abs(500, "width:400px;height:60px")}"><span style="display:inline-block;width:0;height:24px;white-space:nowrap;font-size:20px">One ${ACCOUNT}</span><br><span style="display:inline-block;width:0;height:24px;white-space:nowrap;font-size:20px">Two ${ACCOUNT}</span></div>`,
  ].join(""), false),
  imgAlt: doc(`<img alt="${ACCOUNT}" src="/missing.png" style="${abs(100, "font-size:20px")}">`, false),
  inputImage: doc(`<input type="image" alt="${ACCOUNT}" src="/missing.png" style="${abs(100, "width:300px;height:40px;font-size:18px")}">`, false),
  after: `<!doctype html><html><head><title>Review</title><style>#x::after{content:attr(data-acct)}</style></head><body><div id="x" data-acct="${ACCOUNT}"></div></body></html>`,
  quotes: `<!doctype html><html><head><title>Review</title><style>#q{quotes:"${ACCOUNT}" ""}#q::before{content:open-quote}</style></head><body><div id="q">on file</div></body></html>`,
  marker: `<!doctype html><html><head><title>Review</title><style>li{list-style-type:"${ACCOUNT} "}</style></head><body><ul><li>on file</li></ul></body></html>`,
  // A broken image whose alt carries nothing and generated content that carries nothing, beside a
  // plain masked account: not refused (the checks read what is painted, not the tag).
  harmless: `<!doctype html><html><head><title>Review</title><style>#h::after{content:"Review"}</style></head><body><div id="h">x</div><img alt="Logo" src="/missing.png"><ul><li>one</li></ul><p>Account ${ACCOUNT}</p></body></html>`,
  // THE PAGE MOVES UNDER THE PICTURE: reloaded between the check and the shot (opts.beforeShot).
  reload: doc(`<div id="r" style="${abs(100, "width:400px;height:40px;font-size:20px")}">Account ${ACCOUNT}</div>`, false),
  frameReload: doc(`<iframe id="fr" src="/frameDoc" style="${abs(100, "width:500px;height:100px;border:0")}"></iframe>`, false),
  frameDoc: `<!doctype html><html><body style="margin:0"><p style="margin:0;font-size:20px">Account ${ACCOUNT}</p></body></html>`,
};
// #436 FIX ROUND 3 — an <option>/<optgroup> OUTSIDE a <select>. The account is drawn in pure green and
// nothing else on these pages is green, so the green pixels in a picture are the account in clear.
const GREEN = "color:rgb(0,200,0);font-weight:bold;font-size:28px";
const stray = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Review</title></head><body style="margin:0"><h1 style="margin:0;font-size:20px">Review and Submit</h1>${body}</body></html>`;
const NOWRAP0 = `${GREEN};width:0;padding:0;white-space:nowrap`;
const STRAY: Record<string, string> = {
  // The round-2 check's five, as it ran them (but the listbox's green on the account's option alone,
  // so its "One" is not counted as the account).
  strayOption: stray(`<div><option style="${GREEN}">Account ${ACCOUNT}</option></div>`),
  listboxDivOptions: stray(`<div role="listbox" style="font-size:28px"><option>One</option><option aria-selected="true" style="${GREEN}">${ACCOUNT}</option></div>`),
  strayOptionInTable: stray(`<table><tr><th>Account</th><td style="${GREEN}"><option selected>${ACCOUNT}</option></td></tr></table>`),
  strayOptgroupLabel: stray(`<div style="${GREEN}"><optgroup label="Account ${ACCOUNT}"></optgroup></div>`),
  strayOptionLabel: stray(`<div style="${GREEN}"><option label="Account ${ACCOUNT}">x</option></div>`),
  // Its siblings in the learner's tag-set diff.
  strayOptionBare: stray(`<div style="${GREEN}"><option>Account ${ACCOUNT}</option></div>`),
  strayOptgroup: stray(`<div><optgroup style="${GREEN}"><option>Account ${ACCOUNT}</option></optgroup></div>`),
  // The option's OWN box does not hold what it paints: a 0-wide box with the text drawn past it, the
  // text pushed off the box by text-indent, and no box at all (display:contents).
  strayWidth0: stray(`<div><option style="${NOWRAP0}">Account ${ACCOUNT}</option></div>`),
  strayIndent: stray(`<div style="width:300px"><option style="${GREEN};text-indent:350px;white-space:nowrap">Acct ${ACCOUNT}</option></div>`),
  strayContents: stray(`<div><option style="${GREEN};display:contents">Account ${ACCOUNT}</option></div>`),
  strayOptgroupContents: stray(`<div style="${GREEN}"><optgroup style="display:contents" label="Account ${ACCOUNT}"></optgroup></div>`),
  // Split: no option holds the whole number. The tagger tags the narrow wrapper; both halves are
  // drawn past it.
  splitTwoOptions: stray(`<div style="width:20px"><option style="${NOWRAP0}">8814</option><option style="${NOWRAP0}">402937</option></div>`),
  // Split across blocks, nothing tagged: the option's half has no text rects, its label none at all.
  splitStrayP: stray(`<p><option style="${GREEN}">8814</option></p><p style="${GREEN}">402937</p>`),
  splitLabel: stray(`<div><optgroup style="${GREEN}" label="Acct 8814"></optgroup><span style="${GREEN}">402937</span></div>`),
  // MUST-PASS: a datalist's option paints nothing (the datalist is display:none), beside a plain
  // masked account.
  datalist: stray(`<input list="dl" style="width:200px"><datalist id="dl"><option>${ACCOUNT}</option></datalist><div style="${GREEN}">Account ${ACCOUNT}</div>`),
  // Controls for the learner's tag-set diff.
  plainGreen: stray(`<div style="${GREEN}">Account ${ACCOUNT}</div>`),
  selectChosen: stray(`<select style="${GREEN};width:320px;height:44px"><option>Choose</option><option selected>${ACCOUNT}</option></select>`),
  inputVal: stray(`<input value="${ACCOUNT}" style="${GREEN};width:320px;height:44px">`),
  shadowStray: stray(`<div><template shadowrootmode="open"><option style="${GREEN}">Account ${ACCOUNT}</option></template></div>`),
};
Object.assign(PAGES, STRAY);
// #436 ROUND 4 — THE CHECKER'S r4 CORPUS, the deterministic subset it flagged (wl-scratch r4/corpus.mts
// and r4/strayChild2.mts, their markup exactly): the three <select> carriers whose secret no single
// option holds (text straight in an <optgroup>; two options' halves; two rich options' halves) under
// all ten wrappers, the five strayChild2 pages bare and in an open shadow root, and three plain
// select controls bare and in a shadow root. All the account's ink is pure green, inside the select.
const R4G = "color:rgb(0,200,0);font-weight:bold;font-size:24px";
const R4LB = "width:340px;height:150px";
const R4SZ = "width:340px;height:44px";
const R4_WRAP: Record<string, (c: string) => string> = {
  bare: (c) => c,
  div: (c) => `<div class="row"><span>Info</span> ${c}</div>`,
  td: (c) => `<table><tr><th>Account</th><td>${c}</td></tr></table>`,
  li: (c) => `<ul><li>${c}</li></ul>`,
  fieldset: (c) => `<form><fieldset><legend>Info</legend>${c}</fieldset></form>`,
  label: (c) => `<label>Acct: ${c}</label>`,
  listboxDiv: (c) => `<div role="listbox">${c}</div>`,
  shadow: (c) => `<div><template shadowrootmode="open">${c}</template></div>`,
  dd: (c) => `<dl><dt>Account</dt><dd>${c}</dd></dl>`,
  section2: (c) => `<section><h3>Summary</h3><div><div>${c}</div></div></section>`,
};
const R4_CARRY: Record<string, string> = {
  selOptgroupText: `<select size="4" style="${R4G};${R4LB}"><optgroup label="Accounts">Acct ${ACCOUNT}<option>x</option></optgroup></select>`,
  selOptgroupSplit: `<select size="4" style="${R4G};${R4LB}"><optgroup label="Accounts"><option>8814</option><option>402937</option></optgroup></select>`,
  selOptgroupRichSplit: `<select size="4" style="${R4G};${R4LB}"><optgroup label="A"><option><b>8814</b></option><option><b>402937</b></option></optgroup></select>`,
};
const R4_CONTROL: Record<string, string> = {
  selCollapsed: `<select style="${R4G};${R4SZ}"><option>Choose</option><option selected>${ACCOUNT}</option></select>`,
  selListbox: `<select size="4" style="${R4G};${R4LB}"><option>Choose</option><option>${ACCOUNT}</option></select>`,
  selMultiple: `<select multiple style="${R4G};${R4LB}"><option>Choose</option><option selected>Acct ${ACCOUNT}</option></select>`,
};
const R4G28 = "color:rgb(0,200,0);font-weight:bold;font-size:28px";
const R4_STRAYCHILD2: Record<string, string> = {
  ogTextListbox: `<select size="5" style="${R4G28};width:320px;height:150px"><optgroup label="Accounts">Account ${ACCOUNT}<option>x</option></optgroup></select>`,
  ogTextMultiple: `<select multiple name="acct" style="${R4G28};width:360px;height:150px"><optgroup label="Service accounts">Acct: 88-1440-2937<option>Residential</option></optgroup></select>`,
  ogTextCollapsed: `<select style="${R4G28};width:320px;height:44px"><optgroup label="Accounts">Account ${ACCOUNT}<option>x</option></optgroup></select>`,
  ogSplitMultiple: `<select multiple style="${R4G28};width:320px;height:150px"><optgroup label="Accounts"><option>8814</option><option>402937</option></optgroup></select>`,
  ogTextInForm: `<form><label>Account <select size="4" style="${R4G28};width:360px;height:150px"><optgroup label="On file">${ACCOUNT}<option selected>Use this account</option></optgroup></select></label></form>`,
};
const r4Doc = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Review</title></head><body style="margin:0"><h1 style="margin:0;font-size:18px">Review and Submit</h1>${body}<p>end</p></body></html>`;
const r4Short = (body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Review</title></head><body style="margin:0"><h1 style="margin:0;font-size:20px">Review and Submit</h1>${body}</body></html>`;
const R4: string[] = [];
for (const [wn, w] of Object.entries(R4_WRAP)) for (const [cn, c] of Object.entries(R4_CARRY)) { PAGES[`r4-${wn}__${cn}`] = r4Doc(w(c)); R4.push(`r4-${wn}__${cn}`); }
for (const [n, body] of Object.entries(R4_STRAYCHILD2)) {
  PAGES[`r4-${n}`] = r4Short(body); R4.push(`r4-${n}`);
  PAGES[`r4-shadow__${n}`] = r4Short(R4_WRAP.shadow(body)); R4.push(`r4-shadow__${n}`);
}
for (const [n, c] of Object.entries(R4_CONTROL)) for (const wn of ["bare", "shadow"]) { PAGES[`r4-${wn}__${n}`] = r4Doc(R4_WRAP[wn](c)); R4.push(`r4-${wn}__${n}`); }
/** MAIN'S LEARNER TAGGER (origin/main d07388da, autoLearnAdapter.ts withSecretMask's inline body),
 *  copied verbatim from the diff's removed lines: the oracle the shared tagger must cover. */
const mainTagger = (ps: Array<{ digits: string; literal: string }>): number => {
  let n = 0;
  // A box holding one (typed here, or pre-filled by the portal).
  for (const el of Array.from(document.querySelectorAll("input, textarea"))) {
    const v = String((el as HTMLInputElement).value || "");
    if (!v) continue;
    const vd = v.replace(/\D/g, "");
    const vl = v.toLowerCase();
    for (const p of ps) {
      if ((p.digits && vd.indexOf(p.digits) >= 0) || (p.literal && vl.indexOf(p.literal) >= 0)) { el.setAttribute("data-al-secret", "1"); n++; break; }
    }
  }
  // Text rendering one (a review page's "Account: 7734009155"). Most pages carry none, so
  // the whole-body check keeps the element walk off the common path.
  const bt = String(document.body ? document.body.textContent || "" : "");
  const btd = bt.replace(/\D/g, "");
  const btl = bt.toLowerCase();
  let textHas = false;
  for (const p of ps) {
    if ((p.digits && btd.indexOf(p.digits) >= 0) || (p.literal && btl.indexOf(p.literal) >= 0)) { textHas = true; break; }
  }
  if (!textHas) return n;
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "INPUT" || tag === "TEXTAREA") continue;
    const text = String(el.textContent || "");
    if (!text) continue;
    const td = text.replace(/\D/g, "");
    const tl = text.toLowerCase();
    let hit = false;
    for (const p of ps) {
      if ((p.digits && td.indexOf(p.digits) >= 0) || (p.literal && tl.indexOf(p.literal) >= 0)) { hit = true; break; }
    }
    if (!hit) continue;
    // The SMALLEST element carrying the whole secret: skip an ancestor when a child element
    // carries it too (masking <body> would blank the whole picture).
    let childCarries = false;
    for (const c of Array.from(el.children)) {
      const ct = String(c.textContent || "");
      const cd = ct.replace(/\D/g, "");
      const cl = ct.toLowerCase();
      for (const p of ps) {
        if ((p.digits && cd.indexOf(p.digits) >= 0) || (p.literal && cl.indexOf(p.literal) >= 0)) { childCarries = true; break; }
      }
      if (childCarries) break;
    }
    if (childCarries) continue;
    el.setAttribute("data-al-secret", "1");
    n++;
  }
  return n;
};
/** Number every element, open shadow roots included, so two tag sets compare by element (round 4).
 *  Plain loops only: no shim is evaluated before the shipped tagging runs. */
const r4Index = (): number => {
  let i = 0;
  const roots: Array<Document | ShadowRoot> = [document];
  for (let r = 0; r < roots.length; r++) {
    for (const el of Array.from(roots[r].querySelectorAll("*"))) {
      el.setAttribute("data-ix", String(i++));
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) roots.push(sr);
    }
  }
  return i;
};
/** The tagged elements, as "index:TAG", open shadow roots included. */
const r4Tags = (): string[] => {
  const out: string[] = [];
  const roots: Array<Document | ShadowRoot> = [document];
  for (let r = 0; r < roots.length; r++) {
    for (const el of Array.from(roots[r].querySelectorAll("*"))) {
      if (el.hasAttribute("data-al-secret")) out.push(`${el.getAttribute("data-ix")}:${el.tagName}`);
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) roots.push(sr);
    }
  }
  return out;
};
/** Served without the account on its first load, with it on every load after: a page that reloads
 *  itself INTO showing one. Nothing was marked before the shot, so only the document mark can tell. */
const RELOAD_INTO = {
  before: doc(`<div style="${abs(100, "font-size:20px")}">Nothing on file yet</div>`, false),
  after: doc(`<div style="${abs(100, "font-size:20px")}">Account ${ACCOUNT}</div>`, false),
};
let reloadIntoHits = 0;

const server = http.createServer((req, res) => {
  const name = String(req.url || "/").replace(/^\/+/, "").split("?")[0];
  const html = name === "reloadInto" ? (reloadIntoHits++ === 0 ? RELOAD_INTO.before : RELOAD_INTO.after) : PAGES[name];
  res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(html ?? "<h1>Not found</h1>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autopilot-test-secretmask-"));

const browser = await chromium.launch({ headless: true });
/** A page as the staged walk opens one: no page script ever runs on it. */
const scriptless = async (name: string): Promise<Page> => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const pg = await ctx.newPage();
  const cdp = await ctx.newCDPSession(pg);
  await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
  await pg.goto(`${base}/${name}`);
  return pg;
};
/** The share of mask-colour pixels in a box of the picture (CSS pixels; the shot is scale "css"). */
const maskShare = async (file: string, b: { x: number; y: number; w: number; h: number }): Promise<number> => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(fs.readFileSync(file));
  const cv = createCanvas(img.width, img.height);
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] >= 240 && d[i + 1] <= 20 && d[i + 2] >= 240) n++;
  return n / (d.length / 4);
};
/** How many pixels of a picture are the account's green (the round-3 pages draw nothing else green). */
const greenPixels = async (png: Buffer): Promise<number> => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(png);
  const cv = createCanvas(img.width, img.height);
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 70 && d[i + 1] > 150 && d[i + 2] < 70) n++;
  return n;
};
/** A page as the learner sees one: its scripts run. */
const scripted = async (name: string): Promise<Page> => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const pg = await ctx.newPage();
  await pg.goto(`${base}/${name}`);
  return pg;
};

try {
  console.log("\n1. MUST-PASS: the probe page — every spot that shows the account is painted over");
  {
    const pg = await scriptless("probe");
    const file = path.join(dir, "probe.png");
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    check("probe: ok:true and the picture is on disk", m.ok && fs.existsSync(file), JSON.stringify(m));
    if (m.ok && fs.existsSync(file)) {
      // Inside each spot, a little in from its edges (where its text stands).
      const spots: Array<[string, { x: number; y: number; w: number; h: number }]> = [
        ["the collapsed <select> showing the chosen account", { x: 14, y: 104, w: 290, h: 32 }],
        ["the DISABLED input holding it", { x: 14, y: 204, w: 290, h: 32 }],
        ["the OPEN shadow root's text", { x: 14, y: 302, w: 120, h: 18 }],
        ["the plain div", { x: 14, y: 404, w: 200, h: 18 }],
        ["the zero-width span's overflowing text", { x: 14, y: 702, w: 140, h: 18 }],
        ["the listbox select", { x: 14, y: 804, w: 290, h: 72 }],
        ["the div far below the fold (y 2500)", { x: 14, y: 2504, w: 200, h: 18 }],
      ];
      for (const [label, box] of spots) {
        const share = await maskShare(file, box);
        check(`probe: ${label} is masked`, share >= 0.9, `mask share=${share.toFixed(3)} box=${JSON.stringify(box)}`);
      }
      // The heading (no secret) is not masked.
      const heading = await maskShare(file, { x: 2, y: 2, w: 150, h: 16 });
      check("probe: the heading (no secret) is not masked", heading < 0.05, `mask share=${heading.toFixed(3)}`);
    }
    const left = await pg.evaluate(() => document.querySelectorAll("[data-al-secret], [data-al-secret-check], [data-al-secret-doc]").length);
    check("probe: every tag is cleared afterwards", left === 0, `left=${left}`);
    // THE PIXEL CHECK ITSELF: an UNMASKED picture of the same page reads as short.
    const plainFile = path.join(dir, "probe-unmasked.png");
    await pg.screenshot({ path: plainFile, fullPage: true, scale: "css" });
    const short = await unpaintedMaskBoxes(plainFile, [{ x: 10, y: 400, width: 400, height: 40 }, { x: 10, y: 2500, width: 400, height: 40 }]);
    check("pixel check: an unmasked picture's boxes read as NOT painted over (2 of 2)", short === 2, `short=${short}`);
    if (m.ok && fs.existsSync(file)) {
      const none = await unpaintedMaskBoxes(file, [{ x: 10, y: 400, width: 400, height: 40 }, { x: 10, y: 2500, width: 400, height: 40 }]);
      check("pixel check: the masked picture's boxes read as painted over (0 short)", none === 0, `short=${none}`);
    }
    // THE LEARNER'S TAGGER (shared): the select, never its option.
    const n = await tagSecretsInPage(pg, secretMaskPatterns([ACCOUNT]));
    const t = await pg.evaluate(() => ({
      sel: document.getElementById("sel")!.hasAttribute("data-al-secret"),
      lb: document.getElementById("lb")!.hasAttribute("data-al-secret"),
      options: document.querySelectorAll("option[data-al-secret]").length,
    }));
    check("tagger: the <select>s are tagged, no <option> is", n > 0 && t.sel && t.lb && t.options === 0, JSON.stringify({ n, ...t }));
    await clearSecretTags(pg);
    check("tagger: clearSecretTags removes every tag", await pg.evaluate(() => document.querySelectorAll("[data-al-secret]").length) === 0);
    await pg.context().close();
  }

  console.log("\n2. MUST-EXCLUDE: a page the mask cannot cover gives no picture at all");
  const refused = async (name: string, want: RegExp): Promise<void> => {
    const pg = await scriptless(name);
    const file = path.join(dir, `${name}.png`);
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    check(`${name}: ok:false, named`, !m.ok && want.test(m.why), JSON.stringify(m));
    check(`${name}: no picture on disk`, !fs.existsSync(file), file);
    await pg.context().close();
  };
  await refused("closed", /closed shadow root/);
  await refused("bodyText", /no element could be tagged/);
  await refused("twice", /no element could be tagged/);

  console.log("\n3. MUST-PASS: a secret that paints nothing needs no box");
  {
    const pg = await scriptless("hidden");
    const file = path.join(dir, "hidden.png");
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    check("hidden: ok:true (a hidden input and a display:none div paint nothing)", m.ok && fs.existsSync(file), JSON.stringify(m));
    const none = await maskedFullPageScreenshot(pg, [], path.join(dir, "nosecret.png"));
    check("no secret known: a plain picture, ok:true", none.ok && fs.existsSync(path.join(dir, "nosecret.png")), JSON.stringify(none));
    await pg.context().close();
  }

  console.log("\n4. MUST-PASS (fix round 2): what a scriptless page paints is masked, whatever its tag");
  {
    const pg = await scriptless("painted");
    const file = path.join(dir, "painted.png");
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    check("painted: ok:true and the picture is on disk", m.ok && fs.existsSync(file), JSON.stringify(m));
    if (m.ok && fs.existsSync(file)) {
      const spots: Array<[string, { x: number; y: number; w: number; h: number }]> = [
        ["a <noscript>'s own text (the walk's scriptless page paints it)", { x: 14, y: 104, w: 120, h: 14 }],
        ["a <noscript> whose account is split across a <b>", { x: 14, y: 204, w: 120, h: 14 }],
        ["an input's placeholder", { x: 14, y: 304, w: 290, h: 32 }],
        ["a <noscript>'s text overflowing its zero-width box", { x: 14, y: 402, w: 140, h: 18 }],
        ["two overflowing spans in one wrapper", { x: 14, y: 502, w: 140, h: 44 }],
      ];
      for (const [label, box] of spots) {
        const share = await maskShare(file, box);
        check(`painted: ${label} is masked`, share >= 0.9, `mask share=${share.toFixed(3)} box=${JSON.stringify(box)}`);
      }
    }
    await pg.context().close();
  }
  {
    const pg = await scriptless("harmless");
    const file = path.join(dir, "harmless.png");
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    check("harmless: an alt and generated content that carry nothing are not refused", m.ok && fs.existsSync(file), JSON.stringify(m));
    await pg.context().close();
  }

  console.log("\n5. MUST-EXCLUDE (fix round 2): text painted with no text node to measure gives no picture");
  await refused("imgAlt", /alt text carries a known secret/);
  await refused("inputImage", /alt text carries a known secret/);
  await refused("after", /generated content carries a known secret/);
  await refused("quotes", /generated content carries a known secret/);
  await refused("marker", /generated content carries a known secret/);

  console.log("\n6. MUST-EXCLUDE (fix round 2): a page that moves between the check and the shot gives no picture");
  const moved = async (label: string, name: string, before: (pg: Page) => Promise<void>, want: RegExp): Promise<void> => {
    const pg = await scriptless(name);
    const file = path.join(dir, `${label}.png`);
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file, { beforeShot: () => before(pg) });
    check(`${label}: ok:false, named`, !m.ok && want.test(m.why), JSON.stringify(m));
    check(`${label}: no picture on disk`, !fs.existsSync(file), file);
    await pg.context().close();
  };
  // The checker's race, made deterministic: the same URL loads again, so a new document with nothing
  // tagged is what the shot sees.
  await moved("reload", "reload", async (pg) => { await pg.goto(`${base}/reload`); }, /page changed/);
  // Nothing was marked before the shot (painted 0), and the reload shows the account: the count alone
  // (0 = 0) cannot tell; the document mark does.
  await moved("reloadInto", "reloadInto", async (pg) => { await pg.goto(`${base}/reloadInto`); }, /page changed/);
  // A shown frame reloads itself.
  await moved("frameReload", "frameReload", async (pg) => {
    const fr = pg.frames().find((f) => f !== pg.mainFrame());
    if (!fr) throw new Error("no child frame");
    await fr.goto(`${base}/frameDoc`);
  }, /page changed/);
  // The same document, but the marked box is no longer found (its tags gone, as when the element is
  // swapped for a copy): the document mark holds, so only the count can tell.
  await moved("tagsGone", "reload", async (pg) => {
    await pg.evaluate(() => { for (const el of Array.from(document.querySelectorAll("[data-al-secret], [data-al-secret-check]"))) { el.removeAttribute("data-al-secret"); el.removeAttribute("data-al-secret-check"); } });
  }, /0 of the 1 masked box\(es\) the check marked were found again/);
  {
    // The control: the same seam doing nothing keeps the picture.
    const pg = await scriptless("reload");
    const file = path.join(dir, "still.png");
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file, { beforeShot: async () => {} });
    check("still: a page that does not move keeps its picture, ok:true", m.ok && fs.existsSync(file), JSON.stringify(m));
    await pg.context().close();
  }

  console.log("\n7. FACE 1 (fix round 3): the learner's tagger covers every element main's tagged, and its mask leaves no green");
  {
    const pats = secretMaskPatterns([ACCOUNT]);
    for (const name of ["strayOption", "listboxDivOptions", "strayOptionInTable", "strayOptgroupLabel", "strayOptionLabel", "strayOptionBare", "strayOptgroup", "shadowStray", "datalist", "plainGreen", "selectChosen", "inputVal"]) {
      const pg = await scripted(name);
      await pg.evaluate("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
      const raw = await greenPixels(await pg.screenshot());
      // Main's tagger, then the learner's own mask over what it tagged (withSecretMask's locator).
      const nMain = await pg.evaluate(mainTagger, pats);
      const gMain = await greenPixels(await pg.screenshot(nMain > 0 ? { mask: [pg.locator("[data-al-secret]")] } : {}));
      const mainTags = await pg.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll("[data-al-secret]"))) { el.removeAttribute("data-al-secret"); el.setAttribute("data-main-tag", "1"); out.push(el.tagName); }
        return out;
      });
      // The learner's own tagging (round 4: the union — main's pass, then the shared tagger).
      const u = await tagSecretsForMask(pg, pats);
      const gBranch = await greenPixels(await pg.screenshot(u.tagged ? { mask: [pg.locator("[data-al-secret]")] } : {}));
      const branchTags = await pg.locator("[data-al-secret]").evaluateAll((els) => els.map((e) => e.tagName));
      // Round 4: STRICT — every element main tagged is tagged itself (no "or its <select> is").
      const missed = await pg.evaluate(() => Array.from(document.querySelectorAll("[data-main-tag]"))
        .filter((el) => !el.hasAttribute("data-al-secret"))
        .map((el) => el.tagName));
      const seen = JSON.stringify({ mainTags, branchTags, missed, raw, gMain, gBranch });
      check(`${name}: every element main's learner tagger tagged is tagged`, missed.length === 0, seen);
      check(`${name}: the account shows unmasked, and the learner's mask leaves none of it (main's left ${gMain} px)`, raw > 30 && gBranch === 0 && gBranch <= gMain, seen);
      await clearSecretTags(pg);
      await pg.context().close();
    }
  }

  console.log("\n8. FACE 2 (fix round 3): a staged picture of a page painting the account in an <option>/<optgroup> outside a <select> is refused, or keeps none of it");
  for (const name of ["strayOption", "listboxDivOptions", "strayOptionInTable", "strayOptgroupLabel", "strayOptionLabel", "strayOptionBare", "strayOptgroup", "shadowStray",
    "strayWidth0", "strayIndent", "strayContents", "strayOptgroupContents", "splitTwoOptions", "splitStrayP", "splitLabel"]) {
    const pg = await scriptless(name);
    const raw = await greenPixels(await pg.screenshot({ fullPage: true, scale: "css" }));
    const file = path.join(dir, `r3-${name}.png`);
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    const kept = fs.existsSync(file);
    const green = kept ? await greenPixels(fs.readFileSync(file)) : 0;
    const seen = JSON.stringify({ ...m, kept, raw, green });
    check(`${name}: the page shows the account unmasked`, raw > 30, seen);
    check(`${name}: ${m.ok ? `kept, with ${green} px of the account in clear` : `refused (${m.why.replace(/^the secret mask cannot cover the page \(|\), so no picture was taken$/g, "").slice(0, 110)})`} — refused with no picture on disk, or kept with none of it`, (!m.ok && !kept) || (m.ok && kept && green === 0), seen);
    await pg.context().close();
  }
  {
    // MUST-PASS: a datalist's option paints nothing, so it neither refuses nor needs a box.
    const pg = await scriptless("datalist");
    const file = path.join(dir, "r3-datalist.png");
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    const green = fs.existsSync(file) ? await greenPixels(fs.readFileSync(file)) : -1;
    check("datalist: an option in a <datalist> paints nothing — ok:true, the plain account masked", m.ok && green === 0, JSON.stringify({ ...m, green }));
    await pg.context().close();
  }

  console.log(`\n9. FACE 1 (round 4): on the checker's r4 corpus (${R4.length} pages) the learner's tagging is a superset of main's, and its mask leaves no green`);
  {
    const pats = secretMaskPatterns([ACCOUNT]);
    for (const name of R4) {
      const pg = await scripted(name);
      await pg.evaluate(r4Index);
      const raw = await greenPixels(await pg.screenshot());
      // The SHIPPED path first (what withSecretMask runs), on a page where no shim was evaluated.
      const u = await tagSecretsForMask(pg, pats);
      const unionTags = await pg.evaluate(r4Tags);
      const gUnion = await greenPixels(await pg.screenshot(u.tagged ? { mask: [pg.locator("[data-al-secret]")] } : {}));
      await clearSecretTags(pg);
      const left = await pg.evaluate(r4Tags);
      // Then main's tagger (the oracle copied above) on the same page, under main's own mask.
      const nMain = await pg.evaluate(mainTagger, pats);
      const mainTags = await pg.evaluate(r4Tags);
      const gMain = await greenPixels(await pg.screenshot(nMain > 0 ? { mask: [pg.locator("[data-al-secret]")] } : {}));
      await clearSecretTags(pg);
      const missed = mainTags.filter((t) => !unionTags.includes(t));
      const seen = JSON.stringify({ ok: u.ok, mainTags, unionTags, missed, raw, gMain, gUnion });
      check(`${name}: both passes ran, and one clear removed every tag`, u.ok && left.length === 0, seen);
      check(`${name}: tags(learner) ⊇ tags(main) — every element main tags is tagged itself`, missed.length === 0, seen);
      check(`${name}: the account shows (${raw} px) and the learner's mask leaves 0 of it (main's left ${gMain})`, raw > 30 && gUnion === 0, seen);
      await pg.context().close();
    }
  }

  console.log(`\n10. FACE 2 (round 4): the staged picture of every r4 page is KEPT with the select masked whole, none of the account in clear`);
  for (const name of R4) {
    const pg = await scriptless(name);
    const raw = await greenPixels(await pg.screenshot({ fullPage: true, scale: "css" }));
    const file = path.join(dir, `${name}.png`);
    const m = await maskedFullPageScreenshot(pg, [ACCOUNT], file);
    const kept = fs.existsSync(file);
    const green = kept ? await greenPixels(fs.readFileSync(file)) : -1;
    const seen = JSON.stringify({ ...m, kept, raw, green });
    check(`${name}: the page shows the account unmasked (${raw} px)`, raw > 30, seen);
    check(`${name}: refused with no picture on disk, or kept with none of the account`, (!m.ok && !kept) || (m.ok && kept && green === 0), seen);
    // Stricter (round 4): a select whose text carries the account is tagged whole, so the picture is
    // KEPT, masked. A refusal here would be the coverage check's backstop hiding a tagger miss.
    check(`${name}: kept (ok:true, on disk) with 0 px of the account in clear`, m.ok && kept && green === 0, seen);
    await pg.context().close();
  }
} finally {
  await browser.close().catch(() => null);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? `\nAll ${total}/${total} secretMask checks passed.` : `\n${failures}/${total} secretMask check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
