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

  const hide = () => {
    if (tip) tip.hidden = true;
  };

  button.addEventListener("mouseenter", show);
  button.addEventListener("focus", show);
  button.addEventListener("mouseleave", hide);
  button.addEventListener("blur", hide);
  button.addEventListener("mousedown", hide);
}
