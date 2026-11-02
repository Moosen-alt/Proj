// The read half of clientRequestLinks.ts (#488): which automatic asks of the client are still open
// for a project, for the Next step's "Sent to <contact> on <date>" line.
//
// Its own module, importing nothing but the db type, because nextStep reads it and nextStep sits in
// the repository import cycle; the send half pulls in intakeRequests → repository at load time.
// READ-ONLY: a SELECT on a table migration v54 creates (never lazily — nextStep.test pins that
// reads write nothing).
import type { AppDb } from "./db";
import type { ClientAskSent } from "../../shared/src/types";

interface SendRow {
  kind: string;
  recipient: string;
  sent_at: string;
  delivery_status: string;
  needs_json: string;
  reminder_at: string;
  reminder_status: string;
}

/** Open asks for this project: its own intake ask, and any open portal-login ask made for its
 *  client (one login request serves every job of that client on the same portal). */
export function clientAsksForProject(db: AppDb, projectId: string): ClientAskSent[] {
  try {
    const project = db.get<{ client_id?: string }>("SELECT client_id FROM projects WHERE id = ?", [projectId]);
    const clientId = String(project?.client_id ?? "");
    const rows = db.query<SendRow>(
      `SELECT kind, recipient, sent_at, delivery_status, needs_json, reminder_at, reminder_status
         FROM client_request_sends
        WHERE closed_at = '' AND (project_id = ? OR (kind = 'credentials' AND client_id = ? AND client_id != ''))
        ORDER BY sent_at`,
      [projectId, clientId],
    );
    return rows.map((r) => {
      let needs: string[] = [];
      try { needs = (JSON.parse(r.needs_json || "[]") as unknown[]).map((n) => String(n)); } catch { needs = []; }
      return {
        kind: r.kind === "credentials" ? "credentials" : "intake",
        recipient: String(r.recipient ?? ""),
        sentAt: String(r.sent_at ?? ""),
        deliveryStatus: String(r.delivery_status ?? ""),
        needs,
        ...(r.reminder_at ? { reminderAt: String(r.reminder_at), reminderStatus: String(r.reminder_status ?? "") } : {}),
      };
    });
  } catch {
    // A database from before v54 has no asks to show; the banner simply carries no line.
    return [];
  }
}
