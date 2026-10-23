/*
 * What is painted, read off the pixels, run once at 1x and once at 2x (`PROBE_SCALE`).
 *
 * The style can be right and the paint wrong: WebKit floors a border to whole device pixels but
 * places an absolutely positioned child at the fraction it was given, so a box that is centred at
 * 2x was off by half a pixel at 1x (205's checkbox, LAB 2026-10-09). Only the pixels say so.
 */

export async function run(view, _bar, doc) {
  const failures = [];
  let checked = 0;
  const check = (name, want, got) => {
    checked += 1;
    if (JSON.stringify(want) !== JSON.stringify(got)) failures.push({ case: `${devicePixelRatio}x · ${name}`, want: JSON.stringify(want), got: JSON.stringify(got) });
  };

  const shot = async (rect, pad) => {
    const r = await window.webkit.messageHandlers.probeShot.postMessage({
      x: rect.left - pad, y: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad,
    });
    const bytes = Uint8Array.from(atob(r.rgba), (c) => c.charCodeAt(0));
    return { width: r.width, height: r.height, at: (x, y) => [...bytes.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)] };
  };
  const rgb = (css) => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const near = (p, a, b) => {
    const d = (q) => q.reduce((s, v, i) => s + (v - p[i]) ** 2, 0);
    return d(a) < d(b);
  };
  /** Runs of "paint" and "not paint" along a line through the box: [ring, gap, fill, gap, ring]. */
  const runs = (img, points, paint, ground) => {
    const out = [];
    let last = null;
    for (const [x, y] of points) {
      const on = near(img.at(x, y), paint, ground);
      if (on === last) out[out.length - 1]++;
      else out.push(1);
      last = on;
    }
    return out.slice(1, -1); // the ground outside the box on either side
  };

  // ---- (205) The done checkbox's fill is centred in its ring --------------------------------------
  window.paneHost.loadNote("pixels.md", "top\n\n- [x] done item\n\nend\n", 0, false);
  view.contentDOM.blur();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const box = doc.querySelector(".pane-task--done");
  if (!box) {
    check("(205) a done checkbox is drawn", "a box", "none");
    return { checked, failures };
  }
  const paint = rgb(getComputedStyle(box).borderTopColor);
  const pad = 2;
  const img = await shot(box.getBoundingClientRect(), pad);
  const ground = img.at(0, 0);
  const s = devicePixelRatio;
  const mid = Math.floor(img.height / 2), centre = Math.floor(img.width / 2);
  const across = runs(img, Array.from({ length: img.width }, (_, x) => [x, mid]), paint, ground);
  const down = runs(img, Array.from({ length: img.height }, (_, y) => [centre, y]), paint, ground);
  check("(205) across the done box: ring, gap, fill, gap, ring, the gaps equal", [across[0], across[1], across[2], across[1], across[0]], across);
  check("(205) down the done box: the same", [down[0], down[1], down[2], down[1], down[0]], down);
  check("(205) the box is as wide as it is tall", across, down);
  // At 2x the box is as it always was: a 3px ring, 5px gaps, a 12px fill.
  if (s === 2) check("(205) at 2x the done box is unchanged", [3, 5, 12, 5, 3], across);
  // At 1x the fill keeps 2x's share of the box (12 of 28 is 6 of 14), and the ring is WebKit's 1px.
  if (s === 1) check("(205) at 1x the fill keeps its share of the box", [1, 3, 6, 3, 1], across);

  return { checked, failures };
}
