// ---------------------------------------------------------------------------------------------
// READ EVERY SIGNATURE STATUS A PAGE SHOWS (#310: resume after the homeowner signs).
//
// PSE's PowerClerk record page (the draft's own page, the one its "NEM-…" link opens) carries the
// DocuSign status of the application beside its own status ("Application Draft"). The resume reads
// the first, never the second, and hands the list to shared/src/signatureCompletion, which decides.
// Read-only: nothing here clicks, types or navigates.
//
// What counts as a signature status, and only inside a signature context (a heading, legend, card
// header or label that speaks of a signature, a signer, DocuSign, eSign or an envelope):
//   - a "<…signature…> Status: value" line, anywhere on the page;
//   - inside a block headed by a signature word, each "Status: value" line;
//   - a table whose header has a Status column, when the table or its heading is a signature one:
//     every row's Status cell (one per signer).
// The application's own status ("Application Status: Application Draft", "Status: Unsubmitted") is
// never one: its label names the application, or it sits outside every signature block.
// ---------------------------------------------------------------------------------------------

// Plain JS, no named inner functions (tsx's __name helper does not exist in the page).
export const READ_SIGNATURE_STATUSES_IN_PAGE = `(() => {
  var squash = function (s) { return String(s || "").replace(/\\s+/g, " ").trim(); };
  var SIG = /\\b(signatures?|signers?|signing|docusign|e-?sign(?:ature)?|envelope)\\b/i;
  var APP = /\\b(application|permit|project|record|draft|unsubmitted|form|program)\\b/i;
  var out = [];
  var push = function (v) { v = squash(v).slice(0, 80); if (v && out.indexOf(v) < 0 && out.length < 12) out.push(v); };
  var statusLine = /^(.*?)\\bstatus\\b\\s*[:\\-–—]?\\s*(.*)$/i;
  var body = document.body;
  if (!body) return out;
  // 1) "<signature words> Status: value" anywhere.
  var lines = String(body.innerText || "").split(/\\n+/);
  for (var i = 0; i < lines.length; i++) {
    if (/\\t/.test(lines[i])) continue; // a table row: read by column below
    var m = lines[i].match(statusLine);
    if (!m) continue;
    var label = squash(m[1]);
    if (!SIG.test(label)) continue;
    push(squash(m[2]) || squash(lines[i + 1] || ""));
  }
  // 2) blocks headed by a signature word: their "Status: value" lines.
  var heads = document.querySelectorAll("legend, h1, h2, h3, h4, h5, h6, caption, .card-header, .panel-heading, .panel-title, [role=heading]");
  for (var h = 0; h < heads.length; h++) {
    var ht = squash(heads[h].textContent);
    if (!SIG.test(ht) || ht.length > 120) continue;
    var block = heads[h].closest("fieldset, section, .card, .panel, [role=group], [role=region], table") || heads[h].parentElement;
    if (!block || block === body) continue;
    var bl = String(block.innerText || "").split(/\\n+/);
    for (var j = 0; j < bl.length; j++) {
      if (/\\t/.test(bl[j])) continue;
      var bm = bl[j].match(statusLine);
      if (!bm) continue;
      var blabel = squash(bm[1]);
      if (blabel && APP.test(blabel)) continue;
      var bv = squash(bm[2]) || squash(bl[j + 1] || "");
      if (/^of\\s+(your|the|this)\\s+/i.test(bv)) continue;
      push(bv);
    }
  }
  // 3) signature tables: each row's Status cell.
  var tables = document.querySelectorAll("table");
  for (var t = 0; t < tables.length; t++) {
    var tb = tables[t];
    var trs = tb.querySelectorAll("tr");
    if (trs.length < 2) continue;
    var hcells = trs[0].querySelectorAll("th, td");
    var col = -1, labels = [];
    for (var c = 0; c < hcells.length; c++) {
      var hc = squash(hcells[c].textContent);
      labels.push(hc);
      if (/^(signature\\s+|signer\\s+|envelope\\s+|docusign\\s+|e-?sign(?:ature)?\\s+)?status$/i.test(hc)) col = c;
    }
    if (col < 0) continue;
    var ctx = labels.join(" ");
    var cap = tb.querySelector("caption");
    if (cap) ctx += " " + squash(cap.textContent);
    var holder = tb.closest("fieldset, section, .card, .panel, [role=group], [role=region]");
    if (holder) { var hd = holder.querySelector("legend, h1, h2, h3, h4, h5, h6, .card-header, .panel-heading, .panel-title, [role=heading]"); if (hd) ctx += " " + squash(hd.textContent); }
    var prev = tb.previousElementSibling;
    if (prev && /^H[1-6]$/.test(prev.tagName)) ctx += " " + squash(prev.textContent);
    if (!SIG.test(ctx)) continue;
    for (var r = 1; r < trs.length; r++) {
      var cells = trs[r].querySelectorAll("td, th");
      if (cells[col]) push(cells[col].textContent);
    }
  }
  return out;
})()`;

/** Every signature status the current page shows (see above). [] when none can be read. */
export async function readSignatureStatuses(page: unknown): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  if (!p || typeof p.evaluate !== "function") return [];
  const read = await p.evaluate(READ_SIGNATURE_STATUSES_IN_PAGE).catch(() => null);
  return Array.isArray(read) ? read.map((x: unknown) => String(x ?? "")).filter(Boolean) : [];
}

/** What a resume read about the homeowner's signature (#310), carried on the learn result. */
export interface SignatureCheck {
  /** signed: every status read signed (the walk went on to step 5); not_requested: no request was
   *  ever sent (the walk staged the signature step again); awaiting_customer_signature: requested and
   *  not signed, or unreadable — the walk stopped and names why. */
  state: "signed" | "not_requested" | "awaiting_customer_signature";
  reading: import("../../../shared/src/signatureCompletion").SignatureCompletionReading;
  statuses: string[];
  /** Where the deciding read was made. */
  where: "record" | "signature step";
  why: string;
}
