// THE NAME A CLIENT SEES ON EVERY UPDATE — one leaf constant (env only, no imports).
//
// PROVISIONAL: the operator has not settled the company name, so it lives here as one constant with
// an env override rather than being scattered through the templates. Change BRAND_NAME in .env, or
// this default. It moved here from clientUpdates.ts (which re-exports it) so the email layout
// (emailLayout.ts) can read it without pulling in the database layer: scripts/ops/mailer.ts imports
// the layout, and a watchdog must keep working when the database is exactly what broke.
export const BRAND = (process.env.BRAND_NAME || "Keelix").trim() || "Keelix";
