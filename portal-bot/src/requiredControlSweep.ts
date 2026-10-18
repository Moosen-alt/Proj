// WHAT DID THIS FILING LEAVE BLANK? — the one question replay must never get wrong.
//
// This was a private method inside recipeAdapter, which meant the only way to find out
// whether it worked was to drive a live government portal and look at a screenshot
// afterwards. It did not work, and that is exactly how the failure was found: the first
// live replay benchmark scored PacifiCorp `replayed_clean` — "every recorded step ran and
// nothing was left blank" — on a page that was, in the portal's own red lettering, telling
// us two required fields were missing.
//
// The two misses, both general and neither PacifiCorp's fault:
//
//   1. A COMPLAINT IN A ROW THAT HOLDS MORE THAN ONE CONTROL WAS DISCARDED. The sweep
//      attributed "This field is required." only to a container holding exactly ONE control
//      — a bound added for good reason (a bare div ancestor is the whole page on some
//      layouts, and one complaint then blamed every control on it). But "Qty [18]
//      [Please select...]" is one row with two controls, which is the ordinary shape of
//      every quantity-plus-model row in every equipment table there is. The bound threw the
//      evidence away. Proximity, not container arity, is what ties a message to a field —
//      it is how a person reads the page.
//
//   2. AN ASTERISK OUTSIDE A <label for> WAS INVISIBLE. Requiredness was read from
//      `label[for=id]` only, so "Total System Export (kW) *" rendered as a plain div above
//      its input carried no requirement at all. Captions are written a dozen ways; the
//      asterisk is the marker, wherever it sits.
//
// And a floor under both: A VISIBLE COMPLAINT THE SWEEP CANNOT ATTRIBUTE IS STILL REPORTED.
// Attribution is heuristic and will meet a layout that defeats it. The portal saying "this
// field is required" is not heuristic — it is the portal refusing the filing. Losing that
// because we could not name the field is how an incomplete application reaches a reviewer
// wearing a clean bill of health.
import type { Page } from "playwright";

/** A visible required control that is still empty, named as the page names it. */
export interface EmptyRequired {
  name: string;
  /** How we know it was required — for the operator's report, and for arguing with it. */
  why: "attribute" | "asterisk" | "complaint" | "unattributed-complaint" | "radio-group";
  /**
   * `why: "complaint"` only (#327): one entry per complaint this control was handed. `next` is the
   * next-nearest EMPTY control in range, named exactly as `name` would name it ("" when there is
   * none); `unattributed` is the entry the sweep reports when no field can own the complaint. A
   * caller that discharges this control (a held upload, recipeAdapter.sweepRequired) must not
   * discharge the complaint with it: the portal's refusal is re-attributed or reported unowned.
   */
  handed?: Array<{ next: string; unattributed: string }>;
}

/**
 * Every visible required control still empty on the current page.
 *
 * Deliberately conservative about FALSE positives: a warning that fires on a correctly
 * filled page trains the operator to ignore the warning, which is worse than not having
 * one. Every widening below is paired with a bound, and the smoke drives both directions.
 */
export async function sweepEmptyRequiredControls(
  page: Page,
): Promise<{ empty: EmptyRequired[]; requiredSeen: string[] }> {
  if (!page || typeof page.evaluate !== "function") return { empty: [], requiredSeen: [] };
  const swept = await page.evaluate(() => {
    // TWO GRADES OF COMPLAINT, BECAUSE ONE OF THEM IS ALSO ORDINARY PROSE.
    //
    // "This field is required" is a portal refusing a filing. "Please select an option" is
    // equally often the INSTRUCTION above a group — and portals are full of instructions.
    // Treating the second as evidence manufactures blanks on correct pages, and this sweep
    // now gates two things that must not be jammed: a benchmark verdict, and
    // pageIsPassThrough, which decides whether replay may click on. So the soft phrasings
    // must LOOK like errors — an alert role, an error-ish class, or red text — to count.
    const HARD = /this field is required|required field|field is (mandatory|required)|must be (provided|entered|selected)|cannot be (blank|empty)|is required\b/i;
    const SOFT = /please (select|enter|choose|provide|complete)/i;
    // A LEGEND IS NOT A COMPLAINT. Nearly every form carries one — "All Information
    // indicated with a red * (asterisk) is required" — and it matches `is required` exactly
    // as a real validation message does, while referring to no field at all. Ameren's live
    // run reported that sentence as a blank required field: a fabricated gap, on a page that
    // may have been complete. Legends describe the form's notation; complaints name a
    // failure. The tell is the notation talk.
    const LEGEND = /asterisk|marked with|indicat(e|es|ed|ing)\b|denotes?\b|all information|all fields|fields? marked|red \*|^\s*\*|\*\s*=|means required/i;
    // NOR IS AN ADVISORY NOTE A COMPLAINT. Oregon ePermitting's attachment page carries
    // "Please note: Plan review is required for some services" — prose about the PROCESS, not
    // about any control on the page. It matched `is required`, was reported as a blank
    // required field, and because pageIsPassThrough shares this sweep it also stopped replay
    // clicking through. A sentence that opens by addressing the reader is telling them
    // something, not refusing their filing.
    const ADVISORY = /^\s*(please note|note|notice|important|reminder|attention)\b[:,]?/i;
    const COMPLAINT = new RegExp(`${HARD.source}|${SOFT.source}`, "i");
    const PLACEHOLDER = /^(please\s+)?(select|choose)\b\.{0,3}$/i;
    const out: Array<{ name: string; why: string; handed?: Array<{ next: string; unattributed: string }> }> = [];
    const requiredSeen: string[] = [];
    const tidy = (name: string): string => String(name || "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 70);
    const push = (name: string, why: string, handed?: Array<{ next: string; unattributed: string }>): void => {
      const clean = tidy(name);
      if (clean && !out.some((o) => o.name === clean)) out.push(handed && handed.length ? { name: clean, why, handed } : { name: clean, why });
    };
    const orphanName = (c: HTMLElement): string => tidy(`portal reports "${(c.innerText || "").replace(/\s+/g, " ").trim().slice(0, 48)}" (field could not be identified)`);

    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return !!r && (r.width > 0 || r.height > 0);
    };

    // ---- the controls in play -------------------------------------------------------
    const controls = (Array.from(document.querySelectorAll("input, select, textarea")) as HTMLElement[])
      .filter((el) => {
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (["hidden", "submit", "button", "checkbox", "radio", "image", "reset"].includes(t)) return false;
        return visible(el);
      });

    // A CONCEALED SLIVER IS MEASURED BY ITS WIDGET (#327). A bootstrap-select keeps the native
    // <select> as a 0.5 px, opacity-0 sliver at left:50% of the widget, so its own box puts it
    // half a widget to the right of where a person sees the field: a complaint under the widget's
    // left edge was never "under" it, and lost to whatever sat nearer on the complaint's line. A
    // control that thin, or invisible and small, is measured by the nearest ancestor a person can
    // see (at least 20 x 10 px) — but never by one that holds another visible control, which is a
    // row or a form, not this control's widget.
    const boxOf = (el: HTMLElement): DOMRect => {
      const r = el.getBoundingClientRect();
      const sliver = r.width < 4 || r.height < 4 || (Number(getComputedStyle(el).opacity) === 0 && (r.width < 20 || r.height < 10));
      if (!sliver) return r;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (controls.some((o) => o !== el && p!.contains(o))) break;
        const pr = p.getBoundingClientRect();
        if (pr.width >= 20 && pr.height >= 10) return pr;
      }
      return r;
    };

    // ---- complaint messages, attributed by PROXIMITY --------------------------------
    // Leaf-most matching elements only: an ancestor whose text merely CONTAINS the message
    // is the container, not the message, and using it puts the anchor in the wrong place.
    const complaints = (Array.from(document.querySelectorAll("span, div, p, li, label, strong, em, small, td")) as HTMLElement[])
      .filter((el) => {
        const own = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (!own || own.length > 120 || !COMPLAINT.test(own)) return false;
        if (LEGEND.test(own) || ADVISORY.test(own)) return false;
        if (Array.from(el.children).some((c) => COMPLAINT.test(((c as HTMLElement).innerText || "")))) return false;
        if (!visible(el)) return false;
        if (HARD.test(own)) return true;
        // Soft phrasing: only an element DRESSED as an error counts. Anything else is the
        // page telling a person what to do, not evidence that they failed to do it.
        const marks = `${el.className || ""} ${el.id || ""} ${el.getAttribute("role") || ""} ${el.getAttribute("aria-live") || ""}`;
        if (/error|invalid|danger|warning|alert|validation|required/i.test(marks)) return true;
        const rgb = (getComputedStyle(el).color || "").match(/\d+/g) || [];
        const r = Number(rgb[0] || 0), g = Number(rgb[1] || 0), b = Number(rgb[2] || 0);
        return r > 110 && r > g * 1.6 && r > b * 1.6;
      });

    // IS THIS CONTROL ANSWERED? Needed before attribution, not after — see below.
    const emptyish = new Set<HTMLElement>();
    for (const el of controls) {
      const raw = ((el as HTMLInputElement).value || "").trim();
      const shown = (el.tagName || "").toLowerCase() === "select"
        ? ((((el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex] || {}).textContent) || "").trim()
        : raw;
      if (!raw || PLACEHOLDER.test(shown) || /^--/.test(shown)) emptyish.add(el);
    }

    const claimed = new Set<HTMLElement>();
    // Each complaint a control was handed, with the next-nearest empty control (see `handed`).
    const handedTo = new Map<HTMLElement, Array<{ next: HTMLElement | null; unattributed: string }>>();
    for (const c of complaints) {
      const cr = c.getBoundingClientRect();
      // A FIELD THAT HOLDS THE COMPLAINT UNDER ITSELF OUTRANKS ANY NEIGHBOUR'S "BESIDE" (#327).
      //
      // The beside rule below zeroes the vertical distance of a control the complaint sits just
      // right of, on its own line. Without this bound it also handed "This field is required."
      // UNDER an empty Customer phone to the upload slot ending to its left on the complaint's
      // line — a slot the run had uploaded to, so the held-upload read-back discharged it, the
      // complaint with it, and the PSE draft was created with Customer phone blank (main stopped).
      // So when an EMPTY control sits directly above the complaint, aligned with it, holding the
      // complaint inside its own box, nothing gets the beside discount and plain distance decides.
      //
      // "Aligned" is a window, not |dleft| <= 12: a complaint indented 20 to 40 px under its field
      // is still that field's. And the window is CAPPED at 48 px: a full-width box above (a notes
      // textarea, a Bootstrap .form-control-file slot) must not cancel a real beside complaint —
      // without the cap requiredBlank's "Additional notes" misattribution comes back, and so does
      // the draft created under a wide held slot (draftSubmitClick heldAboveMeter).
      const ownedBelow = controls.some((el) => {
        if (!emptyish.has(el)) return false;
        const er = boxOf(el);
        const dy = cr.top - er.bottom;
        return dy >= -2 && dy <= 90 && cr.left >= er.left - 12 && cr.left <= er.left + Math.min(48, Math.max(12, er.width / 3));
      });
      // AN EMPTY FIELD IS THE ONLY THING "THIS FIELD IS REQUIRED" CAN MEAN.
      //
      // Pure proximity gave the message to the wrong control and lost it: on PacifiCorp's
      // "Qty [18] [Please select...]" row the complaint sits under the row, and the QUANTITY
      // is fractionally nearer than the empty model select beside it. Attributed to a field
      // that already has a value, the complaint evaporates — which is precisely what the
      // live run did, and why a filing missing its module model scored `replayed_clean`.
      // So: consider answered controls only if no unanswered one is in range.
      let best: HTMLElement | null = null;
      let bestD = Infinity;
      // The runner-up among the EMPTY controls, so a caller that discharges `best` can re-attribute.
      let next: HTMLElement | null = null;
      let nextD = Infinity;
      for (const pass of [0, 1]) {
        for (const el of controls) {
          if (pass === 0 && !emptyish.has(el)) continue;
          const er = boxOf(el);
          // A validation message sits BELOW or beside its field, never far above it, and
          // never in another column. Both bounds keep one complaint from claiming a page.
          const dy = cr.top - er.bottom;
          if (dy < -40 || dy > 90) continue;
          if (Math.abs(cr.left - er.left) > 420) continue;
          // BESIDE IS NOT FARTHER THAN BELOW (#327). A message on the SAME LINE, just after its
          // field, overlaps it vertically, so |dy| charged it the field's whole height — and an
          // empty box ending exactly where the message's line begins, far to the left, won by
          // under a pixel: requiredBlank.dom.smoke's "This field is required." beside the empty
          // inverter Manufacturer was blamed on the optional "Additional notes" box above it
          // whenever the fonts wrapped that box onto the line above (since 3817c24d). Only a
          // message to the RIGHT of the field counts as beside it; one that merely shares a
          // line with a control further right is still measured as before. And never when an
          // empty field holds the complaint under itself (ownedBelow, above).
          const beside = !ownedBelow && cr.top < er.bottom && cr.bottom > er.top && cr.left >= er.right - 4;
          const d = (beside ? 0 : Math.abs(dy)) + Math.abs(cr.left - er.left) / 8;
          if (d < bestD) {
            if (pass === 0) { next = best; nextD = bestD; }
            bestD = d; best = el;
          } else if (pass === 0 && d < nextD) { nextD = d; next = el; }
        }
        if (best) break;
      }
      if (best) {
        claimed.add(best);
        (handedTo.get(best) ?? handedTo.set(best, []).get(best)!).push({ next: emptyish.has(best) ? next : null, unattributed: orphanName(c) });
        continue;
      }
      // COULD NOT ATTRIBUTE IT — say so rather than drop it. The portal is refusing the
      // filing; not knowing which field is a reason to report harder, not to go quiet.
      push(orphanName(c), "unattributed-complaint");
    }

    // ---- requiredness and emptiness -------------------------------------------------
    // How the page captions a control, and the name it is reported under. One reading, shared by
    // the report and by `handed` (a complaint's runner-up must be named as the report names it,
    // or a caller cannot tell it from a held slot).
    const captionOf = (el: HTMLElement): { labelText: string; containerText: string } => {
      const id = el.getAttribute("id") || "";
      const forLbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const wrapLbl = el.closest("label");
      const byAria = (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/).filter(Boolean)
        .map((r) => (document.getElementById(r) || { textContent: "" }).textContent || "").join(" ");
      const labelText = [
        (forLbl && (forLbl as HTMLElement).textContent) || "",
        byAria,
        (wrapLbl && wrapLbl !== (el as unknown as Element) && (wrapLbl as HTMLElement).textContent) || "",
        el.getAttribute("aria-label") || "",
      ].map((s) => s.replace(/\s+/g, " ").trim()).find(Boolean) || "";

      // THE ASTERISK NEED NOT LIVE IN A <label>. When the control's own small container
      // holds exactly one control, that container's text is this control's caption
      // whatever element it happens to be written in.
      const container = el.closest('[class*="form-group"], [class*="field"], [class*="row"], li, tr, dd, p, div');
      const ownsOne = !!container && container.querySelectorAll("input, select, textarea").length === 1;
      const containerText = ownsOne ? ((container as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() : "";
      return { labelText, containerText };
    };
    const nameOf = (el: HTMLElement): string => {
      const { labelText, containerText } = captionOf(el);
      return labelText
        || (containerText && containerText.length <= 90 ? containerText : "")
        || el.getAttribute("aria-label")
        || el.getAttribute("placeholder")
        || el.getAttribute("name")
        || "(unlabelled control)";
    };
    for (const el of controls) {
      const { labelText, containerText } = captionOf(el);
      const asterisk = /\*/.test(labelText) || (containerText.length <= 160 && /\*/.test(containerText));

      const required = el.hasAttribute("required")
        || el.getAttribute("aria-required") === "true"
        || asterisk
        || claimed.has(el);
      if (!required) continue;
      // EVERY REQUIRED CONTROL, not only the empty ones. "Nothing was left blank" is only
      // half an answer: it cannot distinguish a page where twenty required fields were all
      // filled from one where the portal asked for nothing. The operator's question — is
      // everything this permit needs actually present — needs the denominator.
      {
        const seenName = (labelText
          || (containerText && containerText.length <= 90 ? containerText : "")
          || el.getAttribute("aria-label") || el.getAttribute("name") || "").replace(/\s*\*\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 70);
        if (seenName && !requiredSeen.includes(seenName)) requiredSeen.push(seenName);
      }

      // "Filled" must mean filled. A native select resting on its placeholder reports that
      // option's text as .value, and a custom combobox is an input whose .value IS the
      // placeholder — both read as non-empty and blessed unanswered controls.
      const raw = ((el as HTMLInputElement).value || "").trim();
      const shown = (el.tagName || "").toLowerCase() === "select"
        ? ((((el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex] || {}).textContent) || "").trim()
        : raw;
      if (raw && !PLACEHOLDER.test(shown) && !/^--/.test(shown)) continue;

      const handed = (handedTo.get(el) ?? []).map((h) => ({ next: h.next ? tidy(nameOf(h.next)) : "", unattributed: h.unattributed }));
      push(nameOf(el), claimed.has(el) ? "complaint" : el.hasAttribute("required") || el.getAttribute("aria-required") === "true" ? "attribute" : "asterisk", handed);
    }

    // ---- unanswered required radio GROUPS -------------------------------------------
    // A single unchecked radio is not a blank; a group where nothing is checked is exactly
    // one. PGE's required "disconnect within 10 feet" pair sat unanswered while this sweep
    // reported a clean page.
    const radios = (Array.from(document.querySelectorAll("input[type=radio]")) as HTMLInputElement[])
      .filter((el) => visible(el) || !!el.closest("label"));
    const groups = new Map<string, HTMLInputElement[]>();
    for (const r of radios) {
      const key = r.getAttribute("name") || (r.getAttribute("id") || "").replace(/_\d+$/, "");
      if (!key) continue;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    for (const [, members] of groups) {
      if (members.length < 2 || members.some((r) => r.checked)) continue;
      let cont: HTMLElement | null = members[0].parentElement;
      while (cont && cont !== document.body && !members.every((r) => cont!.contains(r))) cont = cont.parentElement;
      if (!cont || cont === document.body) continue;
      const text = (cont.innerText || "").replace(/\s+/g, " ").trim();
      if (!/\*/.test(text.slice(0, 200)) && !COMPLAINT.test(text)) continue;
      push(text.replace(/\s*\*\s*/g, " ").trim(), "radio-group");
    }

    return { empty: out.slice(0, 14), requiredSeen: requiredSeen.slice(0, 120) };
  }).catch(() => ({ empty: [], requiredSeen: [] })) as { empty: EmptyRequired[]; requiredSeen: string[] };

  // NORMALISE BEFORE RETURNING. The .catch above absorbs a page that throws, but not a page
  // that RESOLVES with something else — a stub, a page mid-navigation, an evaluate the portal
  // interrupted. This is a diagnostic: the worst it may ever do is report nothing. Iterating
  // an undefined here would abort a filing that was otherwise going fine, which is the only
  // outcome worse than a missing warning.
  return {
    empty: Array.isArray(swept?.empty) ? swept.empty : [],
    requiredSeen: Array.isArray(swept?.requiredSeen) ? swept.requiredSeen : [],
  };
}
