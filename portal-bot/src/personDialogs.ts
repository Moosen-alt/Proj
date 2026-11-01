// #381 — A NATIVE DIALOG ON A WINDOW HANDED TO A PERSON WAITS FOR THAT PERSON.
//
// With no `dialog` listener, Playwright answers every native dialog itself: it DISMISSES alert /
// confirm / prompt (and accepts beforeunload). On the window a run leaves open for a person, a portal
// whose Submit asks `confirm("Submit this application?")` therefore could never be answered Yes: the
// person's click resolved as Cancel and nothing was posted (Helm's reproduction on PR #378: page log
// `?confirm=false&ms=11`, no POST reached the portal).
//
// From the moment a page is handed to a person (filingBackstop handOverToHuman, and index.ts when it
// leaves a window open), leaveDialogsToPerson registers ONE listener on the page's BrowserContext (so
// a popup the person opens is covered too). A registered listener is what stops Playwright answering;
// this listener only notes that a dialog opened. IT NEVER ANSWERS ONE: no accept(), no dismiss(), on
// any dialog, from here or anywhere else on that window (hard rule 1 — leaving a dialog to the person
// must never become automation answering it; personDialogs.test pins the call sites by source).
//
// AN OPEN DIALOG STALLS EVERY PAGE READ (measured in Chromium: page.evaluate never settles, a
// locator's innerText and a screenshot run out their timeout). The run's tail after the hand-over
// still reads the page (the review read-back, where the run stopped, the capture), so each such read
// goes through readUnlessDialog: skipped while a dialog is open on that page, and given up — its
// fallback returned — the moment one opens while it runs. Never "answered so the read can go on".
// Before the hand-over nothing here is registered and every read runs exactly as on main.
//
// WHEN THE DIALOG CLOSES is learned without touching it: a read queued while it is open completes only
// once the page's own script runs again (the person answered) or its document is gone (navigated,
// closed). That read is `0` in the page's main world — nothing on the page is read or changed.

type DialogLike = { page?: () => unknown; type?: () => string };
type Listenable = { on?: (ev: string, fn: (d: DialogLike) => void) => unknown };

/** The contexts (or, for a page with no context, the pages) whose dialogs are left to the person. */
const leftToPerson = new WeakSet<object>();
/** Per page: how many dialogs are open on it now (as far as the close probe can tell). */
const openOn = new WeakMap<object, number>();
/** Per page: when the latest dialog opened on it (Date.now()). */
const lastOpenedAt = new WeakMap<object, number>();
/** Per page: reads in flight that give up the moment a dialog opens. */
const giveUp = new WeakMap<object, Set<() => void>>();

function listenTarget(page: unknown): (Listenable & object) | null {
  if (!page || typeof page !== "object") return null;
  try {
    const ctxFn = (page as { context?: () => unknown }).context;
    const ctx = typeof ctxFn === "function" ? ctxFn.call(page) : null;
    if (ctx && typeof ctx === "object" && typeof (ctx as Listenable).on === "function") return ctx as Listenable & object;
  } catch { /* no context: the page itself */ }
  return typeof (page as Listenable).on === "function" ? (page as Listenable & object) : null;
}

/** The ONLY dialog listener on a handed-over window. It notes the dialog and leaves it open. */
function onDialog(dialog: DialogLike): void {
  let pg: unknown = null;
  try { pg = typeof dialog?.page === "function" ? dialog.page() : null; } catch { pg = null; }
  if (!pg || typeof pg !== "object") return;
  const page = pg as object;
  lastOpenedAt.set(page, Date.now());
  openOn.set(page, (openOn.get(page) ?? 0) + 1);
  for (const stop of [...(giveUp.get(page) ?? [])]) { try { stop(); } catch { /* a reader never breaks this */ } }
  // The close probe: settles once the page's script runs again, or the document is gone.
  const evaluate = (page as { evaluate?: (fn: () => number) => Promise<unknown> }).evaluate;
  const closed = (): void => { openOn.set(page, Math.max(0, (openOn.get(page) ?? 1) - 1)); };
  if (typeof evaluate !== "function") { closed(); return; }
  try {
    Promise.resolve(evaluate.call(page, () => 0)).then(closed, closed);
  } catch { closed(); }
}

/** #381 — from now on a native dialog on `page`'s window waits for the person: a listener that never
 *  answers keeps Playwright from dismissing it. Idempotent. false = nothing to listen on (a double). */
export function leaveDialogsToPerson(page: unknown): boolean {
  const target = listenTarget(page);
  if (!target) return false;
  if (leftToPerson.has(target)) return true;
  try {
    target.on!("dialog", onDialog);
  } catch { return false; }
  leftToPerson.add(target);
  return true;
}

/** Dialogs on `page`'s window are left to the person (leaveDialogsToPerson registered). */
export function dialogsLeftToPerson(page: unknown): boolean {
  const target = listenTarget(page);
  return !!target && leftToPerson.has(target);
}

/** A native dialog is open on `page` now (only known once its dialogs are left to the person). */
export function dialogOpenOn(page: unknown): boolean {
  return !!page && typeof page === "object" && (openOn.get(page) ?? 0) > 0;
}

/** A native dialog opened on `page` at or after `since` (Date.now() ms). */
export function dialogOpenedSince(page: unknown, since: number): boolean {
  if (!page || typeof page !== "object") return false;
  const t = lastOpenedAt.get(page);
  return typeof t === "number" && t >= since;
}

/** #381 — A PAGE READ THAT TOLERATES AN OPEN DIALOG: skipped (`fallback`) while one is open on `page`,
 *  and given up (`fallback`) the moment one opens while it runs — never by answering it. A page whose
 *  dialogs were never left to the person runs `read` exactly as before. A read that throws still
 *  throws (callers keep their own catch). The read given up keeps running in the page until the
 *  dialog closes; every read routed here is read-only. */
export function readUnlessDialog<T>(page: unknown, read: () => Promise<T>, fallback: T): Promise<T> {
  if (!page || typeof page !== "object" || !dialogsLeftToPerson(page)) return read();
  if (dialogOpenOn(page)) return Promise.resolve(fallback);
  const pg = page as object;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const set = giveUp.get(pg) ?? new Set<() => void>();
    giveUp.set(pg, set);
    const finish = (): boolean => { if (done) return false; done = true; set.delete(stop); return true; };
    const stop = (): void => { if (finish()) resolve(fallback); };
    set.add(stop);
    let running: Promise<T>;
    try { running = read(); } catch (e) { if (finish()) reject(e); return; }
    running.then((v) => { if (finish()) resolve(v); }, (e) => { if (finish()) reject(e); });
  });
}
