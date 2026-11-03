// THE SECRET MASK FOR A SCREENSHOT THAT LEAVES THE PROCESS (hard rule 2).
//
// One tagger, shared by the learner's withSecretMask (the vision planner, the review verifier, the
// bundle PNG, the information-page candidate) and the staged review's masked picture (#436): every
// element whose value or text carries a known secret is tagged with SECRET_MASK_ATTR, and the
// screenshot masks that selector. The tagger is the learner's own code, moved here; #436 fix round 1
// added the <select> (an <option> has no box of its own, so tagging it masked nothing).
//
// Identifier-shaped secrets (5+ digits) match digit-for-digit with every separator ignored; a shorter
// or non-numeric secret matches as a case-insensitive literal of 4+ characters. The smallest element
// carrying a whole secret is tagged (masking <body> would blank the picture).
//
// THE STAGED REVIEW'S PICTURE IS VERIFIED, NOT TRUSTED (maskedFullPageScreenshot, #436 fix round 1):
// a page with a closed shadow root, a secret no element can be tagged for, or a tagged secret painted
// outside every box the mask can draw is refused; and after the shot, every masked box must read as
// the mask colour in the PNG itself, or the file is deleted and the picture is refused.
import fs from "node:fs";
import type { CDPSession, ElementHandle, Frame, Locator, Page } from "playwright";

export const SECRET_MASK_ATTR = "data-al-secret";
/** Set beside SECRET_MASK_ATTR on every tagged element whose secret is PAINTED: the boxes the staged
 *  picture's pixel check reads after the shot. */
export const SECRET_MASK_CHECK_ATTR = "data-al-secret-check";
/** Playwright's own default mask colour, set explicitly: the pixel check reads it. */
export const SECRET_MASK_COLOR = "#FF00FF";

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
 *  locator pierces open roots, so the mask covers what is tagged there). A <select> is tagged when
 *  any of its options (text or label) or option groups carries one: a collapsed select paints its
 *  chosen option, and an <option> has no box of its own (#436 fix round 1 — the tagger tagged the
 *  0x0 option, so the mask drew nothing over the select). Returns how many were tagged. Throws when
 *  the page cannot be evaluated (the caller decides whether that fails closed). */
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
    // A <select> one of whose options (or option groups) carries one: the SELECT is what is painted.
    for (const sel of Array.from(root.querySelectorAll("select"))) {
      const texts: string[] = [];
      for (const o of Array.from((sel as HTMLSelectElement).options)) { texts.push(String(o.text || "")); texts.push(String(o.label || "")); }
      for (const g of Array.from(sel.querySelectorAll("optgroup"))) texts.push(String(g.getAttribute("label") || ""));
      let hit = false;
      for (const t of texts) {
        if (!t) continue;
        const td = t.replace(/\D/g, "");
        const tl = t.toLowerCase();
        for (const p of ps) {
          if ((p.digits && td.indexOf(p.digits) >= 0) || (p.literal && tl.indexOf(p.literal) >= 0)) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit) { sel.setAttribute("data-al-secret", "1"); n++; }
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
      // An option's text is the select's (tagged above, by each option alone).
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "OPTION" || tag === "OPTGROUP") continue;
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

/** Remove the tags tagSecretsInPage and the coverage check set (best-effort; open shadow roots included). */
export async function clearSecretTags(page: Pick<Page, "evaluate">): Promise<void> {
  await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of Array.from(roots[i].querySelectorAll("*"))) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
        if (el.hasAttribute("data-al-secret")) el.removeAttribute("data-al-secret");
        if (el.hasAttribute("data-al-secret-check")) el.removeAttribute("data-al-secret-check");
      }
    }
  }).catch(() => null);
}

interface CdpDomNode { shadowRootType?: string; children?: CdpDomNode[]; shadowRoots?: CdpDomNode[]; contentDocument?: CdpDomNode }

/** How many CLOSED shadow roots the page holds (its same-process frames included), through a
 *  short-lived DevTools session: a page script cannot see into one, so neither can the digest's
 *  reader nor the mask's tagger. A browser's own (user-agent) roots — a date input's, a video's — are
 *  not counted. null = could not be checked. Read-only: DOM.getDocument inspects; it dispatches
 *  nothing to the page. (Moved here from reviewDigest.ts, which re-exports it.) */
export async function closedShadowRootCount(page: Page): Promise<number | null> {
  let session: CDPSession | null = null;
  try {
    session = await page.context().newCDPSession(page);
    const doc = await session.send("DOM.getDocument", { depth: -1, pierce: true }) as unknown as { root: CdpDomNode };
    let n = 0;
    const stack: CdpDomNode[] = [doc.root];
    while (stack.length) {
      const x = stack.pop()!;
      if (x.shadowRootType === "closed") n++;
      for (const c of x.children ?? []) stack.push(c);
      for (const r of x.shadowRoots ?? []) stack.push(r);
      if (x.contentDocument) stack.push(x.contentDocument);
    }
    return n;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => null);
  }
}

const SHIM = "globalThis.__name = globalThis.__name || function (fn) { return fn; };";

/** THE COVERAGE CHECK, after tagSecretsInPage, in ONE frame (open shadow roots included):
 *   - every tagged element whose secret is PAINTED (a control's own box; a text carrier's text-node
 *     rects) must have it inside a box the mask draws: the element's own, else the nearest composed
 *     ancestor's that holds it all (tagged), else — it would take <body> — it is UNCOVERED. A tagged
 *     <option> is its <select>. One that paints nothing (a hidden input, display:none) needs no box.
 *     Each box that must be painted is marked SECRET_MASK_CHECK_ATTR for the pixel check.
 *   - no painted box, select or text area that shows a secret may be untagged, and no text outside a
 *     tagged element may still carry one (text straight in <body> or a shadow root, a second copy
 *     beside a tagged one): that secret could not be tagged — UNCOVERED.
 *  Throws when the frame cannot be evaluated. */
export async function secretMaskCoverageInPage(frame: Pick<Frame, "evaluate">, pats: SecretMaskPattern[]): Promise<{ painted: number; uncovered: string[] }> {
  await frame.evaluate(SHIM);
  return await frame.evaluate((a: { ps: Array<{ digits: string; literal: string }>; attr: string; check: string }) => {
    const uncovered: string[] = [];
    let painted = 0;
    const carries = (t: string): boolean => {
      const d = t.replace(/\D/g, "");
      const l = t.toLowerCase();
      for (const p of a.ps) if ((p.digits && d.indexOf(p.digits) >= 0) || (p.literal && l.indexOf(p.literal) >= 0)) return true;
      return false;
    };
    const roots: Array<Document | ShadowRoot> = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of Array.from(roots[i].querySelectorAll("*"))) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) roots.push(sr);
      }
    }
    // The composed parent: an element's parent element, or the host of the shadow root it sits in.
    const up = (n: Node): Element | null => {
      if (n.parentElement) return n.parentElement;
      const p = n.parentNode as (Node & { host?: Element }) | null;
      return p && p.host ? p.host : null;
    };
    const area = (r: { width: number; height: number }): number => Math.max(0, r.width) * Math.max(0, r.height);
    const inside = (r: DOMRect, b: DOMRect): boolean => r.left >= b.left - 1 && r.top >= b.top - 1 && r.right <= b.right + 1 && r.bottom <= b.bottom + 1;
    const name = (el: Element): string => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}>`;
    const NO_TEXT = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/;
    /** Where an element's text is painted: the client rects of every text node in its composed subtree. */
    const textRects = (el: Element): DOMRect[] => {
      const out: DOMRect[] = [];
      const range = document.createRange();
      const stack: Node[] = [el];
      while (stack.length) {
        const n = stack.pop() as Node;
        if (n.nodeType === 3) {
          if (String(n.textContent || "").trim()) {
            range.selectNodeContents(n);
            for (const r of Array.from(range.getClientRects())) if (area(r) > 0) out.push(r);
          }
          continue;
        }
        if (n.nodeType === 1 && NO_TEXT.test((n as Element).tagName)) continue;
        const sr = n.nodeType === 1 ? (n as HTMLElement).shadowRoot : null;
        if (sr) for (const c of Array.from(sr.childNodes)) stack.push(c);
        for (const c of Array.from(n.childNodes)) stack.push(c);
      }
      return out;
    };
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll(`[${a.attr}]`))) {
        let target: Element | null = el.closest("select") || el;
        const rects = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
          ? Array.from(target.getClientRects()).filter((r) => area(r) > 0)
          : textRects(target);
        if (!rects.length) continue;
        let held = false;
        for (let guard = 0; target && guard < 64; guard++) {
          const box = target.getBoundingClientRect();
          if (area(box) > 0 && rects.every((r) => inside(r, box))) { held = true; break; }
          const next = up(target);
          target = next && next !== document.body && next !== document.documentElement ? next : null;
        }
        if (!held || !target) { uncovered.push(`${name(el)} paints a known secret outside every box the mask can draw`); continue; }
        target.setAttribute(a.attr, "1");
        target.setAttribute(a.check, "1");
        painted++;
      }
    }
    // What is left: a control carrying one that is not tagged (asked again here, not taken on trust
    // from the tagger) ...
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll("input, textarea, select"))) {
        if (el.hasAttribute(a.attr) || !Array.from(el.getClientRects()).some((r) => area(r) > 0)) continue;
        const texts = [String((el as HTMLInputElement).value || "")];
        if (el.tagName === "SELECT") for (const o of Array.from((el as HTMLSelectElement).options)) texts.push(String(o.text || ""), String(o.label || ""));
        if (texts.some((t) => t && carries(t))) uncovered.push(`${name(el)} shows a known secret and is not tagged for the mask`);
      }
    }
    // ... and text no tagged element covers, in runs split at each tagged element.
    for (const root of roots) {
      const start: Node | null = root === document ? document.body : root;
      if (!start) continue;
      const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
      let seg = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const pe = (n as Text).parentElement;
        if (pe && pe.closest("script, style, noscript, template, title, textarea, select, datalist")) continue;
        let covered = false;
        for (let e: Element | null = pe || up(n); e; e = up(e)) if (e.hasAttribute(a.attr)) { covered = true; break; }
        if (covered) {
          if (carries(seg)) uncovered.push(`text ${root === document ? "on the page" : "in a shadow root"} carries a known secret no element could be tagged for`);
          seg = "";
          continue;
        }
        seg += String(n.textContent || "");
      }
      if (carries(seg)) uncovered.push(`text ${root === document ? "on the page" : "in a shadow root"} carries a known secret no element could be tagged for`);
    }
    return { painted, uncovered: Array.from(new Set(uncovered)) };
  }, { ps: pats, attr: SECRET_MASK_ATTR, check: SECRET_MASK_CHECK_ATTR }) as { painted: number; uncovered: string[] };
}

interface Box { x: number; y: number; width: number; height: number }
const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bt = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null;
};

/** Where a frame shows in the picture, in the main frame's viewport: undefined = the main frame (no
 *  clip); null = not shown (an ancestor frame element has no box, or the clips do not meet). */
async function frameClip(frame: Frame): Promise<Box | null | undefined> {
  let clip: Box | undefined;
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const fe = await f.frameElement().catch(() => null);
    const b = fe ? await fe.boundingBox().catch(() => null) : null;
    await fe?.dispose().catch(() => null);
    if (!b || b.width < 2 || b.height < 2) return null;
    const next: Box | null = clip ? intersect(clip, b) : b;
    if (!next) return null;
    clip = next;
  }
  return clip;
}

/** How many of `boxes` (CSS pixels of the full-page picture) are NOT painted over in the PNG: the
 *  inside of each box (2px in from its edges) must be at least 98% the mask colour. A box that holds
 *  no pixel of the picture is not in it. Throws when the PNG cannot be decoded. */
export async function unpaintedMaskBoxes(file: string, boxes: readonly Box[]): Promise<number> {
  if (!boxes.length) return 0;
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(await fs.promises.readFile(file));
  const cv = createCanvas(img.width, img.height);
  const g = cv.getContext("2d");
  g.drawImage(img, 0, 0);
  let short = 0;
  for (const b of boxes) {
    const x0 = Math.max(0, Math.ceil(b.x) + 2);
    const y0 = Math.max(0, Math.ceil(b.y) + 2);
    const x1 = Math.min(img.width, Math.floor(b.x + b.width) - 2);
    const y1 = Math.min(img.height, Math.floor(b.y + b.height) - 2);
    if (x1 <= x0 || y1 <= y0) continue;
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] >= 240 && d[i + 1] <= 20 && d[i + 2] >= 240) n++;
    if (n < 0.98 * (d.length / 4)) short++;
  }
  return short;
}

/**
 * A FULL-PAGE SCREENSHOT OF `page` WITH EVERY KNOWN SECRET MASKED, written to `file` (#436's staged
 * review picture). EVERY FRAME is tagged and masked (#436 skeptic: an account shown only inside a
 * same-origin iframe was in the picture, unmasked — the tagger read the main frame alone); a visible
 * frame that cannot be tagged fails the picture closed, a hidden one is not in the picture. With no
 * secret known the picture is a plain full-page screenshot. With secrets known, FAIL CLOSED — no
 * picture is kept ({ ok: false }, the file deleted) when:
 *   - the page holds a CLOSED shadow root (no script can see into it, so nothing there is tagged), or
 *     cannot be checked for one;
 *   - the tagger or the coverage check (secretMaskCoverageInPage) cannot run, or finds a secret it
 *     cannot cover (painted outside every box the mask can draw, or carried by untaggable text);
 *   - THE PICTURE ITSELF: a box the mask must cover does not read as the mask colour in the PNG (or
 *     cannot be measured, or the PNG cannot be decoded).
 * (#436 fix round 1: a collapsed <select> showing the account and a closed shadow root both came back
 * ok:true with the account in clear.)
 */
export async function maskedFullPageScreenshot(page: Page, secrets: readonly string[], file: string): Promise<{ ok: boolean; why: string }> {
  const pats = secretMaskPatterns(secrets);
  const touched: Frame[] = [];
  const mask: Locator[] = [];
  let wrote = false;
  const refuse = async (why: string): Promise<{ ok: boolean; why: string }> => {
    if (wrote) await fs.promises.unlink(file).catch(() => null);
    return { ok: false, why };
  };
  try {
    if (!pats.length) {
      await page.screenshot({ path: file, fullPage: true });
      return { ok: true, why: "" };
    }
    const closed = await closedShadowRootCount(page);
    if (closed === null) return await refuse("the page could not be checked for closed shadow roots, so no picture was taken");
    if (closed > 0) return await refuse(`the page holds ${closed} closed shadow root(s), which the secret mask cannot reach, so no picture was taken`);
    for (const frame of page.frames()) {
      const main = frame === page.mainFrame();
      // A frame the picture does not show cannot leak; one it shows must be masked, or no picture.
      const clip = main ? undefined : await frameClip(frame);
      const shown = main || clip !== null;
      let tagged = 0;
      let cov: { painted: number; uncovered: string[] };
      try {
        tagged = await tagSecretsInPage(frame, pats);
        touched.push(frame);
        cov = await secretMaskCoverageInPage(frame, pats);
      } catch {
        if (main) return await refuse("the secret mask could not be built on the page, so no picture was taken");
        if (shown) return await refuse("the secret mask could not be built in a frame on the page, so no picture was taken");
        continue;
      }
      if (shown && cov.uncovered.length) return await refuse(`the secret mask cannot cover the page (${cov.uncovered[0]}), so no picture was taken`);
      if (tagged > 0 || cov.painted > 0) mask.push(frame.locator(`[${SECRET_MASK_ATTR}]`));
    }
    await page.screenshot({ path: file, fullPage: true, scale: "css", maskColor: SECRET_MASK_COLOR, ...(mask.length ? { mask } : {}) });
    wrote = true;
    // VERIFY THE PICTURE: every box the mask had to cover reads as the mask colour.
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })).catch(() => null);
    if (!scroll) return await refuse("the page's scroll position could not be read to check the mask, so the picture was not kept");
    const boxes: Box[] = [];
    for (const frame of touched) {
      const clip = frame === page.mainFrame() ? undefined : await frameClip(frame);
      if (clip === null) continue;
      const handles: ElementHandle[] = await frame.locator(`[${SECRET_MASK_CHECK_ATTR}]`).elementHandles();
      for (const h of handles) {
        const b = await h.boundingBox().catch(() => null);
        await h.dispose().catch(() => null);
        if (!b) return await refuse("a masked secret's box could not be measured, so the picture was not kept");
        const c = clip ? intersect(b, clip) : b;
        if (c) boxes.push({ x: c.x + scroll.x, y: c.y + scroll.y, width: c.width, height: c.height });
      }
    }
    const short = await unpaintedMaskBoxes(file, boxes);
    if (short > 0) return await refuse(`${short} of ${boxes.length} masked box(es) were not painted over in the picture, so it was not kept`);
    return { ok: true, why: "" };
  } catch (e) {
    return await refuse(`the picture could not be taken (${String((e as { message?: string })?.message ?? e).slice(0, 80)})`);
  } finally {
    for (const f of touched) await clearSecretTags(f);
  }
}
