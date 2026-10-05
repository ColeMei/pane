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

  // ---- Named from Swift's pointer alone, with no DOM mouse events -------------------------------
  //
  // The path that matters most and was dead until decision 120. In Pane's real configuration the page
  // receives *no* mouse events — an accessory app's non-activating panel that has not been clicked
  // (decision 107 measured zero against 22 in a key window) — so every case above this one, and every
  // tooltip in the shipped app, only worked after the pane had been clicked. Which is the state
  // nobody tests, because not having to click the pane is the point of the product.
  //
  // So this case sends nothing but the coordinates Swift sends, and asserts the bubble anyway.
  {
    await reset();
    // Swift raises `setHover` before it sends a position, and the order is load-bearing: dimmed
    // chrome is `pointer-events: none` (decision 41), so `elementFromPoint` returns the *container*
    // and finds no control at all until the pane is marked hovered. Mirror that here.
    window.paneHost.setHover(true);
    const box = second.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;

    window.paneHost.setPointer(cx, cy);
    check(
      "a control is not named the instant Swift's pointer arrives on it",
      "hidden",
      shown() ? "shown" : "hidden",
      !shown()
    );

    await sleep(DELAY + 200);
    check(
      "a control is named from Swift's pointer alone, with no DOM mouse event",
      "shown",
      shown() ? `shown: "${text()}"` : "hidden",
      shown()
    );
    check(
      "and it is the control the pointer is actually over",
      second.getAttribute("aria-label"),
      text(),
      squash(text()) === squash(second.getAttribute("aria-label"))
    );

    // ---- and the control under the pointer lights, not just the bubble ------------------------
    //
    // Reported alongside the tooltip fix: "only the tooltips — there is no like I hover on that."
    // Every chrome control still keyed its fill off `:hover`, which never matches here, so the bubble
    // named a button that stayed inert. Decision 107 gave the close dot `[data-close-hover]` and left
    // the rest; this is that mechanism generalised, so it is asserted the same way.
    check(
      "the control under the pointer is marked, so its fill has something to key off",
      "second button carries data-pointer",
      second.hasAttribute("data-pointer") ? "marked" : "not marked",
      second.hasAttribute("data-pointer")
    );
    check(
      "and only that one is marked",
      "exactly 1",
      String(doc.querySelectorAll("[data-pointer]").length),
      doc.querySelectorAll("[data-pointer]").length === 1
    );

    // Moving off every control is the only "left" signal there is — no mouseout ever arrives.
    window.paneHost.setPointer(4, 4);
    check(
      "and the mark goes with the pointer",
      "nothing marked",
      String(doc.querySelectorAll("[data-pointer]").length),
      doc.querySelectorAll("[data-pointer]").length === 0
    );
    check(
      "and it goes when Swift's pointer moves off every control",
      "hidden",
      shown() ? "shown" : "hidden",
      !shown()
    );
    window.paneHost.setHover(false);
  }

  // A bubble can exist in the DOM and still be behind the dialog it names. Include it in
  // hit-testing temporarily so the Window Server's WebKit engine tells us what is painted on top.
  function paintedOnTop(el) {
    const box = el.getBoundingClientRect();
    const pointerEvents = el.style.pointerEvents;
    el.style.pointerEvents = "auto";
    try {
      return [box.top + 3, box.top + box.height / 2, box.bottom - 3].every((y) => {
        const hit = doc.elementFromPoint(box.left + box.width / 2, y);
        return hit === el || el.contains(hit);
      });
    } finally {
      el.style.pointerEvents = pointerEvents;
    }
  }

  async function hoverRowButton(button) {
    window.paneHost.setPointer(4, 4);
    window.paneHost.setHover(true);
    button.closest(".switcher__row")?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const box = button.getBoundingClientRect();
    window.paneHost.setPointer(box.left + box.width / 2, box.top + box.height / 2);
    await sleep(DELAY + 200);
  }

  // ---- Dialog controls and toast overlap ------------------------------------------------------
  {
    const host = window.paneHost;
    host.loadNote("tooltip-test.md", "Tooltip test", 0, false);
    host.openSwitcher();
    host.showNotes([
      { filename: "tooltip-test.md", title: "Tooltip test", time: "now", preview: "", current: true },
      { filename: "other.md", title: "Other note", time: "1h", preview: "" },
      { filename: "third.md", title: "Third note", time: "2h", preview: "" },
    ], 3, "");
    const row = doc.querySelector('.switcher__row[data-index="1"]');
    for (const [selector, label, shortcut] of [
      ["[data-pin]", "Pin", "⌘⏎"],
      ["[data-delete]", "Delete", "⌃X"],
    ]) {
      await hoverRowButton(row.querySelector(selector));
      check(`${label} tooltip appears over the note list`, "visible above dialog", text(), shown() && paintedOnTop(tip()));
      check(`${label} tooltip retains its shortcut`, shortcut, tip().querySelector("kbd")?.textContent,
        tip().querySelector("kbd")?.textContent === shortcut);
      check(`${label} tooltip does not intercept clicks`, "none", getComputedStyle(tip()).pointerEvents,
        getComputedStyle(tip()).pointerEvents === "none");
    }

    // The explicit tooltip label can change while a hover is waiting out its delay.
    host.setPointer(4, 4);
    const deleteButton = row.querySelector("[data-delete]");
    const box = deleteButton.getBoundingClientRect();
    host.setPointer(box.left + box.width / 2, box.top + box.height / 2);
    deleteButton.dataset.tip = "Delete ⌥X";
    await sleep(DELAY + 200);
    check("a delayed tooltip reads its current explicit label", "⌥X", tip().querySelector("kbd")?.textContent,
      tip().querySelector("kbd")?.textContent === "⌥X");

    host.setPointer(4, 4);
    host.openActions();
    const deletedAction = [...doc.querySelectorAll(".actions__row")]
      .find((el) => el.textContent.includes("Recently Deleted"));
    deletedAction.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    host.showDeleted([
      { filename: "deleted-1.md", title: "Deleted one", time: "1h", preview: "" },
      { filename: "deleted-2.md", title: "Deleted two", time: "2h", preview: "" },
      { filename: "deleted-3.md", title: "Deleted three", time: "3h", preview: "" },
    ]);
    await hoverRowButton(doc.querySelector('.switcher__row[data-index="1"] [data-forget]'));
    check("permanent delete tooltip appears over Recently Deleted", "Delete permanently above dialog", text(),
      shown() && text() === "Delete permanently" && paintedOnTop(tip()));

    host.setPointer(4, 4);
    host.openSwitcher();
    host.showToast("This note was deleted elsewhere. Your other notes are still here.", 5000);
    await hoverRowButton(doc.getElementById("browse"));
    const tooltipBox = tip().getBoundingClientRect();
    const toastBox = doc.getElementById("toast").getBoundingClientRect();
    const overlaps = tooltipBox.left < toastBox.right && tooltipBox.right > toastBox.left
      && tooltipBox.top < toastBox.bottom && tooltipBox.bottom > toastBox.top;
    check("the toast fixture overlaps the title bar tooltip", "overlap", String(overlaps), overlaps);
    check("a title bar tooltip is painted above an overlapping toast", "visible above toast", text(),
      shown() && paintedOnTop(tip()));
    host.setHover(false);
  }

  // ---- The transient surfaces are one family --------------------------------------------------
  //
  // A guard on two declarations rather than on behaviour, and deliberately so. Three things in the
  // pane appear, say one line and leave — this bubble, the toast, and the auto-size pill — and the
  // shape is what says they are the same kind of thing. The pill is a native `NSPanel` below the
  // pane (a web view cannot paint outside its window) and is a capsule by construction: 13pt on a
  // 26pt height. The other two drifted to 7px and a stray 8px literal, which put them in the
  // *rectangle* family — the pane, the overlays, a ⌘K row, all things you can put a pointer into.
  //
  // Nothing here can see a corner. The probe's window is never key, so `getComputedStyle` is stale,
  // and a radius is not geometry this harness can measure. So what is pinned is the declaration,
  // and `999px` rather than a number is part of the claim: a radius tuned to today's height is a
  // constant that goes stale the moment the padding moves (decision 82).
  {
    const rules = [...doc.styleSheets]
      .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } });
    for (const selector of [".pane__tip", ".pane__toast"]) {
      const rule = rules.find((r) => r.selectorText === selector);
      check(`${selector} is declared`, "present", rule ? "present" : "missing", !!rule);
      check(
        `${selector} is a capsule, not a rounded rectangle`,
        "999px",
        rule ? rule.style.getPropertyValue("border-radius") : "?",
        !!rule && rule.style.getPropertyValue("border-radius") === "999px"
      );
    }
  }

  return { checked, failures };
}
