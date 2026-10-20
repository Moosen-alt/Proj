// THE QUESTION A CONTROL ANSWERS, READ FROM REAL MARKUP (#362, Helm review of 4081f12, SF10).
//
// The submit-intent guard (gapFillMayAnswer) is only as good as the question the extractor hands
// it. A radio's own label is its option word ("Yes"); the question lives in a legend, a <th>, a
// bare span before the options (Miami's row), a <p>/<strong> above a select, an aria-labelledby
// caption, or a .control-label under a section-title legend. Each shape below is the
// "Are you ready to submit…" question in one of those places: the extractor must carry it in
// `questions` (or `groupPrompt`), so the guard refuses every member. And the same sweep that
// gates the stamped draft Submit must see a required unticked "I am ready to submit" box and an
// answerable required radio group as blanks, but not a hidden or disabled one.
//
// Real Chromium (CI installs it before this suite), page.setContent, no server, no portal.
//   npx tsx portal-bot/src/adapters/questionShapes.test.ts
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { EXTRACT_SEL, extractFieldsInPage, type RawField } from "./autoLearnAdapter";
import { gapFillMayAnswer } from "../llmGapFill";
import { sweepEmptyRequiredControls } from "../requiredControlSweep";

let failures = 0;
const check = async (label: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const READY = "Are you ready to submit your application?";
const yesNo = (name: string, extra = ""): string =>
  `<input type="radio" name="${name}" id="${name}Y" value="Yes" ${extra}><label for="${name}Y">Yes</label>
   <input type="radio" name="${name}" id="${name}N" value="No" ${extra}><label for="${name}N">No</label>`;

// Each shape holds the ready question AND an innocent neighbour, so "refuse everything" fails too.
const SHAPES: Record<string, string> = {
  tableTh: `<table><tr><th>${READY}</th><td>${yesNo("readyR")}</td></tr>
            <tr><th>Is the system grid-tied?</th><td>${yesNo("grid")}</td></tr></table>`,
  span: `<div class="row"><span>${READY}</span>${yesNo("readyR")}</div>
         <div class="row"><span>Is the system grid-tied?</span>${yesNo("grid")}</div>`,
  sectionLegend: `<fieldset><legend>Application</legend>
            <div class="form-group"><div class="control-label">${READY}</div>${yesNo("readyR")}</div>
            <div class="form-group"><div class="control-label">Is the system grid-tied?</div>${yesNo("grid")}</div></fieldset>`,
  selectAbove: `<div><p><strong>${READY}</strong></p><select id="readyS"><option>Select…</option><option>Yes</option><option>No</option></select></div>
         <div><p><strong>Mounting</strong></p><select id="mount"><option>Select…</option><option>Roof</option><option>Ground</option></select></div>`,
  selectLabelledBy: `<div id="q1">${READY}</div><select id="readyS" aria-labelledby="q1"><option>Select…</option><option>Yes</option><option>No</option></select>
         <div id="q2">Mounting</div><select id="mount" aria-labelledby="q2"><option>Select…</option><option>Roof</option><option>Ground</option></select>`,
  // Miami's markup: two radios share one id, and a dangling <label for="No"> is an option word.
  miami: `<div class="row"><span>${READY}</span>
            <input type="radio" name="readyR" id="rdo" value="Yes"><label for="Yes">Yes</label>
            <input type="radio" name="readyR" id="rdo" value="No"><label for="No">No</label></div>
          <div class="row"><span>Is the system grid-tied?</span>${yesNo("grid")}</div>`,
  // The question label sits right BEFORE the first option (no for=): it is not an option's word.
  groupLabel: `<div class="form-group"><label class="control-label">${READY}</label>${yesNo("readyR")}</div>
         <div class="form-group"><label class="control-label">Is the system grid-tied?</label>${yesNo("grid")}</div>`,
  legend: `<fieldset><legend>${READY}</legend>${yesNo("readyR")}</fieldset><fieldset><legend>Is the system grid-tied?</legend>${yesNo("grid")}</fieldset>`,
  aria: `<div role="radiogroup" aria-label="${READY}">${yesNo("readyR")}</div><div role="radiogroup" aria-label="Is the system grid-tied?">${yesNo("grid")}</div>`,
  // Round 5 (Helm review of 381204a, C5): a help / Clear button in the row is not an answer and
  // does not hide the question; a legend nested anywhere in the fieldset, for a select too; and
  // aria-describedby on the control.
  helpButtonRadios: `<div class="row"><span>${READY}</span><button type="button">?</button>${yesNo("readyR")}</div>
         <div class="row"><span>Is the system grid-tied?</span><button type="button">?</button>${yesNo("grid")}</div>`,
  helpButtonSelect: `<div class="row"><span>${READY}</span><button type="button">Clear</button><select id="readyS"><option>Select…</option><option>Yes</option><option>No</option></select></div>
         <div class="row"><span>Mounting</span><button type="button">Clear</button><select id="mount"><option>Select…</option><option>Roof</option><option>Ground</option></select></div>`,
  nestedLegendSelect: `<fieldset><div class="hd"><legend>${READY}</legend></div><select id="readyS"><option>Select…</option><option>Yes</option><option>No</option></select></fieldset>
         <fieldset><div class="hd"><legend>Mounting</legend></div><select id="mount"><option>Select…</option><option>Roof</option><option>Ground</option></select></fieldset>`,
  describedBy: `<div id="d1">${READY}</div><select id="readyS" aria-describedby="d1"><option>Select…</option><option>Yes</option><option>No</option></select>
         <div id="d2">Mounting</div><select id="mount" aria-describedby="d2"><option>Select…</option><option>Roof</option><option>Ground</option></select>`,
};

const browser = await chromium.launch();
const context = await browser.newContext();
await context.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
const page = await context.newPage();
const extract = async (html: string): Promise<RawField[]> => {
  await page.setContent(`<!doctype html><html><body><form>${html}</form></body></html>`);
  return page.$$eval(EXTRACT_SEL, extractFieldsInPage);
};
const guarded = (f: RawField): boolean => !gapFillMayAnswer({ label: f.label, groupPrompt: f.groupPrompt, options: f.options, questions: f.questions });

for (const [shape, html] of Object.entries(SHAPES)) {
  await check(`${shape}: every control of the ready question is refused; the innocent neighbour is not`, async () => {
    const raws = (await extract(html)).filter((f) => f.fieldType === "radio" || f.fieldType === "select");
    const ready = raws.filter((f) => /ready/i.test(`${f.name ?? ""} ${f.id ?? ""}`));
    const other = raws.filter((f) => !/ready/i.test(`${f.name ?? ""} ${f.id ?? ""}`));
    assert.ok(ready.length >= 1 && other.length >= 1, `extracted: ${JSON.stringify(raws.map((f) => [f.id, f.name, f.label]))}`);
    for (const f of ready) assert.ok(guarded(f), `not guarded: ${JSON.stringify({ label: f.label, groupPrompt: f.groupPrompt, questions: f.questions })}`);
    for (const f of other) assert.ok(!guarded(f), `over-guarded: ${JSON.stringify({ label: f.label, groupPrompt: f.groupPrompt, questions: f.questions })}`);
  });
}

await check("miami: an option word's dangling label is never taken as the question", async () => {
  const raws = await extract(SHAPES.miami);
  for (const f of raws.filter((x) => x.name === "readyR")) {
    assert.notEqual(f.groupPrompt, "No", JSON.stringify(f));
    assert.ok(!(f.questions ?? []).some((q) => /^(yes|no)$/i.test(q)), JSON.stringify(f.questions));
  }
});

await check("a container of prose that mentions submitting is not a question", async () => {
  const raws = await extract(`<div><p>After you have checked every page you will be able to submit your application from the review page, and the utility will contact you about the next steps within ten business days of receiving it, including any fees and inspections required.</p>
    <label for="mnt">Mounting</label><select id="mnt"><option>Roof</option><option>Ground</option></select></div>`);
  const f = raws.find((x) => x.id === "mnt");
  assert.ok(f && !guarded(f), JSON.stringify(f));
});

await check("help text after a control, and an instruction above a select with its own label, are not its question", async () => {
  const raws = await extract(`<div><label for="lic">Contractor License Number</label><input id="lic" type="text"><small>You will submit your application on the next page.</small></div>
    <div><label for="mnt">Mounting</label><select id="mnt"><option>Roof</option><option>Ground</option></select><small>Submit your application after the review page.</small></div>
    <div><p>When you are ready to submit, click Submit below.</p><label for="mnt2">Mounting</label><select id="mnt2"><option>Roof</option><option>Ground</option></select></div>
    <div><label for="txt">Notes</label><input id="txt" type="text"><script>var submitNow = "ready to submit your application";</script></div>`);
  for (const id of ["lic", "mnt", "mnt2", "txt"]) {
    const f = raws.find((x) => x.id === id);
    assert.ok(f && !guarded(f), `${id}: ${JSON.stringify(f && { label: f.label, questions: f.questions })}`);
  }
});

// ---- the sweep: what is a blank in front of the stamped draft Submit ----------------------
const blanks = async (html: string): Promise<string[]> => {
  await page.setContent(`<!doctype html><html><body><form>${html}</form></body></html>`);
  return (await sweepEmptyRequiredControls(page)).empty.map((e) => e.name);
};
await check("SF5: a required unticked 'I am ready to submit' checkbox is a blank; ticked, or optional, it is not", async () => {
  const box = (extra: string) => `<input type="checkbox" id="rdy" ${extra}><label for="rdy">I am ready to submit</label>`;
  assert.ok((await blanks(box("required"))).some((n) => /ready to submit/i.test(n)));
  assert.deepEqual(await blanks(box("required checked")), []);
  assert.deepEqual(await blanks(box("")), []);
  assert.deepEqual(await blanks(box("required disabled")), []);
  // Boxes sharing a name are one group: one ticked member answers it; unanswered, it is one blank.
  const pair = (a: string, b: string) => `<input type="checkbox" id="s1" name="svc" value="a" required ${a}><label for="s1">Solar</label><input type="checkbox" id="s2" name="svc" value="b" required ${b}><label for="s2">Storage</label>`;
  assert.deepEqual(await blanks(pair("", "checked")), []);
  assert.equal((await blanks(pair("", ""))).length, 1);
});
await check("SF3: a required radio group is a blank only when a person could answer it", async () => {
  const grp = (wrap: string, extra = "required") => `<div ${wrap}><div>Is the system grid-tied?</div>${yesNo("grid", extra)}</div>`;
  assert.ok((await blanks(grp(""))).length === 1, "an answerable required group is a blank");
  assert.deepEqual(await blanks(grp('style="display:none"')), [], "a hidden group is not");
  assert.deepEqual(await blanks(grp('style="visibility:hidden"')), [], "an invisible group is not");
  // Label-wrapped radios (the label is what renders): hidden with their group, still not a blank.
  const wrapped = (wrap: string) => `<div ${wrap}><div>Is the system grid-tied?</div>${["Yes", "No"].map((v) => `<label><input type="radio" name="gw" value="${v}" required> ${v}</label>`).join("")}</div>`;
  assert.ok((await blanks(wrapped(""))).length === 1, "an answerable label-wrapped group is a blank");
  assert.deepEqual(await blanks(wrapped('style="display:none"')), [], "a hidden label-wrapped group is not");
  assert.deepEqual(await blanks(grp("", "required disabled")), [], "a disabled group is not");
  assert.deepEqual(await blanks(`<div><div>Is the system grid-tied?</div>${yesNo("grid", "required checked")}</div>`), [], "an answered group is not");
  // main's own reasons (an asterisk) are untouched by the answerable test.
  assert.ok((await blanks(`<div><div>Is the system grid-tied? *</div>${yesNo("grid", "")}</div>`)).length === 1);
});

await browser.close();
console.log(failures === 0 ? "\nAll question-shape checks passed." : `\n${failures} question-shape check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
