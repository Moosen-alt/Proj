// THE DEVHUB-SHAPED FIXTURE shared by informationInterstitial.dom.smoke and postFormOnLoad.dom.smoke
// (#344): the captured Portland DevHub markup, scrubbed (see informationInterstitial.dom.smoke's
// header), and the prefilled-form → summary-page shapes. Markup only — each smoke runs its own server.
export const ACCOUNT = "Placeholder Solar Co";
export const SOLAR = "Solar Permit Request";
export const ADDRESS = "1 Test St";

/** The interstitial's own words, as captured (the one paragraph the page carries). */
export const PERMITTING_INFORMATION = `<div id="div_d_1685049573550" class="group">
	<div class="row"><div class="col-flex offset-md-0 col-md-12"><div id="div_d_1685049573552" class="pt-3 form-group static-text">
	<div class="d-flex label-group">
<label id="lbl_d_1685049573552" class="control-label" data-toggle="tooltip" data-bs-original-title="" title="">
	<span>This is a permit request only.</span>
	</label>
</div>
A Permit Tech will review your submission for minimum submittal standards, and if met, a permit will be created. Once your permit has been deemed complete for intake, you will be provided with instructions via email for how to pay your intake fees. If minimum submittal standards are not met, you will be provided with a list of the required information via DevHub. If you already have the information you need to apply, scroll to the bottom of the page and click "Continue".&nbsp;Please do not submit additional requests for the same scope of work as this will only further delay the review of your project.</div>
</div></div></div>`;

/** One tile, as captured on the Apply page (#315). */
export const card = (id: string, title: string, body: string): string => `
<div id="${id}" class="card-h card-l card">
<div class="card-body">
	<div class="card-title">${title}</div>
	<div class="card-text">${body}</div>
</div>
<div class="card-next"><i class="fa fa-chevron-right"></i></div>
</div>`;
export const APPLY_TILES = [
  card("div_d_1683576453192", "Building Permit Request", "Residential additions, alterations, demolition."),
  card("div_d_1683576453204", SOLAR, "Solar Permit Requests for Residential or Commercial Projects."),
  card("div_d_1683576453207", "Trade Permits", "Electrical, Mechanical and Plumbing."),
  card("div_d_1683576453209", "Sign Permit Request", "Sign permits."),
].join("");
export const HOME_TILES = [
  card("div_h_1", "My Permits &amp; Requests", "See the permits and requests you have filed."),
  card("div_h_2", "Apply For A Permit", "Start a new permit request."),
  card("div_h_3", "View or Pay Fees", "Fees due on your permits."),
].join("");

/** The click delegation the live page binds in script: the CARD navigates. */
export const delegation = (map: string): string => `<script>
document.getElementById('sgControls').addEventListener('click', function (e) {
  var card = e.target.closest('.card');
  if (!card) return;
  var title = card.querySelector('.card-title').textContent.replace(/\\s+/g, ' ').trim();
  location.href = (${map})(title);
});
</script>`;

/** The sidebar every DevHub page carries — its links all point at this server. */
export const sidebar = (p: string): string => `<div class="col left-section no-print"><nav class="navbar navbar-expand-md navbar-light left-menu" role="navigation">
 <button class="navbar-toggler always-enabled" type="button" aria-controls="leftMenuNav" aria-expanded="false" aria-label="Toggle navigation"><span class="navbar-toggler-icon"></span></button>
 <div class="collapse navbar-collapse" id="leftMenuNav"><ul>
  <li class="title">Portal Fixture</li>
  <li class="item"><a href="${p}/home">DevHub Home</a></li>
  <li class="item"><a href="${p}/profile">My Profile</a></li>
  <li class="item"><a href="${p}/my-permits">My Permits &amp; Requests</a></li>
  <li class="item"><a href="${p}/apply">Apply For A Permit</a></li>
  <li class="item"><a href="${p}/fees">View or Pay Fees</a></li>
  <li class="item"><a href="${p}/corrections">Upload Corrections</a></li>
  <li class="item"><a href="${p}/help">Help and FAQs</a></li>
 </ul></div></nav></div>`;

/** The DevHub shell, as captured: signed-in menu (name scrubbed), breadcrumb, sidebar, the
 *  SmartGuide form (method/action per scenario), its #navigation bar, a footer. */
export const shell = (p: string, o: { title: string; content: string; nav?: string; method?: string; action?: string; script?: string }): string => `<!doctype html><html><head><meta charset="utf-8"><title>Development Hub Fixture</title>
<style>body{font:14px sans-serif;margin:0} .row{display:flex} .left-section{width:200px} .right-section{flex:1}
.card{display:flex;border:1px solid #ccc;margin:8px 0;padding:8px;min-height:60px} .card-body{flex:1} .card-next{width:32px}
#navigation{display:flex;gap:12px;margin:16px 0}</style>
</head><body class="">
<div id="top-header"><div class="container-xxl d-flex">
	<a href="${p}/home"><img id="top-header-logo" alt="City seal"></a>
	<div id="signin-menu" class="ms-auto">
	<button id="signedin-menu-btn" type="button" class="dropdown-toggle" data-bs-toggle="dropdown" aria-expanded="false"><i class="bi bi-person-fill"></i><div>${ACCOUNT}</div></button>
		<ul class="dropdown-menu" aria-labelledby="userMenuButton" style="display:none">
			<li><a class="dropdown-item" href="${p}/profile">My Profile</a></li>
			<li><a class="dropdown-item" href="#" onclick="return false">Sign Out</a></li>
		</ul>
	</div>
</div></div>
<div id="sec-header"><h1>Development Hub Fixture</h1><h2>Online License &amp; Permit Services</h2></div>
<div id="breadcrumb"><nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="${p}/home">Home</a></li><li class="breadcrumb-item"><a href="${p}/apply">Apply For A Permit</a></li></ol></nav></div>
<div id="main-content"><form id="smartguide_ApplyForAPermit" action="${o.action ?? `${p}/sg`}" method="${o.method ?? "POST"}" class="form-content smartguide_form" accept-charset="UTF-8">
<div class="row">
 ${sidebar(p)}
 <div class="col-md-10 right-section"><div id="page-content">
  <div class="page-title auto-title">${o.title}</div>
  <div id="sgControls"><div class="row"><div class="col-flex col-md-12">${o.content}</div></div></div>
  <div id="navigation" class="d-flex ">${o.nav ?? ""}</div>
 </div></div>
</div></form></div>
<footer id="bottom-footer" role="contentinfo">
  <p>The City ensures meaningful access to City programs, services, and activities. To request these services, contact <a href="tel:503-000-0000">503-000-0000</a> or TTY via Relay Service: <a href="tel:711">711</a>.</p>
  <ul class="menu"><li><a href="${p}/ada">ADA Accommodation</a></li><li><a href="${p}/privacy">Privacy policy</a></li><li><a href="${p}/about">About this Website</a></li></ul>
</footer>
${o.script ?? ""}
</body></html>`;

/** DevHub's navigation bar, as captured: two submit buttons named by the step. */
export const PREV_NEXT = `<button type="submit" name="t_p1685049573549" class="btn btn-primary">Previous</button><button type="submit" name="t_n1685049573549" class="btn btn-primary ms-auto ">Next</button>`;

export const homePage = (p: string): string => shell(p, {
  title: "Welcome", content: HOME_TILES,
  script: delegation(`function (t) { return ({'Apply For A Permit':'${p}/apply','My Permits & Requests':'${p}/my-permits','View or Pay Fees':'${p}/fees'})[t] || '${p}/unknown'; }`),
});
/** The Apply page's tiles; the Solar tile leads to `${p}${target}`. */
export const applyPageTo = (p: string, target: string): string => shell(p, {
  title: "Apply for a Permit", content: APPLY_TILES,
  script: delegation(`function (t) { return t === '${SOLAR}' ? '${p}${target}' : '${p}/other-type'; }`),
});

export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c] as string);

/** A summary page after the prefilled form: its heading, its prose, the entered data, Previous +
 *  the forward-worded control that FILES (to `${p}/file`). `onLoadPost`: a path the page POSTs to by
 *  itself on load (a non-filing, non-payment URL — shape m6). */
export interface Shape { what: string; method: "GET" | "POST"; heading: string; prose: string; control: string; late?: boolean; plannerAdvances?: boolean; onLoadPost?: string }
export const prefilledFormPage = (p: string): string => shell(p, {
  title: "Project Information", method: "GET", action: `${p}/to-step3`,
  content: `<div class="form-group"><label for="addr" class="control-label">Site Address</label><input id="addr" name="addr" type="text" value="${ADDRESS}"></div>`,
  nav: PREV_NEXT,
});
export const shapeStep3 = (p: string, s: Shape): string => shell(p, {
  title: s.late ? "" : s.heading, method: s.method, action: `${p}/file`,
  content: `<h2 id="rh"></h2><p>${s.prose}</p>
    <dl class="summary"><dt>Permit Type</dt><dd>${SOLAR}</dd><dt>Site Address</dt><dd>${ADDRESS}</dd></dl>`,
  nav: `<button type="submit" name="prev" formaction="${p}/back" formmethod="get" class="btn btn-primary">Previous</button><button type="submit" name="next" class="btn btn-primary ms-auto">${s.control}</button>`,
  script: (s.late ? `<script>setTimeout(function () { document.getElementById('rh').textContent = ${JSON.stringify(s.heading)}; }, 300);</script>` : "")
    + (s.onLoadPost ? `<script>fetch(${JSON.stringify(`${p}${s.onLoadPost}`)}, { method: "POST", body: "autosave=1" }).catch(function () {});</script>` : ""),
});
