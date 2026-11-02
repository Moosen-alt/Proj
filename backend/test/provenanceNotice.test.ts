// OWNERSHIP NOTICE (#545). Keelix's source is proprietary; every copy of the source and every
// page the app serves must say so and carry the one fixed provenance id. Pinned here:
//   - LICENSE exists at the repo root, names Keelix, reserves all rights and grants no licence;
//   - root and tools/form-filler package.json say "UNLICENSED" (npm's proprietary value), and
//     the lockfile's root entry agrees;
//   - EVERY frontend/*.html page (discovered from disk, so a new page is covered) carries the
//     `copyright` meta = COPYRIGHT_NOTICE and the `keelix-provenance` meta = PROVENANCE_ID,
//     each exactly once;
//   - the sign-in page shows a visible copyright line;
//   - the provenance id keeps its shape and value (changing it throws away its evidence value);
//   - the server's startup logs the notice and the id;
//   - README says proprietary and points at LICENSE.
// Reads files only. Run: npx tsx backend/test/provenanceNotice.test.ts
import "./_isolate";
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COPYRIGHT_NOTICE, PROVENANCE_ID } from "../../shared/src/provenance";

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`PASS - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

check("LICENSE names Keelix, reserves all rights and grants no licence", () => {
  const text = read("LICENSE");
  assert.match(text, /Copyright \(c\) 2026 Keelix\. All rights reserved\./);
  assert.match(text, /proprietary and confidential property of Keelix/);
  assert.match(text, /trade secrets/);
  assert.match(text, /No licence or other right in the Software is granted/);
  assert.doesNotMatch(text, /Permission is hereby granted/i, "must not read as an open-source grant");
});

check("package files declare the code UNLICENSED and private", () => {
  for (const rel of ["package.json", "tools/form-filler/package.json"]) {
    const pkg = JSON.parse(read(rel));
    assert.equal(pkg.license, "UNLICENSED", `${rel} license`);
    assert.equal(pkg.private, true, `${rel} private`);
  }
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.packages[""].license, "UNLICENSED", "package-lock root entry");
});

check("the provenance id keeps its fixed value", () => {
  assert.equal(PROVENANCE_ID, "kx-fcd3ffd4aa792bbd");
  assert.match(COPYRIGHT_NOTICE, /^Copyright \(c\) 2026 Keelix\. All rights reserved\./);
});

const escAttr = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pages = fs.readdirSync(path.join(REPO, "frontend")).filter((f) => f.endsWith(".html")).sort();

check("every frontend page carries the copyright and provenance meta tags once", () => {
  assert.ok(pages.length >= 11, `expected the frontend pages, found ${pages.length}`);
  const copyrightTag = new RegExp(`<meta name="copyright" content="${escAttr(COPYRIGHT_NOTICE)}" />`, "g");
  const provenanceTag = new RegExp(`<meta name="keelix-provenance" content="${escAttr(PROVENANCE_ID)}" />`, "g");
  for (const page of pages) {
    const html = read(path.join("frontend", page));
    const head = html.slice(0, html.indexOf("</head>"));
    assert.ok(head.length > 0, `${page}: no </head>`);
    assert.equal((head.match(copyrightTag) || []).length, 1, `${page}: copyright meta`);
    assert.equal((head.match(provenanceTag) || []).length, 1, `${page}: keelix-provenance meta`);
  }
});

check("the sign-in page shows a visible copyright line", () => {
  assert.match(read("frontend/login.html"), /<p class="login-legal">&copy; 2026 Keelix\. All rights reserved\./);
});

check("the server logs the notice and the provenance id at startup", () => {
  const server = read("backend/src/server.ts");
  assert.match(server, /import \{ COPYRIGHT_NOTICE, PROVENANCE_ID \} from "\.\.\/\.\.\/shared\/src\/provenance";/);
  assert.match(server, /logger\.info\("build", COPYRIGHT_NOTICE, \{ provenance: PROVENANCE_ID \}\);/);
});

check("README says proprietary and points at LICENSE", () => {
  const readme = read("README.md");
  assert.match(readme.slice(0, 600), /Proprietary and confidential/);
  assert.match(readme.slice(0, 600), /\[LICENSE\]\(LICENSE\)/);
});

console.log(`provenanceNotice: ${passed} checks passed`);
