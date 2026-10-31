// =================================================================================================
// THE TRACK CARD NAMES WHAT THE RECIPE WILL FILL THAT THE JOB HAS NO VALUE FOR (#445).
//
// The stage gate refuses with a 409 when a recipe box is bound to a blank field or an upload has no
// document on file. The card shows the same list BEFORE anyone clicks Stage (the server sends it
// as track.stageGaps — backend recipeStageGaps), each item in the portal's words with a link to
// where it is filled. Pinned in real Chromium, on the SHIPPED dashboard.html (every subresource
// blocked, so dashboard.js never runs) with the SHIPPED renderer lifted out of dashboard.js:
//
//   L  the list: one <li> per gap, the portal's label, what to fill, a link per item; nothing at all
//      when there are no gaps.
//   E  esc() everything: a hostile label is text, never an element or a handler.
//   S  rule 2: a secret gap shows only the fixed label the server sent (the card adds nothing).
//   K  the links reach the field: a document link selects that type on the upload form and focuses
//      it; a project link opens the project-data form and focuses the box; a portal-question link
//      reaches the questions row.
//   W  the production caller: trackCardHtml renders it under the next action, and
//      renderSubmittalTracks wires every link to openStageGap.
//
// Discovered from disk by scripts/run-dom-smokes.ts: `npm run portal:test:dom`.
// Alone: `npx tsx frontend/trackStageGaps.dom.smoke.ts`
// =================================================================================================
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const read = (f: string): string => fs.readFileSync(path.join(FRONTEND, f), "utf8").replace(/\r\n/g, "\n");
const dashboardJs = read("dashboard.js");
const dashboardHtml = read("dashboard.html");

let passed = 0;
const failures: string[] = [];
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { passed++; console.log(`  ok   - ${label}`); }
  else { failures.push(label); console.log(`  FAIL - ${label}${detail ? `\n         ${detail}` : ""}`); }
};

/** One top-level declaration out of the shipped dashboard.js, bracket-matched. */
function cut(kind: "function" | "const", name: string): string {
  const needle = kind === "function" ? `\nfunction ${name}(` : `\nconst ${name} = `;
  const at = dashboardJs.indexOf(needle);
  if (at < 0) throw new Error(`${name} is gone from dashboard.js — re-point this smoke`);
  const rel = dashboardJs.slice(at).search(kind === "function" ? /\)\s*\{/ : /[{[(]/);
  const openAt = at + rel + (kind === "function" ? dashboardJs.slice(at + rel).indexOf("{") : 0);
  const open = dashboardJs[openAt];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (let j = openAt; j < dashboardJs.length; j++) {
    if (dashboardJs[j] === open) depth++;
    else if (dashboardJs[j] === close && --depth === 0) return dashboardJs.slice(at + 1, j + 1) + (kind === "const" ? ";" : "");
  }
  throw new Error(`unbalanced reading ${name}`);
}
const bundle = [
  "const $ = (id) => document.getElementById(id);",
  "const state = { detail: { project: { clientId: '' } } };",
  "function openClientsModal() {} function editClient() {}",
  cut("function", "esc"),
  cut("const", "STAGE_GAP_LINK"),
  cut("function", "trackStageGapsHtml"),
  cut("const", "STAGE_GAP_PROJECT_INPUT"),
  cut("function", "openStageGap"),
].join("\n\n");

const GAPS = [
  { kind: "field", key: "homeownerEmail", label: "Owner Email", fieldName: "Homeowner email", where: "project", secret: false },
  { kind: "field", key: "installerPhone", label: "Preparer Phone", fieldName: "Installer phone", where: "client", secret: false },
  { kind: "field", key: "accountNumber", label: "Utility account number", fieldName: "Utility account number", where: "project", secret: true },
  { kind: "document", key: "utility_bill", label: "Utility Bill", fieldName: "Utility bill", where: "documents", secret: false },
  { kind: "question", key: "ownershipModel", label: "Will the System be Customer-Owned or Third-Party Owned?", fieldName: "Ownership model", where: "portal_questions", secret: false },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await ctx.newPage();
await page.route("**/*", (route: { abort(): Promise<void> }) => route.abort());
await page.setContent(dashboardHtml, { waitUntil: "domcontentloaded" });
await page.evaluate((src: string) => {
  const lib = new Function(`${src}\nreturn { trackStageGapsHtml, openStageGap };`)();
  (globalThis as unknown as { __lib: unknown }).__lib = lib;
}, bundle);

type Probe = { items: Array<{ key: string; kind: string; text: string; link: string; where: string }>; tags: string[]; html: string; title: string };
const render = (track: unknown): Promise<Probe> => page.evaluate((t: unknown) => {
  const lib = (globalThis as unknown as { __lib: { trackStageGapsHtml(t: unknown): string } }).__lib;
  const html = lib.trackStageGapsHtml(t);
  let box = document.getElementById("__gaps");
  if (!box) { box = document.createElement("div"); box.id = "__gaps"; document.body.appendChild(box); }
  box.innerHTML = html;
  return {
    html,
    items: Array.from(box.querySelectorAll("li[data-stage-gap]")).map((li) => {
      const a = li.querySelector("a[data-stage-gap-open]") as HTMLAnchorElement | null;
      return { key: (li as HTMLElement).dataset.stageGap || "", kind: (li as HTMLElement).dataset.stageGapKind || "", text: (li.textContent || "").replace(/\s+/g, " ").trim(), link: a ? (a.textContent || "").trim() : "", where: a ? a.dataset.stageGapOpen || "" : "" };
    }),
    tags: Array.from(box.querySelectorAll("*")).map((el) => el.tagName.toLowerCase()),
    title: document.title,
  };
}, track);

try {
  console.log("\n[L] the list");
  const p = await render({ type: "nem", stageGaps: GAPS });
  check("one item per gap, in the server's order", p.items.map((i) => i.key).join(",") === GAPS.map((g) => g.key).join(","), JSON.stringify(p.items));
  check("each item names the portal's box and what to fill", p.items[0].text.includes("“Owner Email”") && p.items[0].text.includes("needs Homeowner email")
    && p.items[1].text.includes("Installer phone (client record)") && p.items[3].text.includes("needs a Utility bill document"), JSON.stringify(p.items));
  check("each item carries a link to where it is filled", p.items.every((i) => i.link.length > 0)
    && p.items.map((i) => i.where).join(",") === "project,client,project,documents,portal_questions", JSON.stringify(p.items));
  check("the heading says staging will stop on these", /Fill before staging/.test(p.html) && /these 5 boxes/.test(p.html));
  const none = await render({ type: "nem", stageGaps: [] });
  const absent = await render({ type: "nem" });
  check("no gaps: nothing at all on the card", none.html === "" && absent.html === "" && none.tags.length === 0);

  console.log("\n[E] esc() everything");
  const hostile = await render({ type: `nem"><img src=x onerror="document.title='pwned'">`, stageGaps: [{ ...GAPS[0], key: `k"><img src=y>`, label: `<img src=q onerror="document.title='pwned'">`, fieldName: "<b>x</b>" }] });
  check("a hostile label, key, field name and track type stay text", !hostile.tags.includes("img") && !hostile.tags.includes("b") && hostile.title !== "pwned", JSON.stringify(hostile.tags));

  console.log("\n[S] rule 2");
  const secret = p.items.find((i) => i.key === "accountNumber")!;
  check("a secret gap shows only the fixed label the server sent", secret.text.startsWith("“Utility account number”") && !/\d{4,}/.test(secret.text), secret.text);

  console.log("\n[K] the links reach the field");
  const reach = (where: string, key: string) => page.evaluate(([w, k]: [string, string]) => {
    const lib = (globalThis as unknown as { __lib: { openStageGap(w: string, k: string): void } }).__lib;
    const a = document.querySelector(`a[data-stage-gap-open="${w}"][data-stage-gap-key="${k}"]`) as HTMLAnchorElement | null;
    if (!a) return { found: false, active: "", docType: "", detailsOpen: false };
    lib.openStageGap(a.dataset.stageGapOpen || "", a.dataset.stageGapKey || "");
    const active = document.activeElement as HTMLElement | null;
    const form = document.getElementById("manualEntryForm");
    return {
      found: true,
      active: active ? active.id || active.className : "",
      docType: (document.getElementById("docUploadType") as HTMLSelectElement | null)?.value ?? "",
      detailsOpen: Boolean(form && (form.closest("details") as HTMLDetailsElement | null)?.open),
    };
  }, [where, key] as [string, string]);
  await render({ type: "nem", stageGaps: GAPS });
  // A project is open (what selecting one does): its page and detail view are shown; the stage
  // accordions stay as shipped, collapsed — the link has to open them.
  await page.evaluate(() => { for (const id of ["pageProject", "detailView"]) { const el = document.getElementById(id); if (el) el.hidden = false; } });
  const doc = await reach("documents", "utility_bill");
  check("a document link selects that type on the upload form and focuses it", doc.found && doc.docType === "utility_bill" && doc.active === "docUploadType", JSON.stringify(doc));
  const proj = await reach("project", "homeownerEmail");
  check("a project link opens the project-data form and focuses the field's own box", proj.found && proj.detailsOpen && proj.active === "manualHomeownerEmail", JSON.stringify(proj));
  const other = await reach("project", "accountNumber");
  check("a project field with no box of its own still opens the project-data form", other.found && other.detailsOpen, JSON.stringify(other));

  console.log("\n[W] the production caller");
  const card = cut("function", "trackCardHtml");
  check("trackCardHtml renders the list under the next action", /trackNextActionText\(t\)\)\}<\/p>\s*\$\{trackStageGapsHtml\(t\)\}/.test(card));
  const wire = cut("function", "renderSubmittalTracks");
  check("renderSubmittalTracks wires every gap link to openStageGap", /a\[data-stage-gap-open\][\s\S]{0,200}openStageGap\(a\.dataset\.stageGapOpen, a\.dataset\.stageGapKey\)/.test(wire));
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
