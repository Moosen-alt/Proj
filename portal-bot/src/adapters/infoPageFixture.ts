// A SCRUBBED DEVHUB-LIKE "PERMITTING INFORMATION" REPLICA for the information-page pass smokes
// (#344, option B). Synthetic: the signed-in company is "Placeholder Solar Co", every link points
// at the smoke's own server, no live page is fetched. The markup follows the captured page's shape
// (a toggle in a plain top-header div, h1/h2 site chrome, a breadcrumb nav, ONE multipart SmartGuide
// form posting to its own path "sfjsp" that wraps the sidebar and the step, Previous / Next as named
// submit buttons, a footer) so the pass is exercised on what it has to pass in production.
//
// Also the test-only builder of a verified entry from a live page (entryFromLivePage): the product
// builds a pass only from a candidate the bot recorded (verifiedInfoPageFromCandidate); the smokes
// also need entries the product can never produce (a page whose prefix carries an answer, a
// near-miss with one component off) to prove every other door holds.
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../../shared/src/portalSafety";
import {
  digestInfoPageIdentity, infoPagePrefixOf, verifiedInfoPageFromCandidate,
  type InfoPageIdentityReading, type InfoPageRunState, type InfoPageRunStep,
} from "../../../shared/src/infoPagePass";
import type { VerifiedInfoPage } from "../../../shared/src/types";

export const ACCOUNT = "Placeholder Solar Co";
export const NEXT_NAME = "t_n1685049573549";
export const PREV_NAME = "t_p1685049573549";

/** The step's own words, as captured (one paragraph). */
export const PERMITTING_INFORMATION = `<div id="div_d_1685049573550" class="group">
	<div class="row"><div class="col-flex offset-md-0 col-md-12"><div id="div_d_1685049573552" class="pt-3 form-group static-text">
	<div class="d-flex label-group">
<label id="lbl_d_1685049573552" class="control-label" data-toggle="tooltip" data-bs-original-title="" title="">
	<span>This is a permit request only.</span>
	</label>
</div>
A Permit Tech will review your submission for minimum submittal standards, and if met, a permit will be created. Once your permit has been deemed complete for intake, you will be provided with instructions via email for how to pay your intake fees. If minimum submittal standards are not met, you will be provided with a list of the required information via DevHub. If you already have the information you need to apply, scroll to the bottom of the page and click "Continue".&nbsp;Please do not submit additional requests for the same scope of work as this will only further delay the review of your project.</div>
</div></div></div>`;

export const PREV_NEXT = `<button type="submit" name="${PREV_NAME}" class="btn btn-primary">Previous</button><button type="submit" name="${NEXT_NAME}" class="btn btn-primary ms-auto ">Next</button>`;

export const replicaSidebar = (p: string): string => `<div class="col left-section no-print"><nav class="navbar navbar-expand-md navbar-light left-menu" role="navigation">
 <button class="navbar-toggler always-enabled" type="button" aria-controls="leftMenuNav" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button>
 <div class="collapse navbar-collapse" id="leftMenuNav"><ul>
  <li class="title">Portal Fixture</li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=Home">DevHub Home</a></li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=MyProfile">My Profile</a></li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=MyPermits">My Permits &amp; Requests</a></li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=ApplyForAPermit">Apply For A Permit</a></li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=SelectAPermit&amp;Type=ViewOrPayFees">View or Pay Fees</a></li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=SelectAPermit&amp;Type=UploadCorrections">Upload Corrections</a></li>
  <li class="item"><a href="${p}/permits/sfjsp?interviewID=HelpAndFAQs">Help and FAQs</a></li>
 </ul></div></nav></div>`;

export interface ReplicaOpts {
  /** The scenario's path prefix (every link and the form's own path stay under it). */
  p: string;
  title?: string;
  content?: string;
  nav?: string;
  method?: string;
  /** "" = no enctype attribute (urlencoded). Default multipart. */
  enctype?: string;
  /** Default "sfjsp" — relative, the page's own path, as live. */
  action?: string;
  target?: string;
  /** Inside the form, after the step content. */
  formExtra?: string;
  /** In the body, outside the form (before the footer). */
  outsideForm?: string;
  /** The signed-in toggle's label. */
  toggleLabel?: string;
  /** Put the toggle inside a <header> landmark (the one place the tenant mask applies). */
  toggleInHeader?: boolean;
  h1?: string;
  script?: string;
  headExtra?: string;
}

/** The DevHub-like page. With no options it is the information page whose Next a person verifies. */
export const devhubReplica = (o: ReplicaOpts): string => {
  const p = o.p;
  const toggle = `<div id="signin-menu" class="ms-auto">
	<button id="signedin-menu-btn" type="button" class="dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-person-fill"></i><div>${o.toggleLabel ?? ACCOUNT}</div></button>
		<ul class="dropdown-menu" aria-labelledby="userMenuButton" style="display:none">
			<li><a class="dropdown-item" href="${p}/permits/sfjsp?interviewID=MyProfile">My Profile</a></li>
			<li><a class="dropdown-item" href="#" onclick="return false">Sign Out</a></li>
		</ul>
	</div>`;
  const top = o.toggleInHeader
    ? `<header id="top-header"><div class="container-xxl d-flex"><a href="${p}/permits/sfjsp?interviewID=Home"><img id="top-header-logo" alt="City seal"></a>${toggle}</div></header>`
    : `<div id="top-header"><div class="container-xxl d-flex"><a href="${p}/permits/sfjsp?interviewID=Home"><img id="top-header-logo" alt="City seal"></a>${toggle}</div></div>`;
  const enctype = o.enctype === undefined ? "multipart/form-data" : o.enctype;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
<style>body{font:14px sans-serif;margin:0} .row{display:flex} .left-section{width:200px} .right-section{flex:1}
#navigation{display:flex;gap:12px;margin:16px 0}</style>${o.headExtra ?? ""}
</head><body class="">
${top}
<div id="sec-header"><h1>${o.h1 ?? "Development Hub Fixture"}</h1><h2>Online License &amp; Permit Services</h2></div>
<div id="breadcrumb"><nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="${p}/permits/sfjsp?interviewID=Home">Home</a></li><li class="breadcrumb-item"><a href="${p}/permits/sfjsp?interviewID=ApplyForAPermit">Apply For A Permit</a></li></ol></nav></div>
<div id="main-content"><form id="smartguide_ApplyForAPermit" action="${o.action ?? "sfjsp"}" method="${o.method ?? "POST"}"${enctype ? ` enctype="${enctype}"` : ""}${o.target ? ` target="${o.target}"` : ""} class="form-content smartguide_form" accept-charset="UTF-8">
<div class="row">
 ${replicaSidebar(p)}
 <div class="col-md-10 right-section"><div id="page-content">
  <div class="page-title auto-title">${o.title ?? "Permitting Information"}</div>
  <div id="sgControls"><div class="row"><div class="col-flex col-md-12">${o.content ?? PERMITTING_INFORMATION}</div></div></div>
  ${o.formExtra ?? ""}
  <div id="navigation" class="d-flex ">${o.nav ?? PREV_NEXT}</div>
 </div></div>
</div></form></div>
${o.outsideForm ?? ""}
<footer id="bottom-footer" role="contentinfo">
  <p>The City ensures meaningful access to City programs, services, and activities. To request these services, contact <a href="tel:503-000-0000">503-000-0000</a> or TTY via Relay Service: <a href="tel:711">711</a>.</p>
  <ul class="menu"><li><a href="${p}/ada">ADA Accommodation</a></li><li><a href="${p}/privacy">Privacy policy</a></li></ul>
</footer>
${o.script ?? ""}
</body></html>`;
};

/** The names of a multipart (or urlencoded) body, in order, for the smoke's server log. */
export const bodyNamesOf = (contentType: string, body: Buffer): string[] => {
  const ct = String(contentType || "");
  if (/multipart\/form-data/i.test(ct)) return Array.from(body.toString("latin1").matchAll(/name="([^"]*)"/g)).map((m) => m[1]);
  if (/x-www-form-urlencoded/i.test(ct)) return body.toString("utf8").split("&").filter(Boolean).map((kv) => decodeURIComponent(kv.split("=")[0].replace(/\+/g, " ")));
  return [];
};

/** DevHub's recorded prefix in front of the information page (the learner's steps). */
export const devhubPrefix = (startUrl: string, tile = "Solar Permit Request"): InfoPageRunStep[] => [
  { action: "goto", note: "entry url", value: startUrl },
  { action: "click", note: "application entry: Apply For A Permit" },
  { action: "click", note: `permit type: ${tile}` },
];

/** A run that has entered nothing, on that prefix. */
export const cleanRun = (priorSteps: InfoPageRunStep[], patch: Partial<InfoPageRunState> = {}): InfoPageRunState => ({
  priorSteps, formPageSeen: false, continuedDraft: false, draftResume: false, signatureCheck: false, signatureStep: false,
  signatureDone: false, writes: 0, gapFills: 0, priorProgress: false, projectValues: ["1 Test St", "Jordan Testcase"], ...patch,
});

/** TEST-ONLY: read the live page's identity on `selector` and build a verified entry for it with
 *  whatever prefix the test names (the product builds one only from a candidate row). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function entryFromLivePage(page: any, selector: string, prefix: InfoPageRunStep[], id = "pass-test"): Promise<VerifiedInfoPage | null> {
  await page.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
  const r = await page.locator(selector).first().evaluate((el: unknown, g: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ps = (globalThis as any)[g];
    return ps && typeof ps.infoPageIdentityInPage === "function" ? ps.infoPageIdentityInPage(el) : { ok: false, why: "no reader" };
  }, PORTAL_SAFETY_GLOBAL).catch((e: unknown) => ({ ok: false, why: String(e) })) as InfoPageIdentityReading;
  if (!r || r.ok !== true) return null;
  const d = digestInfoPageIdentity(r.material);
  return { id, verifiedAt: "2026-10-15T12:00:00.000Z", ...verifiedInfoPageFromCandidate({ identityVersion: d.version, identitySha256: d.identitySha256, digest: d, prefix: infoPagePrefixOf(prefix) }) };
}

/** The same entry with ONE identity component (and so the identity) off by one hash. */
export const nearMissEntry = (e: VerifiedInfoPage, component: keyof VerifiedInfoPage["components"] = "textSha"): VerifiedInfoPage => {
  const flip = (h: string): string => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
  return { ...e, id: `${e.id}-near-${component}`, components: { ...e.components, [component]: flip(e.components[component]) }, identitySha256: flip(e.identitySha256) };
};
