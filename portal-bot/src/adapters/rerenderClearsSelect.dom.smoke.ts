// A REQUIRED SELECT ON A PAGE WHOSE CONTACT PICKER RE-RENDERS IT IS FILLED, OR SAYS WHY NOT (#530).
//
// Live on PacifiCorp's PowerClerk NEM learn (2026-11-02), "Generation System Owner Information":
// the walk answered "Existing contact to use for this contact" → New Contact, the block re-rendered
// (selectors_refreshed_after_rerender), and the required "Will the System be Customer-Owned or
// Third-Party Owned?" then read fills_did_not_hold + required_never_filled. The trust gate refused
// the recipe. This page has the same shape: a contact-source select whose change re-renders the
// whole section — fresh render-order ids, the earlier ownership select reset to "Select...".
//
//   [A] The planner answers "Customer Owned" for an option listed as "Customer-Owned" (the exact
//       live event sequence on main: no pass of selectWithFallback matched it), and — like any
//       planner shown a required select — asks for "New Contact" on the picker again, AFTER the
//       ownership answer. MUST: the learn ends with the select filled; nothing reports it blank;
//       the recorded steps pick the contact source once, before the ownership answer (a second
//       pick after it re-renders the block and resets the answer on every replay).
//   [B] The planner answers "Leased", which the list does not hold. MUST: the run names the
//       options the select offered, and still reports the required select blank (never silent,
//       never a guessed option).
//
//   npx tsx portal-bot/src/adapters/rerenderClearsSelect.dom.smoke.ts
import "../smokeArtifactDirs"; // hand-run safe: artifact dirs default to a temp folder, never data/
import http from "node:http";
import { chromium } from "playwright";
import { AutoLearnAdapter, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const OWN_Q = "Will the System be Customer-Owned or Third-Party Owned?";
const SECTION = `
  <label for="pcInputBase__N__1">${OWN_Q} <span class="req">*</span></label>
  <select id="pcInputBase__N__1" required aria-required="true">
    <option value="">Select...</option><option value="11">Customer-Owned</option><option value="12">Third-Party Owned</option>
  </select>
  <label for="pcInputBase__N__2">Existing contact to use for this contact</label>
  <select id="pcInputBase__N__2">
    <option value="">Select...</option><option value="new">New Contact</option><option value="c1">ZZTEST Existing Contact</option>
  </select>
  <label for="pcInputBase__N__3">Name</label><input id="pcInputBase__N__3" type="text">`;
const PAGE = `<!doctype html><html><body style="font:14px sans-serif;padding:16px">
<h3>Generation System Owner Information</h3>
<div id="sec">${SECTION.replace(/__N__/g, "1")}</div>
<button id="next" type="button">Next</button>
<script>
  // PowerClerk re-renders the block on EVERY change of the contact source, even to the option it
  // already holds: the section is rebuilt with new render-order ids and every other answer in it
  // is reset; only the picker keeps its choice.
  var n = 1; var TPL = ${JSON.stringify(SECTION)};
  window.__rerenders = 0;
  function wire() {
    document.querySelector('#sec select[id$="2"]').addEventListener('change', function () {
      var v = this.value; n++; window.__rerenders++;
      document.getElementById('sec').innerHTML = TPL.replace(/__N__/g, String(n));
      document.querySelector('#sec select[id$="2"]').value = v;
      wire();
    });
  }
  wire();
</script>
</body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(PAGE); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

type Ev = Record<string, unknown>;
async function run(ownershipAnswer: string): Promise<{ own: string; events: Ev[]; steps: Array<Record<string, unknown>>; rerenders: number }> {
  let calls = 0;
  // Sees the page once (after that it says "review", so the walk ends on this page) and answers it
  // in DOM order: the ownership question, then the contact source again, then the name.
  const planner: LearnPlanner = async (req) => {
    if (++calls > 1) return { fills: [], atReview: true };
    const ix = (re: RegExp): number => req.fields.findIndex((f) => re.test(String(f.label ?? "")));
    return {
      fills: [
        { selectorIndex: ix(/Customer-Owned or Third-Party/), value: ownershipAnswer },
        { selectorIndex: ix(/Existing contact to use/), value: "New Contact" },
        { selectorIndex: ix(/^Name$/), value: "ZZTEST Owner" },
      ],
      atReview: false,
    };
  };
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
    const page = await ctx.newPage();
    await page.goto(url);
    const adapter = new AutoLearnAdapter("Rerender Select Test", planner, { maxPages: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).page = page;
    const events: Ev[] = [];
    const holder = adapter as unknown as { debug?: { event: (e: Ev) => void } };
    if (holder.debug && typeof holder.debug.event === "function") {
      const orig = holder.debug.event.bind(holder.debug);
      holder.debug.event = (e) => { events.push(e); orig(e); };
    } else {
      (holder as { debug?: unknown }).debug = { event: (e: Ev) => { events.push(e); }, startTrace: async () => {}, stopTrace: async () => {} };
    }
    const r = await adapter.learn(
      { portalUrl: url } as never,
      { projectAddress: "1 Test St, Springfield, IL, 62701", city: "Springfield", state: "IL", zip: "62701", homeownerName: "ZZTEST" } as never,
    );
    const own = await page.locator('#sec select[id$="1"]').inputValue().catch(() => "");
    const rerenders = Number(await page.evaluate(() => (window as unknown as { __rerenders: number }).__rerenders).catch(() => 0));
    return { own, events, steps: ((r.steps ?? []) as unknown as Array<Record<string, unknown>>), rerenders };
  } finally {
    await browser.close();
  }
}

const labelOf = (s: Record<string, unknown>): string => String((s.selector as { label?: string } | undefined)?.label ?? "");
const names = (events: Ev[], type: string): string =>
  JSON.stringify(events.filter((e) => e.type === type).map((e) => e.labels ?? e.label));

console.log("[A] the answer differs from the option only in punctuation; the planner picks the contact source again");
{
  const { own, events, steps, rerenders } = await run("Customer Owned");
  check("[A] the picker was answered, so the section actually re-rendered", rerenders >= 1,
    "the fixture never re-rendered — this test is not exercising the path it claims to");
  check("[A] the learn ends with the ownership select filled (Customer-Owned)", own === "11",
    `ownership select holds ${JSON.stringify(own)}; events ${JSON.stringify(events.filter((e) => /contact_source|rerender|fills_did|required_never|select_value/.test(String(e.type))))}`);
  check("[A] nothing reports it as a fill that did not hold", !/Customer-Owned or Third-Party/.test(names(events, "fills_did_not_hold")), names(events, "fills_did_not_hold"));
  check("[A] nothing reports it as a required field left blank", !/Customer-Owned or Third-Party/.test(names(events, "required_never_filled")), names(events, "required_never_filled"));
  const order = steps.map(labelOf);
  const pickAt = order.map((l, i) => (/Existing contact to use/.test(l) ? i : -1)).filter((i) => i >= 0);
  const ownAt = order.findIndex((l) => /Customer-Owned or Third-Party/.test(l));
  check("[A] the contact source is picked once in the recorded steps", pickAt.length === 1, `steps: ${JSON.stringify(order)}`);
  check("[A] no recorded pick of the contact source comes after the ownership answer (a replay would reset it)",
    ownAt >= 0 && pickAt.every((i) => i < ownAt), `steps: ${JSON.stringify(order)}`);
}

console.log("[B] the answer is not among the options");
{
  const { own, events } = await run("Leased");
  const notOffered = events.find((e) => e.type === "select_value_not_offered" && /Customer-Owned or Third-Party/.test(String(e.label ?? "")));
  check("[B] no option is guessed", own === "", `ownership select holds ${JSON.stringify(own)}`);
  check("[B] the run names the options the select offered",
    !!notOffered && JSON.stringify(notOffered.offered) === JSON.stringify(["Customer-Owned", "Third-Party Owned"]) && notOffered.wanted === "Leased",
    JSON.stringify(events.filter((e) => /select_value|fills_did|required_never/.test(String(e.type)))));
  check("[B] the required select is still reported blank", /Customer-Owned or Third-Party/.test(names(events, "required_never_filled")), names(events, "required_never_filled"));
}

server.close();
console.log(failures === 0 ? "rerenderClearsSelect.dom.smoke: PASS" : `rerenderClearsSelect.dom.smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
