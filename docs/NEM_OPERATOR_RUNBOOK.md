# NEM operator runbook: from intake to a tracked interconnection filing

Audience: a Keelix team member filing a utility interconnection (NEM) application for a client,
who has never used the dashboard. Read it once top to bottom, then keep it open beside the
dashboard. Every statement about what the tool does names the code it comes from (on `main`,
2026-10-31) or the open issue where that behaviour is still being changed.

Install requirements (headed desktop or shared server, the approval switch, the re-pin) are at
the end, in [Before the first filing](#before-the-first-filing-install-requirements). The person
who runs the install does that part once.

> **What the tool will not do, ever** (CLAUDE.md hard rule 1)
>
> - **Pay a fee.** A fee page or payment dialog stops the run; a person pays on the portal.
> - **Solve a CAPTCHA or answer MFA.** The run stops; a person completes it.
> - **File without a named person's approval of that exact run.** No approval, no click: the run
>   stops at the portal's review page and a person submits.
>
> These hold on every button below. If anything you see seems to contradict them, stop and tell
> the owner.

---

## The short version

1. **Intake**: plan set + the customer's bill (or meter photo) in the Parser, then **Save to project**.
2. **Let the local steps run**: QC, document package, reviewer gate run by themselves. Clear
   anything they hold.
3. **Read the project as the legality check**: the reviewer gate is green for the NEM track and
   the project's data is right. This is the human review.
4. **On the NEM track card, click Approve & auto-submit** and confirm. The bot opens the utility
   portal, fills the application, stops at the review page, checks it, clicks the portal's
   application submit under your approval, reads the confirmation and updates the card.
5. **If the run stopped instead of filing**, it says why. Use the table in
   [When to stop and ask](#when-to-stop-and-ask). The usual fallback is the hand-over: Stage, check
   the review page in the window the bot leaves open, click submit yourself.
6. **Tracking**: the card follows the filing. Record a status by hand when the portal can't be read.

**Do not click Stage first and then Approve & auto-submit on the same NEM filing.** They are two
separate runs (see [step 4](#4-file-it-approve--auto-submit-the-primary-path)); the second one
stops at the first one's draft or starts a second application (#435).

---

## 1. Intake: plan set and the customer's bill

Open **Parser** (top bar, `/parser`). Upload the plan set and the customer's utility bill or a
photo of the meter, click **Parse uploaded files**, check what it read, then **Save to project**
(`frontend/parser.html`, `frontend/dashboard.html:98`). For a job with no plan set yet, **New
project** (`/new-project`) starts it by hand.

- **The bill matters.** Intake may read the bill or meter photo to find the account and meter
  numbers (CLAUDE.md rule 2: the one allowed read). A NEM stage refuses to open a browser until
  the project has **homeowner name, project address, utility account number, meter number, DC
  and AC system size, and utility** (`validatePortalFields`, `backend/src/repository.ts:7831-7866`).
  The refusal names each missing field.
- **File types.** The plan set must be a PDF. The bill and meter photo may be a PDF or a PNG,
  JPEG, GIF, TIFF or HEIC image (`backend/src/projectDocuments.ts:178-221`,
  `backend/src/fileTypes.ts:56-58`). **WebP is refused** by the documents route even though the
  Parser reads it, and today one refused file stops the files after it from attaching (#311).
  Convert a `.webp` bill to JPEG or PDF before you upload it.
- **The submitting client.** On the project, set **Submitting client**. Staging refuses without
  one, and in Oregon refuses a client with no CCB number on file
  (`repository.ts:8793-8801`).

## 2. QC, the reviewer gate and the document package

When a project is saved, the local steps run by themselves in order: split the plan set, read
the bill, QC, the official forms check, build the AHJ / NEM document package, the reviewer gate
and the historical check (`backend/src/autoStageSteps.ts:1-49`). They never open a portal: the
chain stops at "ready to stage" (`autoStageSteps.ts:16-19`).

What a hold looks like: the **Next step** banner at the top of the left rail names what is
holding the project, and the rail lists why each button is off (`frontend/dashboard.js`
`applyAutopilotState`, ~5306-5360). Pressing a stage button while held returns the reason as a
message instead of opening a portal. Staging refuses, each with its own message, while there are
(`repository.ts:8714-8775`):

- QC failures,
- pending human review items,
- reviewer-gate **blockers that hold this filing** (a structural finding does not hold the NEM
  track: `scopeHoldsTrack`, `repository.ts:8702-8705`),
- required documents not attached (the message names each one and its fix).

Fix the data, re-save, and the chain runs again.

## 3. The legality check before you file

The owner keeps one human review in the NEM path, for the legality of a bot submission on a
government or utility portal. In practice it is two things:

1. **The gate is clear** for the NEM track (section 2), and
2. **you have read the project**: the homeowner, the address, the account and meter numbers
   against the bill, the system size and equipment against the plan set.

Your approval in the next step is recorded under your name in the audit log
(`portal.final_submit_approved`, `repository.ts:7593-7595`). It is the record that a person
authorized this filing.

## 4. File it: Approve & auto-submit (the primary path)

Open the project's **3 · Submit** stage. The utility group shows the NEM track card. Click
**Approve & auto-submit** on that card (`frontend/dashboard.js:5094`) and confirm the dialog
(`dashboard.js:5185`).

What happens, in one run (`prepare-submission` with `autoSubmit: true`,
`backend/src/server.ts:3218-3251`):

1. Your approval of **this run** is recorded with your name. It is claimed by id when the run
   starts, used once, and spent if any gate refuses (`repository.ts:7579-7621`).
2. The bot signs in with the client's saved portal login, replays the utility's recorded recipe,
   fills the application from the project, uploads the documents, and stops at the portal's
   review page.
3. At the review page it asks the one gate (`automaticSubmitRefusals`, `repository.ts:7666-7703`;
   `mayClickFinalSubmit`, `shared/src/portalSafety.ts:2458-2483`). It clicks the portal's
   application submit only when **all** of these hold:
   - a named person approved this run (you, in step 1),
   - the server has `PORTAL_ALLOW_FINAL_SUBMIT=1`,
   - the utility's recipe is **complete** and was recorded through the submit (one flagged final
     submit step, last),
   - the recipe was learned for this utility, not borrowed from another,
   - every upload the recipe records happened in this run and the portal's attachment list
     showed it (`portal-bot/src/adapters/recipeAdapter.ts:7219-7241`),
   - no reviewer blocker you saw when you approved has since been cleared by an automated
     verdict; if one has, approve again (`repository.ts:8724-8736`).
4. After the click it reads the page. A confirmed filing sets the project to **submitted**,
   writes the record number and link onto the card when it reads them, and the tracking starts
   (`repository.ts:9995-10062`). A click the portal did not confirm is recorded as
   **submitted, unconfirmed** (`derivePortalRunOutcome`, `repository.ts:7525-7552`): check the
   portal before anything else. The tool will refuse to stage that track again either way
   (duplicate guard, `repository.ts:8527-8618`).

If any condition fails, the run does **not** click. It stops at the review page like a Stage run
(section 5), and the audit log has a `portal.auto_submit_declined` row listing each reason
(`repository.ts:9043-9047`). Open **Audit Log** at the bottom of the project to read it.

Two things to know about this button today:

- **With sign-in off, it never files** (#422). The server takes the approver from the signed-in
  user, and with `AUTH_ENABLED` off it expects a name from the dashboard, which the card does
  not send yet (`server.ts:3238-3251`). The run stages to review, and the toast does not say the
  approval was missing. On an install with sign-in on, your account is the approver and this
  works. Until #422 lands, file on an install with sign-in on.
- **Only on a fresh filing.** It starts its own run from the start of the application. If the
  NEM track already has a draft on the portal (an earlier Stage, or a PSE Part 1), the run finds
  that draft and stops, or continues it without a recipe, and then a person clicks submit
  (`recipeAdapter.ts:1325-1349`, `repository.ts:9031-9038`; #435). Finish such a filing through
  the hand-over (section 5).

**The other Approve button.** The left rail has **Approve & Submit** next to **Stage portals ·
Autopilot**. On a real portal it records an approval and never clicks: you still file by hand
(`backend/src/autopilot.ts:847-879`, #423). Use the track card's button to file.

## 5. The fallback: Stage, and the review page is yours

Use this when the run in section 4 stopped short, when the utility's recipe is not yet recorded
through submit, when you want to look before filing, or on a headless install where the hand-over
works differently (below).

1. Click **Stage in portal** on the NEM track card (`dashboard.js:5093`). The bot replays the
   recipe if the utility has a complete one; otherwise the learner fills the portal for the first
   time and records a recipe as it goes (`.env.example`, `PORTAL_AUTOSEED`). Either way it stops
   at the review page and never clicks the final submit.
2. **On a headed desktop install** (`PORTAL_HEADLESS=false`) the browser window is left open at
   the review page for you (`portal-bot/src/index.ts:613`). Read the **Before you submit on the
   portal** banner in the rail, if it shows: it lists what the bot could not finish there
   (`frontend/dashboard.html:461-464`). Check every field against the project, then click the
   portal's own submit in that window.
3. Fees are a person's. The watch on that window holds back payment requests (rule 1); if the
   run reports your click **held** with a payment, pay on the portal in your own browser and
   capture the number.
4. **On a headless install** no window is left: the browser closes, and the application stays as
   an unsubmitted draft on the client's utility account (`index.ts:613` keeps a window only on a
   headed run). Sign in to the portal yourself with the client's login, open
   that draft, check it and submit it.

What the run reports about your click. The window is watched from the moment the bot hands it
over (#378, `recipeAdapter.ts` `humanClickVerdict` ~1600-1637 and its report ~1643-1690). If you
submit while the run is still finishing, its message says one of the following. If you submit
after it has reported, nothing more is said; the number is read from the completion page when it
can be (below).

| The run says | What it means | What you do |
|---|---|---|
| **filed** ("you submitted from the review window…") | your submit went and the completion page was read | check the card has the number; if not, enter it (below) |
| **draft** ("…created draft N… NOTHING WAS FILED") | that submit only made a draft (PSE Part 1) | stage the track again; the next run opens that draft |
| **stands** ("…a request of yours went…, but no completion page was read") | the filing may have gone | check the portal before clicking again |
| **held** ("…was held back") | the request was stopped by the safety watch (a payment, or a request it does not allow); the submit was not sent | check the portal before clicking again |
| **unconfirmed** ("…the run saw no request go from that click") | nothing seen leaving the page | check the portal before anything else |
| follow-up **held** on an error page | the submit went, the next page's request was held | check the portal; go Back and submit again only if the application is not there |

When the completion page gives a record number it reads confidently, the number and link are
recorded on the project through the same door as the manual form (`repository.ts:9108-9150`).

**The manual door.** If the card does not show the number, open **I submitted it → capture #**
on the NEM track card (`dashboard.js:5109`), fill **Interconnection / case #**, **Confirmation /
PTO #** and **Public status URL** if there is one (`backend/src/submittalTracks.ts:707-713`), and
click **Save & track**.

## 6. PSE (Puget Sound Energy): two parts and a homeowner signature

PSE's PowerClerk flow is not one form (#305). What the tool does today:

- **Part 1** (application date and type). Its Submit only creates a draft (for example
  "Your draft application NEM-… has been created"). Automation may click that one Submit only
  under the server's own stamp for that step, and only if the page after it reads as a draft
  created; otherwise the run stops and the stamp is removed (CLAUDE.md rule 1 carve-out,
  `portal-bot/src/draftSubmitGate.ts`, `backend/src/portalDraft.ts`). That click is never a filing.
- **Part 2**. Stage the track again: the learner opens the draft's Part 2 and fills it. At the
  signature step the card offers **Approve & request signatures** (your name, then the bot
  clicks Request Signatures once; the utility emails the homeowner a DocuSign request) or
  **I sent the signature request** if you clicked it yourself (`dashboard.js:5095-5100`,
  `5189-5216`). Then **Check signature now** reads whether the homeowner signed
  (`dashboard.js:5101-5103`).
- **The final Submit of Part 2 is always a person's.** When the homeowner has signed, the run
  stages step 5 up to its Submit and stops there. A run that continues a draft has no recipe for
  the gate to judge, so Approve & auto-submit does not file it (`repository.ts:9031-9038`).

#305 (the full Part 2 flow) and #309 (PSE's knowledge-base record) are open. Treat every PSE
filing as supervised: the owner or a lead watches.

## 7. Tracking the filing

The NEM filing appears in **4 · Track Approvals → Permit & NEM Checkup** as a card
(`frontend/dashboard.html:883-928`, `dashboard.js:7462-7511`). It shows the application number,
the status link, what the portal last said and when the next check runs.

- **When checks run.** A background sweep runs every `MONITOR_INTERVAL_MINUTES` (default 15) and
  reads each filing that is due. An open filing is due at most a day after its last read; an
  approved one keeps its own cadence (`backend/src/permitMonitor.ts:697-707`). The **NEM checks**
  button in the top menu runs only the checks that are already due, so a click often checks
  nothing (#160).
- **Why a card can read nothing.** The read needs an application or permit number, then either
  a status link or the utility's recipe and the client's saved login; a PowerClerk project page
  sits behind a login (`repository.ts:7310-7395`). A read that gathers nothing is not recorded as
  a status on a filing whose status is already known (`permitMonitor.ts:677-694`). Filings made
  before the October fixes often have no link at all (#413).
- **Edit / Record status.** Each card has **Edit** (portal URL, status link, numbers, whether to
  keep checking) and **Record status** (pick what the utility says now, or type it)
  (`dashboard.js:7462-7511`; #411, merged in #415). Use Record status when you learn the status
  from an email or a call.

## 8. Portal logins (credentials)

The bot signs in to the utility portal with the **client's** login. Two ways to put it in:

- **On the project**: **Portal logins → Manage logins** (`frontend/dashboard.html:345-349`). The
  project needs a submitting client first (`dashboard.js:9968-9974`). Logins are stored
  encrypted.
- **From the client**: in the client's record, create a one-time secure login request; the link
  is valid for 72 hours and the client types the login themselves (`dashboard.js:11183-11203`,
  `backend/src/server.ts:891-904`). See `docs/ONBOARDING.md` §5.

Two utilities' PowerClerk portals are built in: **PacifiCorp (Pacific Power / Rocky Mountain
Power)** at `pacificorpnetmetering.powerclerk.com` and **Portland General Electric** at
`pgenm.powerclerk.com` (`backend/src/utilityIdentity.ts:150-154`). For any other utility, the
first stage researches where it takes interconnection applications (this needs the model key on
the server); a portal it cannot confirm for the NEM track is refused, and the card reads the
portal as unknown (`repository.ts:8932-8997`). Ask the owner before filing for a new utility.

**MFA on the client's account.** The bot never answers MFA. A run that meets it stops with
nothing staged; on a headed desktop the window stays open for you to complete it, then stage
again (`repository.ts:7517-7523`, `index.ts:618`).

## When to stop and ask

Every way a run can end without a filing, and your next action. The run's message on the
project, and the project's **Audit Log**, carry the details.

| The run says (cause) | Where it comes from | Your next action |
|---|---|---|
| staged to final review, and you used Approve & auto-submit | gate refused; reasons in `portal.auto_submit_declined` (`repository.ts:9043-9047`) | read the reasons; finish through the hand-over (section 5). With sign-in off this is #422. |
| staging blocked: QC failures, review items, reviewer blockers | `repository.ts:8714-8723` | fix the data or clear the item; re-save |
| staging blocked: required document(s) not attached | `repository.ts:8772-8776` | attach or split the named document |
| missing portal fields (account, meter, sizes…) | `validatePortalFields`, `repository.ts:7831-7866` | add them from the bill; stage again |
| no submitting client / no CCB number | `repository.ts:8793-8801` | set the client; add its licence |
| a run is still running on this track | `repository.ts:8594-8601` | wait for it |
| the track is already filed as … | duplicate guard, `repository.ts:8603-8611` | nothing to stage; check the card |
| this address already has an unsubmitted draft on the portal | `recipeAdapter.ts:1335-1349` | stage again and the next run continues it, stopping before Submit for a person; or finish it on the portal yourself and capture the number (#435) |
| paused: verification challenge (MFA/CAPTCHA), nothing staged | `pausedRunSentence`, `repository.ts:7517-7523` | complete it in the open window (headed), then stage again; headless: file by hand |
| paused: fee payment | `recipeAdapter.ts:7303-7387` | a person pays and submits on the portal, then captures the number |
| paused: e-signature, client has no authorized signer | `recipeAdapter.ts:2790-2796` | add the authorized signer to the client; stage again |
| paused: drawn signature | `portal-bot/src/adapters/autoLearnAdapter.ts:6566` | sign in the open window, then review and submit |
| paused: required field with no project value | `recipeAdapter.ts:9610-9626` | add the value to the project; stage again |
| paused: kVA tier could not be decided | `recipeAdapter.ts:2884-2892` | tick the tier box in the window, or add the AC size and stage again |
| stopped before the review page | `recipeAdapter.ts:3655-3666` | read where it stopped; finish in the window or ask |
| draft submit read as something other than a draft | `recipeAdapter.ts:2829-2838` | stop; tell the owner (the stamp has been removed) |
| portal paused (legal kill-switch) | `repository.ts:9414-9417` | submit by hand; ask the owner before resuming |
| the recipe points at the wrong portal / another utility's portal | `repository.ts:9426-9458` | ask the owner; nothing was opened |
| submitted, unconfirmed | `repository.ts:7525-7552` | check the portal before anything else; never re-click |
| run FAILED before review | `repository.ts:10013-10015` | read the reason; ask before staging again (each attempt can leave a draft) |

When in doubt, stop. A draft left on a client's account is cheap; a second filing is not. The
list of drafts the tool has left on real accounts is `npx tsx scripts/draft-ledger.ts`
(`docs/ONBOARDING.md` appendix).

---

## Before the first filing: install requirements

For whoever runs the install. Do these once, before the team files.

1. **Re-pin onto current `main`** (`docs/OPERATIONS.md` §7.1, "Launch re-pin"). The October NEM
   fixes (#378, #354, #400, #401, #385, #387, #343, #414, #415, #419) are only on the install
   after it.
2. **Turn sign-in on** (`AUTH_ENABLED=true`, `docs/OPERATIONS.md` §4.1). Each operator gets an
   account; the signed-in user is the approver of record (`server.ts:3240-3244`). With sign-in off
   Approve & auto-submit cannot file (#422), and preflight fails the approval switch
   (`docs/OPERATIONS.md` §4.3).
3. **Set `PORTAL_ALLOW_FINAL_SUBMIT=1`** in `.env` (`.env.example`). The switch alone files
   nothing: it is one of the conditions in section 4.
4. **Choose headed or headless.**
   - **Office desktop** (`PORTAL_HEADLESS=false`): the review window is left open for the
     hand-over, and an MFA or signature pause keeps its window (`index.ts:613-618`). Someone has
     to be at that desktop to use it (`docs/OPERATIONS.md` §2.3).
   - **Shared server** (headless, the default when `PORTAL_HEADLESS` is not `false`,
     `portal-bot/src/browser.ts:211-219`): no window. Approve & auto-submit is the path; every
     fallback is a person signing in to the portal in their own browser.
5. **Recipes.** Run `scripts/restore-demoted-recipes.ts --apply` after the re-pin, then one
   supervised PacifiCorp replay with the owner watching (`docs/OPERATIONS.md` §7.1). PGE replays
   stop on its welcome page until #403 lands, and its learner skipped a required page (#410). The
   end-to-end proof on the install is #427.
