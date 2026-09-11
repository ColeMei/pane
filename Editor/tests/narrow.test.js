/**
 * The ⌘K panel at a pane width nobody designed the labels for.
 *
 * Run at **380**, which is inside the band this rule exists for: below 420 the shortcut chips go,
 * and 380 is far enough in that a stray pixel of rounding cannot decide the result. The suite that
 * measures the overlays at rest runs at 460 and cannot see any of this — the probe's window is one
 * width, and until this file it was hardwired to 460.
 *
 * What is asserted is the thing that was reported: **a row you cannot read**. Six of fifteen labels
 * truncated at the old minimum — `Enable Win…`, `Copy as Ma…`, `Keep on Thi…` — which is a panel
 * that cannot answer the only question it exists to answer. So the assertions are `scrollWidth`
 * against `clientWidth` per row, not the presence of a CSS rule: a rule that is present and losing
 * to something else is exactly how this project's faults look (decision 71, four times over).
 */
export async function run(view, bar, doc) {
  const failures = [];
  let checked = 0;
  const check = (name, want, got, ok = want === got) => {
    checked += 1;
    if (!ok) failures.push({ case: `narrow · ${name}`, want: String(want), got: String(got) });
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  window.paneHost.loadNote("2026-09-12-1200-note.md", "Groceries\n", 0, false);
  window.paneHost.openActions();
  // Past the chips' 150ms transition, which starts from the stylesheet's own initial value.
  await sleep(400);

  const rows = [...doc.querySelectorAll(".actions__row")];
  check("the panel has its rows", true, rows.length >= 14, rows.length >= 14);

  // The one that matters. A label whose `scrollWidth` exceeds its box is a label wearing an
  // ellipsis, and at this width every one of them used to.
  const clipped = rows
    .map((row) => row.querySelector(".actions__label"))
    .filter((label) => label.scrollWidth > label.clientWidth)
    .map((label) => label.textContent);
  check(
    "no row's label is truncated",
    "none",
    clipped.length ? clipped.join(", ") : "none",
    clipped.length === 0
  );

  // And the space came from the chips rather than from somewhere that will be missed.
  // Only the rows that *have* a shortcut. Recently Deleted and Rename File… are deliberately
  // unbound (decisions 35, 103), and their empty chip group has no height either — which cost one
  // assertion a false red before the reason was read.
  const keys = rows
    .map((row) => row.querySelector(".actions__keys"))
    .filter((el) => el && el.querySelector("kbd"));
  check("the rows that have a shortcut still carry it", true, keys.length >= 13, keys.length >= 13);
  const widest = Math.max(...keys.map((el) => el.getBoundingClientRect().width));
  check("and they take no width", 0, Math.round(widest));

  // Not `display: none`: decision 41's rule is that nothing in the pane may use it, and a chip group
  // that is laid out but zero-wide is also what lets the width animate rather than snap.
  //
  // Read as **height**, not as a computed `display`. `getComputedStyle` is stale in this probe —
  // its window never becomes key — while `getBoundingClientRect` is not (2026-09-01), and a
  // `display: none` element has no height either, so the geometry answers the same question.
  const laidOut = keys.filter((el) => el.getBoundingClientRect().height > 0);
  check("hidden by width, never by display", keys.length, laidOut.length);

  return { checked, failures };
}
