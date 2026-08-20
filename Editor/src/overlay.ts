/*
 * Where the switcher and ⌘K sit inside the pane.
 *
 * Both are one component in two modes (decision 46), so their placement is one calculation in one
 * place rather than a literal repeated in two stylesheets. The stylesheets keep the *tokens* — this
 * reads them, so there is one set of numbers.
 *
 * The old placement was `top: 54px`, which is the right answer only for the pane that is exactly
 * tall enough to hold the panel. On a tall pane it pinned the panel under the title bar with a
 * third of the pane empty beneath it, and on a narrow pane the panel's fixed 460px left an 18px
 * margin either side — measured on a 496pt pane, which is the width this pane is actually used at.
 * The reference, in a window of the same 496×800: panel 362 wide with 67pt margins, top edge 120pt
 * down. Both of those are *relative* to the window, which is the whole difference.
 */

const root = getComputedStyle(document.documentElement);

/** Closest the panel ever comes to the top of the pane — the pane must grow to at least this. */
export const OVERLAY_TOP_MIN = Number.parseFloat(root.getPropertyValue("--overlay-top-min")) || 54;

/** Pane left under the panel. Below this the panel reads as resting on the pane's bottom corner. */
export const OVERLAY_GAP_BOTTOM =
  Number.parseFloat(root.getPropertyValue("--overlay-gap-bottom")) || 16;

/**
 * Where the top edge goes, as a fraction of the pane's height.
 *
 * Measured off the reference at two window sizes: 120/800 and 158/981, so 15–16% either way rather
 * than a fixed offset. Sitting the panel a sixth of the way down is what makes it read as placed in
 * the pane instead of hung off the title bar.
 */
const TOP_RATIO = 0.15;

/**
 * The top edge for a panel of this height in a pane of that height.
 *
 * The clamp is what keeps this consistent with the pane growing to fit (decision 45): when the pane
 * has had to grow, there is no slack left and this returns `OVERLAY_TOP_MIN` — the same number Swift
 * used to work out how tall to grow. So the panel never asks for a position the pane cannot honour,
 * and the two never argue.
 */
export function overlayTop(paneHeight: number, panelHeight: number): number {
  const lowestThatFits = Math.max(OVERLAY_TOP_MIN, paneHeight - panelHeight - OVERLAY_GAP_BOTTOM);
  return Math.round(Math.min(Math.max(OVERLAY_TOP_MIN, paneHeight * TOP_RATIO), lowestThatFits));
}

/** Places one overlay, if it is on screen. A hidden panel has no height and nothing to place. */
export function placeOverlay(panel: HTMLElement, pane: HTMLElement): void {
  const height = panel.offsetHeight;
  if (height === 0) return;
  panel.style.top = `${overlayTop(pane.clientHeight, height)}px`;
}

/**
 * The height an overlay *wants*, which is not the height it currently has.
 *
 * `offsetHeight` is capped by the pane (see the `max-height` rules in the two stylesheets), so
 * reporting it would tell Swift the panel already fits and the pane would never grow — on a short
 * note ⌘K came up two and a half rows tall with everything else scrolled out of reach. The pane
 * still has to grow to hold the panel (decision 45); the CSS cap exists for when it *cannot*,
 * because the screen ran out, and a clipped panel is then the lesser of two evils.
 *
 * So: what the panel is now, minus what its list is showing, plus what that list would show.
 *
 * Lives here because the switcher and ⌘K are one component in two modes (decision 46) and this is
 * the last thing they did differently — ⌘K measured itself and ⌘P was a constant in Swift.
 */
export function desiredOverlayHeight(panel: HTMLElement, list: HTMLElement): number {
  const cap = Number.parseFloat(getComputedStyle(list).maxHeight);
  const wanted = Math.min(list.scrollHeight, Number.isFinite(cap) ? cap : Infinity);
  return panel.offsetHeight - list.clientHeight + wanted;
}
