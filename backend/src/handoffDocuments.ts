// ---------------------------------------------------------------------------
// WHICH FILES TRAVEL WITH THE INSTALLER HANDOFF EMAIL (#491).
//
// A LEAF on purpose (fs, path and the db handle only): both the handoff sender
// (installerHandoff.ts) and the backlog re-send (clientNotifier.resendCommunication, driven by
// scripts/undelivered.ts) resolve the attachments through this one function, so a packet first
// recorded as a draft (SMTP unset) still carries its documents when the backlog is sent later.
// clientNotifier importing installerHandoff instead would be a cycle.
//
// ONLY THE PROJECT'S OWN ISSUED DOCUMENTS, BY TYPE. The allowlist is the whole rule: a utility
// bill or a meter photo is on file for almost every job and carries the account and meter numbers
// (rule 2), so "attach what is on file" would mail them to the installer. Only the issued permit
// and the utility's approval / PTO letter go, and only rows of THIS project whose file sits inside
// the project-documents store — never a path a row merely names.
//
// The issued-document fetch (#492) and a person's upload store them under these doc types.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { projectDocsDir } from "./statePaths";

/** The logged_by every installer-handoff communication carries — automatic or pressed. It is how
 *  the one-send check, the Next step and the backlog re-send recognise a handoff row. */
export const INSTALLER_HANDOFF_SENDER = "installer-handoff (automated)";

/** Doc types that may be attached to the handoff email, with the name the email gives them. */
export const HANDOFF_ATTACHMENT_DOC_TYPES: Record<string, string> = {
  issued_permit: "Issued permit",
  utility_approval: "Utility approval / PTO letter",
};

/** A generous ceiling under the 20-25 MB most mail servers accept, and a file count that keeps a
 *  re-uploaded pile from turning into a dozen attachments. */
const MAX_ATTACHMENTS = 6;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export interface HandoffAttachment {
  /** A name WE make ("issued-permit-1.pdf"): an uploaded file's own name can carry an account
   *  number or the homeowner's name, and it is not ours to forward. */
  filename: string;
  path: string;
  contentType?: string;
  /** The label the email body lists. */
  label: string;
}

const SAFE_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg"]);

/** The issued documents on file for this project, newest first, inside the caps. */
export function installerHandoffAttachments(db: AppDb, projectId: string): HandoffAttachment[] {
  const types = Object.keys(HANDOFF_ATTACHMENT_DOC_TYPES);
  const root = path.resolve(projectDocsDir());
  const rows = db.query<{ doc_type: string; stored_path: string; content_type: string }>(
    `SELECT doc_type, stored_path, content_type FROM project_documents
      WHERE project_id = ? AND doc_type IN (${types.map(() => "?").join(",")})
      ORDER BY uploaded_at DESC, rowid DESC`,
    [projectId, ...types],
  );
  const out: HandoffAttachment[] = [];
  const perType: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const stored = path.resolve(String(row.stored_path || ""));
    // Inside the store, never beside it: a row whose path was edited to point elsewhere on disk is
    // not one of this project's documents, whatever its project_id says.
    if (!String(row.stored_path || "") || !(stored + path.sep).startsWith(root + path.sep) || stored === root) continue;
    let size = 0;
    try {
      const st = fs.statSync(stored);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    const type = String(row.doc_type);
    perType[type] = (perType[type] ?? 0) + 1;
    const ext = path.extname(stored).toLowerCase();
    out.push({
      filename: `${type.replace(/_/g, "-")}-${perType[type]}${SAFE_EXT.has(ext) ? ext : ""}`,
      path: stored,
      ...(row.content_type ? { contentType: String(row.content_type) } : {}),
      label: HANDOFF_ATTACHMENT_DOC_TYPES[type] ?? type,
    });
  }
  return out;
}
