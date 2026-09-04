/*
 * The little bubble that names a control, and the shortcut for it.
 *
 * One implementation for every button in the pane — title bar, footer, format bar. It started in the
 * format bar (decision 58) and stayed there for one build, which immediately read as two vocabularies
 * in one window: the format bar answered instantly in the pane's own material while the icons six
 * inches above it waited a second and answered in the system's yellow.
 *
 * One element for the whole pane rather than one per button: it is only ever showing one thing, and a
 * dozen hidden divs is a dozen things to keep positioned. Absolutely positioned, out of the flow —
 * the title bar's and footer's heights feed `reportContentHeight`, so a bubble that took part in
 * layout would resize the window every time the pointer crossed a button (decision 41).
 */

/*
 * How long the pointer has to rest on a control before it is named.
 *
 * Instant was the first behaviour and it reads as noise: the bubble fired on every pass of the
 * cursor, so crossing the title bar on the way to the text produced three of them and none of them
 * had been asked for. A pause is the whole signal — it is the difference between the pointer being
 * *somewhere* and the reader wanting to know what that something is.
 *
 * 500ms. The system's own bubble takes about a second, which the note above this file already calls
 * out as too slow to belong beside the format bar; Windows and VS Code both use 500, and it is short
 * enough that a deliberate pause never feels like waiting.
 */
const SHOW_DELAY_MS = 500;

/**
 * ...and how long a tooltip stays "warm" after one comes down, during which the next is instant.
 *
 * Without this a delay is worse than no delay: the title bar has four buttons side by side and the
 * format bar eight, and paying 500ms at each one turns reading a row of icons into a stutter. Once
 * the reader has asked one question they are asking a series, so the delay is the price of the
 * *first* answer only. Every native toolbar behaves this way — AppKit, Windows and Qt all keep a
 * warm window — and the reason it goes unnoticed is that it is what people already expect.
 */
const WARM_MS = 1500;

let tip: HTMLElement | null = null;
let pane: HTMLElement | null = null;
/** Whose name is on screen, so a pointer that never crosses back out can still be noticed. */
let named: HTMLElement | null = null;

/** The control the pointer is resting on, waiting out `SHOW_DELAY_MS`. */
let pendingEl: HTMLElement | null = null;
let pendingTimer = 0;
/** When a *visible* bubble last came down, which is what `WARM_MS` is measured from. */
let lastHiddenAt = 0;

function cancelPending(): void {
  if (pendingTimer) window.clearTimeout(pendingTimer);
  pendingTimer = 0;
  pendingEl = null;
}

function isWarm(): boolean {
  return lastHiddenAt > 0 && performance.now() - lastHiddenAt < WARM_MS;
}

/**
 * Arms the bubble for one control, rather than showing it.
 *
 * Every take-down path already funnels through `hideTooltip`, which cancels the timer with it — so a
 * pointer that passes over a button and moves on cannot produce a bubble half a second later, over
 * whatever it moved to. That is the failure this whole mechanism exists to prevent, and it is why
 * the cancel lives in the same place as the hide rather than beside each caller.
 */
function scheduleFor(button: HTMLElement, text: string): void {
  if (button === named) return;
  cancelPending();
  if (!text) return;

  if (isWarm()) {
    showFor(button, text);
    return;
  }
  pendingEl = button;
  pendingTimer = window.setTimeout(() => {
    pendingTimer = 0;
    pendingEl = null;
    // Read the label again rather than trusting the string captured half a second ago: a rebind can
    // land inside the delay, and `describe` exists precisely so a bubble cannot print a stale key.
    showFor(button, button.getAttribute("aria-label") ?? button.dataset.tip ?? text);
  }, SHOW_DELAY_MS);
}

/** Splits "Bold ⌘B" into its name and its key cap. Anything without a shortcut is just a name. */
function parse(text: string): { name: string; keys: string } {
  const match = /^(.*?)\s+([⌘⇧⌥⌃][^\s]*)$/.exec(text);
  return { name: match?.[1] ?? text, keys: match?.[2] ?? "" };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

export function mountTooltips(paneEl: HTMLElement): void {
  pane = paneEl;
  tip = document.createElement("div");
  tip.className = "pane__tip";
  tip.hidden = true;
  paneEl.appendChild(tip);

  /*
   * `mouseleave` is not enough to take a tooltip down, and the bubble that will not go away is far
   * worse than no bubble at all.
   *
   * Three ways it got stuck, all seen: the chrome dims while the pointer is on a button, and
   * `pointer-events: none` arrives before the leave event does; the format bar opens under the
   * pointer and replaces the button that was being hovered; and the pointer leaves the *window*
   * quickly enough that WebKit delivers no leave at all. So the pointer moving anywhere that is not
   * the named button takes it down, which is a condition rather than an event and cannot be missed.
   */
  document.addEventListener(
    "mousemove",
    (event) => {
      const target = event.target as Node | null;
      if (named && (!target || !named.contains(target))) hideTooltip();
      // A bubble that is merely *waiting* comes off the same condition. Without this the pointer
      // crossing a button on its way somewhere else still produces one, half a second later, sitting
      // over whatever it crossed to — which is the exact noise the delay was added to remove.
      if (pendingEl && (!target || !pendingEl.contains(target))) cancelPending();
    },
    true
  );

  /*
   * Anything carrying `data-tip`, without a listener of its own.
   *
   * `describe` attaches to one element, which is right for the pane's fixed chrome and useless for
   * the switcher's rows: they are rebuilt from `innerHTML` on every keystroke, so any listener
   * attached to a row dies with it. Those buttons had `title` instead — the system's yellow bubble,
   * a second late — which is precisely the inconsistency decision 58 set out to remove and then
   * left standing in the two places that re-render.
   */
  document.addEventListener("mouseover", (event) => {
    const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tip]");
    if (target && target !== named) scheduleFor(target, target.dataset.tip ?? "");
  });

  document.addEventListener("keydown", hideTooltip, true);
  paneEl.addEventListener("mouseleave", hideTooltip);
  // The pointer leaving the document — which in a WKWebView means leaving the window — arrives as a
  // mouseout with nothing to enter, and as a window blur when it lands in another app.
  document.addEventListener("mouseout", (event) => {
    if (!(event as MouseEvent).relatedTarget) hideTooltip();
  });
  window.addEventListener("blur", hideTooltip);

  /*
   * And a watchdog, because none of the above is guaranteed to arrive.
   *
   * The pane is a window with a transparent AppKit view over its title bar (the drag regions), so a
   * pointer moving off a title-bar button into the strip beside it stops producing events in the
   * page entirely — the web layer's last word on the subject is "still hovering", and the bubble
   * stayed up until something else happened to move. `:hover` is the engine's own answer rather than
   * our record of it, and the engine is told by AppKit even when no event reaches the page.
   */
  window.setInterval(() => {
    // "The engine has no opinion" is not "the engine says no". With the pointer outside the window
    // nothing in the document matches `:hover` at all, and reading that as "the pointer left the
    // button" makes this poll fire constantly against a state it cannot see. The pointer genuinely
    // leaving the pane is already covered — `mouseleave` on the pane, and Swift's `setHover(false)`,
    // which exists because the pane is a window and not a page.
    if (!document.querySelector(":hover")) return;
    if (named && !named.matches(":hover")) hideTooltip();
    if (pendingEl && !pendingEl.matches(":hover")) cancelPending();
  }, 250);
}

/** Takes the bubble down. Also called from Swift's `setHover(false)` — the pointer can leave the
 *  pane without the page hearing about it, because the pane is a window and not a page. */
export function hideTooltip(): void {
  cancelPending();
  // Only a bubble that was actually on screen starts the warm window. A pointer that crossed a
  // button too fast to name it has not been answered, so the next control should still make it wait.
  if (named) lastHiddenAt = performance.now();
  named = null;
  if (tip) tip.hidden = true;
}

/** Puts the bubble over one control. Shared by `describe` and the `data-tip` delegation above. */
function showFor(button: HTMLElement, text: string): void {
  if (!tip || !pane || !text) return;
  named = button;
  const { name, keys } = parse(text);
  tip.innerHTML = keys ? `${escapeHtml(name)}<kbd>${escapeHtml(keys)}</kbd>` : escapeHtml(name);
  tip.hidden = false;

  const paneBox = pane.getBoundingClientRect();
  const box = button.getBoundingClientRect();
  // Below a control in the top half of the pane, above one in the bottom half — so the bubble
  // never covers the thing it is naming, wherever that thing lives.
  const below = box.top - paneBox.top < paneBox.height / 2;
  tip.style.top = below
    ? `${box.bottom - paneBox.top + 6}px`
    : `${box.top - paneBox.top - tip.offsetHeight - 6}px`;

  const half = tip.offsetWidth / 2;
  const centre = box.left - paneBox.left + box.width / 2;
  tip.style.left = `${Math.min(Math.max(centre, half + 8), paneBox.width - half - 8)}px`;
}

/**
 * Names one button. `text` carries the shortcut in it — "Notes ⌘P" — which is also the button's
 * accessible name, so the two cannot drift apart.
 *
 * For anything rebuilt from `innerHTML`, use a `data-tip` attribute instead: a listener attached
 * here dies with the element it was attached to.
 */
export function describe(button: HTMLElement, text: string): void {
  button.setAttribute("aria-label", text);
  // No `title`: the system tooltip would arrive a second later and say the same thing again.
  button.removeAttribute("title");

  // **Safe to call again with different text**, which it now is: the chrome's bubbles print
  // shortcuts, and a rebind has to be able to rewrite them. Attaching a second set of listeners
  // would leave the *first* set still showing the old string from its own closure — a button whose
  // bubble says ⌘P on one hover and ⌘O on the next. So the listeners go on once and read the label
  // at hover time rather than capturing it.
  if (button.dataset.paneDescribed) return;
  button.dataset.paneDescribed = "1";

  const label = () => button.getAttribute("aria-label") ?? "";
  const hide = () => hideTooltip();

  button.addEventListener("mouseenter", () => scheduleFor(button, label()));
  // Focus answers immediately, and the asymmetry is the point: the pointer arrives on a control by
  // passing over it, and focus arrives because somebody pressed a key to put it there. One is a
  // guess about intent and the other is a statement of it.
  button.addEventListener("focus", () => showFor(button, label()));
  button.addEventListener("mouseleave", hide);
  button.addEventListener("blur", hide);
  button.addEventListener("mousedown", hide);
}
