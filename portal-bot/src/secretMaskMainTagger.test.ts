// #436 ROUND 4 — THE LEARNER'S MASK IS A SUPERSET OF ORIGIN/MAIN'S BY CONSTRUCTION (hard rule 2).
//
// Three review rounds in a row found a page the rewritten tagger left in clear where origin/main's
// learner masked it. The convergence: origin/main's inline tagger body runs FIRST, verbatim
// (secretMask.ts mainLearnerTagger), then the rewritten tagger; both mark [data-al-secret]. This test
// pins the construction by source, so it cannot quietly come apart:
//   MUST-PASS  the 50 body lines of mainLearnerTagger hash to origin/main's (ffee9493
//              autoLearnAdapter.ts lines 9935-9984, the arrow withSecretMask passed to page.evaluate;
//              the same bytes at the branch point d07388da). Recompute with
//                git show ffee9493:portal-bot/src/adapters/autoLearnAdapter.ts | sed -n 9935,9984p | sha256sum
//   MUST-PASS  tagSecretsForMask runs tagSecretsLikeMain BEFORE tagSecretsInPage, each pass caught on
//              its own; tagSecretsLikeMain evaluates mainLearnerTagger.
//   MUST-PASS  the learner's withSecretMask and the staged picture's maskedFullPageScreenshot both tag
//              through tagSecretsForMask, and neither calls tagSecretsInPage alone.
//   MUST-PASS  clearSecretTags removes [data-al-secret] (both passes' mark) in every root.
//
// KILL (each run by hand, then restored): one byte of the body changed (a `>= 0` to `> 0`) → the hash
// check fails; withSecretMask calling tagSecretsInPage again → the withSecretMask check fails;
// tagSecretsForMask without its main pass → the order check fails.
//
//   npx tsx portal-bot/src/secretMaskMainTagger.test.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
let total = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  total++;
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const mask = fs.readFileSync(path.join(here, "secretMask.ts"), "utf8");
const learner = fs.readFileSync(path.join(here, "adapters", "autoLearnAdapter.ts"), "utf8");

/** sha256 of origin/main's 50 body lines, LF-joined with a trailing newline (as `sed -n | sha256sum`). */
const MAIN_BODY_SHA256 = "74999e6a82c5144a6130981b8a7dc1a0161e716909601abd8452b5a26c853377";
const DECL = "const mainLearnerTagger = (ps: Array<{ digits: string; literal: string }>): number => {";

console.log("\n1. origin/main's tagger body is in secretMask.ts, verbatim");
{
  const lines = mask.split(/\r?\n/);
  const start = lines.findIndex((l) => l === DECL);
  check("the declaration line is there, once", start >= 0 && lines.filter((l) => l === DECL).length === 1, `found at ${start}`);
  const end = start >= 0 ? lines.findIndex((l, i) => i > start && l === "};") : -1;
  const body = start >= 0 && end > start ? lines.slice(start + 1, end) : [];
  check("the body is 50 lines", body.length === 50, `lines=${body.length}`);
  const sha = createHash("sha256").update(`${body.join("\n")}\n`, "utf8").digest("hex");
  check("the body hashes to origin/main's (byte for byte, indentation included)", sha === MAIN_BODY_SHA256, `sha256=${sha}`);
  check("tagSecretsLikeMain evaluates mainLearnerTagger", /export async function tagSecretsLikeMain\([^)]*\)[^{]*\{\s*return Number\(await page\.evaluate\(mainLearnerTagger, pats\)\);\s*\}/.test(mask));
}

console.log("\n2. the union: main's pass first, then the shared tagger");
{
  const m = /export async function tagSecretsForMask\([\s\S]*?\n\}\n/.exec(mask);
  const fn = m ? m[0] : "";
  const iMain = fn.indexOf("await tagSecretsLikeMain(page, pats)");
  const iShared = fn.indexOf("await tagSecretsInPage(page, pats)");
  check("tagSecretsForMask is there", fn.length > 0);
  check("tagSecretsForMask runs main's pass BEFORE the shared tagger", iMain > 0 && iShared > iMain, `main@${iMain} shared@${iShared}`);
  check("each pass is caught on its own (one throwing keeps the other's tags)", (fn.match(/\}\s*catch\s*\{/g) ?? []).length === 2 && (fn.match(/\btry\s*\{/g) ?? []).length === 2);
  check("`tagged` holds when a pass tagged OR threw", /tagged:\s*!ok\s*\|\|\s*main\s*>\s*0\s*\|\|\s*shared\s*>\s*0/.test(fn));
}

console.log("\n3. both faces tag through the union, and nothing tags with the shared tagger alone");
{
  const w = /private async withSecretMask<T>\([\s\S]*?\n {2}\}\n/.exec(learner);
  const ws = w ? w[0] : "";
  check("withSecretMask is there", ws.length > 0);
  check("withSecretMask tags through tagSecretsForMask", /await tagSecretsForMask\(this\.page, pats\)/.test(ws));
  check("withSecretMask never calls tagSecretsInPage alone", !/tagSecretsInPage/.test(ws));
  check("withSecretMask masks [data-al-secret] when tagged, and clears when tagged", /tagged \? \[this\.page\.locator\("\[data-al-secret\]"\)\]/.test(ws) && /if \(tagged\) await clearSecretTags\(this\.page\)/.test(ws));
  check("autoLearnAdapter.ts calls tagSecretsInPage nowhere", !/tagSecretsInPage/.test(learner));
  const s = /export async function maskedFullPageScreenshot\([\s\S]*?\n\}\n/.exec(mask);
  const ss = s ? s[0] : "";
  check("maskedFullPageScreenshot is there", ss.length > 0);
  check("maskedFullPageScreenshot tags each frame through tagSecretsForMask, and fails the frame when a pass fails", /await tagSecretsForMask\(frame, pats\)/.test(ss) && /if \(!t\.ok\) throw/.test(ss));
  check("maskedFullPageScreenshot never calls tagSecretsInPage alone", !/tagSecretsInPage/.test(ss));
}

console.log("\n4. one clear for both passes");
{
  const c = /export async function clearSecretTags\([\s\S]*?\n\}\n/.exec(mask);
  const cs = c ? c[0] : "";
  check("clearSecretTags removes data-al-secret in every root (document and open shadow roots)", /removeAttribute\("data-al-secret"\)/.test(cs) && /shadowRoot/.test(cs));
  check("main's body marks the same attribute the mask selects", mask.includes(`el.setAttribute("data-al-secret", "1"); n++; break;`) && /SECRET_MASK_ATTR = "data-al-secret"/.test(mask));
}

console.log(failures === 0 ? `\nAll ${total}/${total} secretMaskMainTagger checks passed.` : `\n${failures}/${total} secretMaskMainTagger check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
