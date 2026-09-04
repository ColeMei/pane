/*
 * The bubble that names a control, and *when* it appears.
 *
 * On the same `editor-probe` as the other suites, and here for the reason decision 113 gives: this
 * is chrome behaviour that only exists on screen. But the question is time rather than geometry, so
 * every case waits out a real timer — which is why `run` is async and why the probe awaits it.
 *
 * The fault it was written for: the bubble appeared the instant the pointer touched a control, so
 * crossing the title bar on the way to the text produced three of them, none of them asked for.
 */

const DELAY = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(view, bar, doc) {
  const failures = [];
  let checked = 0;

  function check(name, want, got, ok) {
    checked += 1;
    if (!ok) failures.push({ case: name, want: String(want), got: String(got) });
  }

  const tip = () => doc.querySelector(".pane__tip");
  const shown = () => {
    const el = tip();
    return !!el && !el.hidden;
  };
  const text = () => (tip()?.textContent ?? "").trim();
  const squash = (s) => (s ?? "").replace(/\s+/g, "");

  const buttons = [...doc.querySelectorAll("button[aria-label]")].filter(
    (el) => el.offsetParent !== null && (el.getAttribute("aria-label") ?? "").length > 0
  );
  if (buttons.length < 2) {
    return {
      checked: 1,
      failures: [{ case: "two chrome buttons to hover", want: "2+", got: String(buttons.length) }],
    };
  }
  const [first, second] = buttons;

  const enter = (el) => {
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  };
  // The take-down is a *condition* on where the pointer is rather than a leave event — see the note
  // in tooltip.ts — so a move aimed elsewhere is what actually dismisses one.
  const away = () => doc.body.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  const reset = async () => {
    away();
    await sleep(60);
  };

  // ---- It does not appear immediately -----------------------------------------------------------
  await reset();
  enter(first);
  check("nothing appears the instant the pointer arrives", "hidden", shown() ? "shown" : "hidden", !shown());

  await sleep(DELAY * 0.5);
  check("still nothing halfway through the delay", "hidden", shown() ? "shown" : "hidden", !shown());

  // ---- ...and then it does ----------------------------------------------------------------------
  await sleep(DELAY * 0.8);
  check("named once the pointer has rested", "shown", shown() ? `shown: "${text()}"` : "hidden", shown());
  check(
    "and it carries the control's own accessible name",
    first.getAttribute("aria-label"),
    text(),
    squash(text()) === squash(first.getAttribute("aria-label"))
  );

  // ---- A pass-through is never answered ----------------------------------------------------------
  //
  // The case that matters most. Before the delay this bubbled at once; with a delay but no cancel it
  // would bubble *late*, over whatever the pointer had moved on to, which is worse than the original.
  await reset();
  enter(second);
  await sleep(DELAY * 0.4);
  away();
  await sleep(DELAY * 1.5);
  check(
    "a pointer that crosses a control and moves on is never answered",
    "hidden, even after the delay has elapsed",
    shown() ? `shown: "${text()}"` : "hidden",
    !shown()
  );

  // ---- Every control waits, including the one you move to next --------------------------------
  //
  // Reported from the build, and the report is the reason this section replaced its opposite. The
  // first version kept a warm window — show one bubble and the next control is instant, which is what
  // AppKit, Windows and Qt do and which reads as correct in the abstract. In the pane it meant that
  // moving from ⌘P to ⌘K was indistinguishable from having no delay, so the delay could not be felt
  // in the one place people actually read chrome: along a row, one control after another.
  //
  // So this is the assertion that says the feature exists at all.
  await reset();
  enter(first);
  await sleep(DELAY + 200);
  check("the first control is named after the delay", "shown", shown() ? "shown" : "hidden", shown());

  away();
  enter(second);
  check(
    "the next control along the row waits too, rather than answering instantly",
    "hidden immediately after arriving",
    shown() ? `shown: "${text()}"` : "hidden",
    !shown()
  );
  await sleep(DELAY * 0.5);
  check(
    "and is still waiting halfway through its own delay",
    "hidden",
    shown() ? "shown" : "hidden",
    !shown()
  );
  await sleep(DELAY * 0.8);
  check(
    "then it is named on its own account",
    "shown",
    shown() ? `shown: "${text()}"` : "hidden",
    shown()
  );
  away();

  return { checked, failures };
}
