// SAVING AN EXTRA IMAP INBOX (#498). POST /api/imap/sources calls upsertImapSource, which
// used to (1) `require("node:crypto")` inside an ESM module, so every call threw
// "require is not defined" before writing anything, and (2) insert every IMAP row with
// file_path = '', a NOT NULL UNIQUE column, so even with (1) fixed the SECOND inbox failed
// with a UNIQUE constraint error. This pins: a source saves, a second one saves, an update
// keeps the stored password when none is sent, and the rows are what the poller reads.
// Synthetic hosts and credentials only. Browser-free. Run: tsx backend/test/imapSourceSave.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-source-save-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SEED_TEST_INSTALLER = "false";
process.env.SESSION_ENCRYPTION_KEY = "imap-source-save-test-key-0123456789abcdef";

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { upsertImapSource, imapSourceFilePath } = await import("../src/emailPoller");
const { decryptStorageState } = await import("../../portal-bot/src/cryptoStorage");

const db = await openDatabase();

let failures = 0;
const run = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label} ${detail}`); }
};
const attempt = <T>(fn: () => T): { value?: T; error?: string } => {
  try { return { value: fn() }; } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
};

type SourceRow = {
  id: string; source_type: string; label: string; file_path: string; imap_host: string;
  imap_user: string; imap_pass_encrypted: string; imap_mailbox: string; active: number; org_id: string;
};
const row = (id: string) => db.get<SourceRow>("SELECT * FROM email_tracking_sources WHERE id = ?", [id]);
const password = (r: SourceRow | undefined) =>
  r?.imap_pass_encrypted ? (decryptStorageState(r.imap_pass_encrypted) as { password?: string }).password : undefined;

console.log("[1] the first IMAP source saves");
const first = attempt(() => upsertImapSource(db, { label: "Permits inbox", host: "imap.one.invalid", user: "permits@one.invalid", password: "synthetic-pw-1" }));
run("upsertImapSource does not throw", !first.error, first.error);
const firstRow = first.value ? row(first.value) : undefined;
run("the row is written as an active imap source", firstRow?.source_type === "imap" && firstRow.active === 1 && firstRow.imap_host === "imap.one.invalid", JSON.stringify(firstRow));
run("its file_path is the unique imap:<id> marker, never ''", !!firstRow && firstRow.file_path === imapSourceFilePath(firstRow.id) && firstRow.file_path !== "", firstRow?.file_path);
run("the password is stored encrypted, never plaintext", !!firstRow && !firstRow.imap_pass_encrypted.includes("synthetic-pw-1") && password(firstRow) === "synthetic-pw-1");
run("a source saved without an org lands in the default tenant", firstRow?.org_id === DEFAULT_ORG_ID, firstRow?.org_id);

console.log("\n[2] a second IMAP source saves too (UNIQUE(file_path) no longer collides)");
const second = attempt(() => upsertImapSource(db, { label: "Second inbox", host: "imap.two.invalid", user: "nem@two.invalid", password: "synthetic-pw-2", mailbox: "Utility" }));
run("the second upsertImapSource does not throw", !second.error, second.error);
run("it gets its own id", !!second.value && second.value !== first.value);
const imapCount = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_tracking_sources WHERE source_type = 'imap'")?.n;
run("both rows exist", imapCount === 2, String(imapCount));

console.log("\n[3] an update by id keeps the row, its marker and its password");
if (first.value) {
  const updated = attempt(() => upsertImapSource(db, { id: first.value, label: "Permits inbox (renamed)", host: "imap.one.invalid", user: "permits@one.invalid" }));
  run("the update does not throw and returns the same id", !updated.error && updated.value === first.value, updated.error ?? updated.value);
  const after = row(first.value);
  run("the label changed", after?.label === "Permits inbox (renamed)", after?.label);
  run("the password is kept when none is sent", password(after) === "synthetic-pw-1");
  run("the file_path marker is unchanged", after?.file_path === imapSourceFilePath(first.value), after?.file_path);
  const stillTwo = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM email_tracking_sources WHERE source_type = 'imap'")?.n;
  run("no extra row was inserted", stillTwo === 2, String(stillTwo));
}

console.log("\n[4] a caller-chosen id that does not exist yet is created with that id");
const chosen = attempt(() => upsertImapSource(db, { id: "client-inbox-3", label: "Third", host: "imap.three.invalid", user: "u@three.invalid", password: "synthetic-pw-3" }));
run("created under the given id", chosen.value === "client-inbox-3" && row("client-inbox-3")?.file_path === "imap:client-inbox-3", chosen.error ?? row("client-inbox-3")?.file_path);

console.log(failures === 0 ? "\nimapSourceSave: all checks passed" : `\nimapSourceSave: ${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
