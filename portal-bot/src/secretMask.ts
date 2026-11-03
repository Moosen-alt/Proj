// THE SECRET MASK FOR A SCREENSHOT THAT LEAVES THE PROCESS (hard rule 2).
//
// One tagger, shared by the learner's withSecretMask (the vision planner, the review verifier, the
// bundle PNG, the information-page candidate) and the staged review's masked picture (#436): every
// element whose value or text carries a known secret is tagged with SECRET_MASK_ATTR, and the
// screenshot masks that selector. The tagger is the learner's own code, moved here unchanged.
//
// Identifier-shaped secrets (5+ digits) match digit-for-digit with every separator ignored; a shorter
// or non-numeric secret matches as a case-insensitive literal of 4+ characters. The smallest element
// carrying a whole secret is tagged (masking <body> would blank the picture).
import type { Frame, Locator, Page } from "playwright";

export const SECRET_MASK_ATTR = "data-al-secret";

export interface SecretMaskPattern { digits: string; literal: string }

/** The patterns the in-page tagger matches, from the run's known secrets. */
export function secretMaskPatterns(secrets: readonly string[]): SecretMaskPattern[] {
  return secrets.map((s) => {
    const digits = String(s ?? "").replace(/\D/g, "");
    return digits.length >= 5 ? { digits, literal: "" } : { digits: "", literal: String(s ?? "").toLowerCase() };
  }).filter((p) => p.digits || p.literal.length >= 4);
}

/** Tag every element of `page` (ONE frame: a Page reads its main frame, a Frame itself) that renders
 *  one of `pats` — inside every OPEN shadow root too (#436 skeptic: a secret in a web component's
 *  shadow tree went unmasked; a declarative one exists even with scripts off, and Playwright's CSS
 *  locator pierces open roots, so the mask covers what is tagged there). Returns how many were
 *  tagged. Throws when the page cannot be evaluated (the caller decides whether that fails closed). */
export async function tagSecretsInPage(page: Pick<Page, "evaluate">, pats: SecretMaskPattern[]): Promise<number> {
  // Plain loops only: a function DECLARED inside an evaluated body needs the __name shim.
  return Number(await page.evaluate((ps: Array<{ digits: string; literal: string }>) => {
    let n = 0;
    // Every root: the document, then each open shadow root (nested ones are found as the list grows).
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of Array.from(roots[i].querySelectorAll("*"))) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
      }
    }
    for (const root of roots) {
    // A box holding one (typed here, or pre-filled by the portal).
    for (const el of Array.from(root.querySelectorAll("input, textarea"))) {
      const v = String((el as HTMLInputElement).value || "");
      if (!v) continue;
      const vd = v.replace(/\D/g, "");
      const vl = v.toLowerCase();
      for (const p of ps) {
        if ((p.digits && vd.indexOf(p.digits) >= 0) || (p.literal && vl.indexOf(p.literal) >= 0)) { el.setAttribute("data-al-secret", "1"); n++; break; }
      }
    }
    // Text rendering one (a review page's "Account: 7734009155"). Most pages carry none, so
    // the whole-root check keeps the element walk off the common path.
    const bt = String(root === document ? (document.body ? document.body.textContent || "" : "") : (root.textContent || ""));
    const btd = bt.replace(/\D/g, "");
    const btl = bt.toLowerCase();
    let textHas = false;
    for (const p of ps) {
      if ((p.digits && btd.indexOf(p.digits) >= 0) || (p.literal && btl.indexOf(p.literal) >= 0)) { textHas = true; break; }
    }
    if (!textHas) continue;
    for (const el of Array.from(root.querySelectorAll(root === document ? "body *" : "*"))) {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "INPUT" || tag === "TEXTAREA") continue;
      const text = String(el.textContent || "");
      if (!text) continue;
      const td = text.replace(/\D/g, "");
      const tl = text.toLowerCase();
      let hit = false;
      for (const p of ps) {
        if ((p.digits && td.indexOf(p.digits) >= 0) || (p.literal && tl.indexOf(p.literal) >= 0)) { hit = true; break; }
      }
      if (!hit) continue;
      // The SMALLEST element carrying the whole secret: skip an ancestor when a child element
      // carries it too (masking <body> would blank the whole picture).
      let childCarries = false;
      for (const c of Array.from(el.children)) {
        const ct = String(c.textContent || "");
        const cd = ct.replace(/\D/g, "");
        const cl = ct.toLowerCase();
        for (const p of ps) {
          if ((p.digits && cd.indexOf(p.digits) >= 0) || (p.literal && cl.indexOf(p.literal) >= 0)) { childCarries = true; break; }
        }
        if (childCarries) break;
      }
      if (childCarries) continue;
      el.setAttribute("data-al-secret", "1");
      n++;
    }
    }
    return n;
  }, pats));
}

/** Remove the tags tagSecretsInPage set (best-effort; open shadow roots included). */
export async function clearSecretTags(page: Pick<Page, "evaluate">): Promise<void> {
  await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of Array.from(roots[i].querySelectorAll("*"))) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
        if (el.hasAttribute("data-al-secret")) el.removeAttribute("data-al-secret");
      }
    }
  }).catch(() => null);
}

/**
 * A FULL-PAGE SCREENSHOT OF `page` WITH EVERY KNOWN SECRET MASKED, written to `file` (#436's staged
 * review picture). EVERY FRAME is tagged and masked (#436 skeptic: an account shown only inside a
 * same-origin iframe was in the picture, unmasked — the tagger read the main frame alone); a visible
 * frame that cannot be tagged fails the picture closed, a hidden one is not in the picture. Fail
 * closed: when secrets are known and the tagger cannot run, no picture is taken ({ ok: false }). With
 * no secret known the picture is a plain full-page screenshot.
 */
export async function maskedFullPageScreenshot(page: Page, secrets: readonly string[], file: string): Promise<{ ok: boolean; why: string }> {
  const pats = secretMaskPatterns(secrets);
  const tagged: Frame[] = [];
  const mask: Locator[] = [];
  try {
    if (pats.length) {
      for (const frame of page.frames()) {
        const main = frame === page.mainFrame();
        let n = 0;
        try { n = await tagSecretsInPage(frame, pats); } catch {
          if (main) return { ok: false, why: "the secret mask could not be built on the page, so no picture was taken" };
          // A frame the picture shows must be masked too; one it does not show cannot leak.
          const fe = await frame.frameElement().catch(() => null);
          const box = fe ? await fe.boundingBox().catch(() => null) : null;
          if (box && box.width >= 2 && box.height >= 2) return { ok: false, why: "the secret mask could not be built in a frame on the page, so no picture was taken" };
          continue;
        }
        if (n > 0) {
          tagged.push(frame);
          mask.push(frame.locator(`[${SECRET_MASK_ATTR}]`));
        }
      }
    }
    await page.screenshot({ path: file, fullPage: true, ...(mask.length ? { mask } : {}) });
    return { ok: true, why: "" };
  } catch (e) {
    return { ok: false, why: `the picture could not be taken (${String((e as { message?: string })?.message ?? e).slice(0, 80)})` };
  } finally {
    for (const f of tagged) await clearSecretTags(f);
  }
}
