// #358: the two pure answers the backstop's forward() leans on — which redirects re-send the request
// (and so must be judged as a fresh request before they are followed), and which bodies the backstop
// can re-send byte for byte. The real-browser cells are in filingBackstopRedirect.dom.smoke.ts.
import { bodyCanBeReplayed, redirectKeepsMethod } from "./filingBackstop";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail ? ` (${detail})` : ""}`); }
};

// Redirects (the Fetch standard).
for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
  check(`307 keeps ${m}`, redirectKeepsMethod(307, m));
  check(`308 keeps ${m}`, redirectKeepsMethod(308, m));
  check(`303 turns ${m} into a GET`, !redirectKeepsMethod(303, m));
}
check("301 / 302 turn a POST into a GET", !redirectKeepsMethod(301, "POST") && !redirectKeepsMethod(302, "post"));
check("301 / 302 keep a PUT and a DELETE", redirectKeepsMethod(301, "PUT") && redirectKeepsMethod(302, "DELETE"));
check("a 200 and a 304 are not redirects", !redirectKeepsMethod(200, "POST") && !redirectKeepsMethod(304, "PUT"));

// Bodies.
const B = "----WebKitFormBoundarySynthetic1";
const multipart = (parts: string[]): Buffer => Buffer.from(parts.map((p) => `--${B}\r\n${p}\r\n`).join("") + `--${B}--\r\n`, "latin1");
const field = (n: string, v: string) => `Content-Disposition: form-data; name="${n}"\r\n\r\n${v}`;
const file = (n: string, fname: string, bytes: string) => `Content-Disposition: form-data; name="${n}"; filename="${fname}"\r\nContent-Type: application/pdf\r\n\r\n${bytes}`;
const ct = `multipart/form-data; boundary=${B}`;
check("a urlencoded form can be re-sent", bodyCanBeReplayed("application/x-www-form-urlencoded", Buffer.from("a=1")));
check("a JSON body and no body can be re-sent", bodyCanBeReplayed("application/json", Buffer.from("{}")) && bodyCanBeReplayed("", null));
check("multipart of plain fields can be re-sent", bodyCanBeReplayed(ct, multipart([field("a", "1"), field("b", "")])));
check("multipart with a file part that carries its bytes can be re-sent", bodyCanBeReplayed(ct, multipart([file("plans", "plans.pdf", "%PDF-1.4 synthetic"), field("a", "1")])));
check("multipart whose file part Chromium left empty CANNOT be re-sent (an <input type=file> upload)", !bodyCanBeReplayed(ct, multipart([file("plans", "plans.pdf", ""), field("a", "1")])));
check("…in any position", !bodyCanBeReplayed(ct, multipart([field("a", "1"), file("plans", "plans.pdf", "")])));
check("…with a quoted boundary", !bodyCanBeReplayed(`multipart/form-data; boundary="${B}"`, multipart([file("f", "a.bin", "")])));
check("multipart with no boundary CANNOT be re-sent (nothing to tell)", !bodyCanBeReplayed("multipart/form-data", Buffer.from("x")));
check("multipart with a part missing its header break CANNOT be re-sent", !bodyCanBeReplayed(ct, Buffer.from(`--${B}\r\ngarbage--${B}--\r\n`, "latin1")));

if (failures) { console.error(`\nfilingBackstopRedirect: ${failures} FAILED`); process.exit(1); }
console.log("\nfilingBackstopRedirect: all checks passed");
