// THE SHARED SCRUB ONLY EVER REDACTS MORE THAN IT DID ON MAIN (#436 fix round 1, rule 2).
//
// redactSecretValues (shared/src/portalSafety.ts) is the one embedded-secret scrub every text that
// leaves the process goes through: the planner's fields (autoLearn), reviewerVision, staffAlerts,
// approvalSheet, emailIntake, installerHandoff, projectEvidence, the staged digest and its row. #436
// widened it (the comma / underscore / parentheses separators; a lettered secret by its whole
// letter-and-digit sequence) — and the first widening ran INSTEAD of the literal match, so a lettered
// secret of < 5 digits holding any other character went through in clear where main redacted it:
// "Pass!2024", "Sol@r2024", "AB*1234", "Zürich12", "XK+8821", and through the product's own secret set
// a portal password "Sol@r2024" and a service agreement "SA:12AB34" in a note.
//
// THE ORACLE is main's function, copied here VERBATIM (origin/main ffee9493 = merge base d07388da).
//   (a) the named cases: main redacts each, so must the branch — and through projectSecretValues.
//   (b) the widenings stay: "1ND4421" (alphanumeric meter) and "8,814,402,937" (comma-grouped) are
//       redacted (main leaves both in clear).
//   (c) THE PROPERTY, over a generated corpus (secrets x separators x contexts, plus multi-secret
//       lines): with a same-length marker as the replacement, every character main redacts is redacted
//       by the branch too; and with the default replacement, a text main changes is changed.
//   (d) MUST-EXCLUDE: what main keeps and the widenings have no reason to touch stays verbatim.
//
// KILL (verified red by hand): restore the `else if` shape (the literal pass only when the secret
// carries no letters-and-digits sequence) → (a) and (c) fail.
//
// All numbers are synthetic.
//
//   npx tsx backend/test/redactSecretValuesSuperset.test.ts
import "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

/** MAIN'S redactSecretValues, verbatim (origin/main ffee9493). The oracle: never edit it. */
function mainRedactSecretValues(text: string, secrets: Iterable<string>, replace: (hit: string) => string = () => "[redacted]"): string {
  let out = text;
  for (const secret of secrets) {
    const digits = String(secret ?? "").replace(/\D/g, "");
    if (digits.length >= 5) {
      const pattern = digits.split("").join("[\\s\\-\\u2010-\\u2015\\u2212.#/]*");
      out = out.replace(new RegExp(`(?<!\\d)${pattern}(?!\\d)`, "g"), (m) => replace(m));
    } else if (String(secret ?? "").trim().length >= 6 && /\d/.test(String(secret))) {
      // Whitespace inside the secret matches any whitespace run: text read off a page wraps "AB 1234"
      // at its space as easily as it prints it on one line (#260 review). Trimmed before the length
      // gate, so padding never lets a short value through to over-redact.
      const literal = String(secret).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      out = out.replace(new RegExp(literal, "gi"), (m) => replace(m));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { redactSecretValues } = await import("../../shared/src/portalSafety");
  const { projectSecretValues } = await import("../src/projectSecrets");

  // ── (a) the named cases ───────────────────────────────────────────────────────────────────
  for (const secret of ["Pass!2024", "Sol@r2024", "AB*1234", "Zürich12", "XK+8821"]) {
    const text = `Portal note: ${secret} is on file.`;
    const want = "Portal note: [redacted] is on file.";
    check(`(a) SETUP: main redacts "${secret}"`, mainRedactSecretValues(text, [secret]) === want, mainRedactSecretValues(text, [secret]));
    check(`(a) MUST-PASS: the branch redacts "${secret}"`, redactSecretValues(text, [secret]) === want, redactSecretValues(text, [secret]));
  }
  const secrets = projectSecretValues({ accountNumber: "", meterNumber: "", parserSnapshot: { portalPassword: "Sol@r2024", serviceAgreementId: "SA:12AB34" } } as never);
  check("(a) SETUP: projectSecretValues lists the password and the service agreement", secrets.includes("Sol@r2024") && secrets.includes("SA:12AB34"), JSON.stringify(secrets));
  const note = "Utility login uses Sol@r2024; service agreement SA:12AB34 on file.";
  const noteWant = "Utility login uses [redacted]; service agreement [redacted] on file.";
  check("(a) SETUP: main redacts both in the note", mainRedactSecretValues(note, secrets) === noteWant, mainRedactSecretValues(note, secrets));
  check("(a) MUST-PASS: the branch redacts both in the note (through projectSecretValues)", redactSecretValues(note, secrets) === noteWant, redactSecretValues(note, secrets));

  // ── (b) the widenings stay ────────────────────────────────────────────────────────────────
  const widen: Array<[string, string, string]> = [
    ["an alphanumeric meter", "1ND4421", "Meter 1ND4421 east wall."],
    ["an alphanumeric meter, dash-grouped", "1ND4421", "Meter 1-nd-4421 east wall."],
    ["a comma-grouped account", "8814402937", "Account 8,814,402,937 on the bill."],
    ["an underscore-grouped account", "8814402937", "Account 8814_402_937 on the bill."],
    ["a parenthesised account", "8814402937", "Account (8814) 402-937 on the bill."],
  ];
  for (const [label, secret, text] of widen) {
    const out = redactSecretValues(text, [secret]);
    check(`(b) MUST-PASS: ${label} is redacted`, out !== text && !/4421|402.?937/.test(out), out);
  }

  // ── (c) the property ──────────────────────────────────────────────────────────────────────
  // A deterministic generator (no Math.random: a red run must replay).
  let seed = 436;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];
  const SECRETS = [
    "Pass!2024", "Sol@r2024", "AB*1234", "Zürich12", "XK+8821", "SA:12AB34", "1ND4421", "8814402937", "80000100",
    "AB 1234", "12-34-5678", "ab12cd", "A1B2C3D4", "(8814) 402-937", "1234", "Sun-2024", "ESI 1008 9012", "007734",
    "Solar#77", "M-55.21", "12345", "4421ND1", "x9y8z7w6",
  ];
  const SEPS = ["", " ", "-", "—", "‑", ".", "#", "/", ",", "_", "(", ")", "\n", "\r\n", "*", "!", "@", ":", "+", "  "];
  const CONTEXTS: Array<(v: string) => string> = [
    (v) => v, (v) => `Account ${v} on file.`, (v) => `x${v}y`, (v) => `1${v}2`, (v) => `Ref ${v}0`, (v) => `${v}, ${v}.`,
    (v) => `Meter #${v}\nnext line`, (v) => `(${v})`, (v) => `pw=${v};`, (v) => `${v.toUpperCase()} / ${v.toLowerCase()}`,
  ];
  const variant = (s: string): string => {
    switch (rnd(4)) {
      case 0: return s;
      case 1: return rnd(2) ? s.toUpperCase() : s.toLowerCase();
      case 2: { const sep = pick(SEPS); return s.split("").join(sep); }
      default: { // a separator at one random spot
        const i = rnd(s.length + 1); return `${s.slice(0, i)}${pick(SEPS)}${s.slice(i)}`;
      }
    }
  };
  const MARK = "█";
  const marker = (hit: string): string => MARK.repeat(hit.length);
  let cases = 0;
  let mainHits = 0;
  const bad: string[] = [];
  const judge = (text: string, ss: string[]): void => {
    if (text.includes(MARK)) return;
    cases++;
    const o = mainRedactSecretValues(text, ss, marker);
    const b = redactSecretValues(text, ss, marker);
    if (o.length !== text.length || b.length !== text.length) { bad.push(`length changed: ${JSON.stringify({ text, ss, o, b })}`); return; }
    let lost = -1;
    for (let i = 0; i < text.length; i++) if (o[i] === MARK && b[i] !== MARK) { lost = i; break; }
    if (o !== text) mainHits++;
    if (lost >= 0) bad.push(`main redacts position ${lost} the branch keeps: ${JSON.stringify({ text, ss, main: o, branch: b })}`);
    const od = mainRedactSecretValues(text, ss);
    const bd = redactSecretValues(text, ss);
    if (od !== text && bd === text) bad.push(`main changes a text the branch leaves verbatim: ${JSON.stringify({ text, ss })}`);
  };
  for (const s of SECRETS) for (const ctx of CONTEXTS) { judge(ctx(s), [s]); for (let k = 0; k < 12; k++) judge(ctx(variant(s)), [s]); }
  for (let k = 0; k < 3000; k++) {
    const s = pick(SECRETS);
    judge(pick(CONTEXTS)(variant(s)), [s]);
  }
  // Several secrets at once, in one line (the product passes the account, the meter and the parser's
  // secret fields together).
  for (let k = 0; k < 1500; k++) {
    const ss = [pick(SECRETS), pick(SECRETS), pick(SECRETS)];
    judge(`Account ${variant(ss[0])}; meter ${variant(ss[1])}, login ${variant(ss[2])} per the bill.`, ss);
  }
  check(`(c) SETUP: the corpus exercises main's scrub (${mainHits} of ${cases} lines redacted by main)`, cases > 4000 && mainHits > 1000, `${mainHits}/${cases}`);
  check(`(c) THE PROPERTY: every character main redacts, the branch redacts (${cases} lines)`, bad.length === 0, bad.slice(0, 3).join("\n"));

  // ── (d) MUST-EXCLUDE ──────────────────────────────────────────────────────────────────────
  const keep: Array<[string, string[]]> = [
    ["Comply with NEC 690.12 and CRC R324.6.1 — rapid shutdown.", ["1234567890", "Sol@r2024"]],
    ["37 modules, 12.913 kW AC, ZIP 97140, 200A main, 120/240 V.", ["1234567890", "80000100", "SA:12AB34"]],
    ["Ref 91234-5678-9012 is a different number.", ["1234567890"]],
    ["Exterior meter on the east wall.", ["exterior"]],
  ];
  for (const [text, ss] of keep) {
    check(`(d) MUST-EXCLUDE: "${text.slice(0, 40)}" stays verbatim`, redactSecretValues(text, ss) === text && mainRedactSecretValues(text, ss) === text, redactSecretValues(text, ss));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
