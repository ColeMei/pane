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

let tip: HTMLElement | null = null;
let pane: HTMLElement | null = null;
/** Whose name is on screen, so a pointer that never crosses back out can still be noticed. */
let named: HTMLElement | null = null;

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
      if (!named) return;
      const target = event.target as Node | null;
      if (!target || !named.contains(target)) hideTooltip();
    },
    true
  );

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
    if (named && !named.matches(":hover")) hideTooltip();
  }, 250);
}

/** Takes the bubble down. Also called from Swift's `setHover(false)` — the pointer can leave the
 *  pane without the page hearing about it, because the pane is a window and not a page. */
export function hideTooltip(): void {
  named = null;
  if (tip) tip.hidden = true;
}

/**
 * Names one button. `text` carries the shortcut in it — "Notes ⌘P" — which is also the button's
 * accessible name, so the two cannot drift apart.
 */
export function describe(button: HTMLElement, text: string): void {
  button.setAttribute("aria-label", text);
  // No `title`: the system tooltip would arrive a second later and say the same thing again.
  button.removeAttribute("title");

  const show = () => {
    if (!tip || !pane) return;
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
  };

  const hide = () => hideTooltip();

  button.addEventListener("mouseenter", show);
  button.addEventListener("focus", show);
  button.addEventListener("mouseleave", hide);
  button.addEventListener("blur", hide);
  button.addEventListener("mousedown", hide);
}
