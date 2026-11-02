// Print the Cloudflare Access bypass list for docs/OPERATIONS_LINUX.md §3 (#437).
//
//   npx tsx scripts/ops/linux/access-bypass.ts            # the runbook table (markdown)
//   npx tsx scripts/ops/linux/access-bypass.ts --paths    # one path per line, for the dashboard
//
// The list lives in backend/src/accessBypass.ts; backend/test/accessBypass.test.ts checks it
// against the app's own sign-in gate (requireAuth) and against the copy in the runbook. Read-only.
import { ACCESS_BYPASS_PATHS, renderAccessBypassTable } from "../../../backend/src/accessBypass";

if (process.argv.includes("--paths")) {
  for (const e of ACCESS_BYPASS_PATHS) console.log(e.path);
} else {
  console.log(renderAccessBypassTable());
}
