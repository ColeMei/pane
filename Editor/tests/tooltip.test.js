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

  // ---- Issue 7: a bubble is never under the thing it names, and it keeps its key ----------------
  //
  // Decision 182. Reported: resting on a row's pin or ✕ in ⌘P showed no bubble — it was painted
  // under the list — and over a toast the title bar's bubbles were cut off. And the rows' bubbles
  // said "Pin" and "Delete" with no key. Driven the way the pane really is, through Swift's
  // `setPointer`, and asserted on paint order: the bubble's own centre is hit-tested with its
  // `pointer-events` let through for the one read, so what comes back is whatever is drawn on top.
  {
    const centre = (el) => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    };
    const onTop = () => {
      const el = tip();
      if (!el || el.hidden) return "no bubble";
      const was = el.style.pointerEvents;
      el.style.pointerEvents = "auto";
      const [x, y] = centre(el);
      const hit = doc.elementFromPoint(x, y);
      el.style.pointerEvents = was;
      return hit && (hit === el || el.contains(hit)) ? "bubble" : (hit?.className || hit?.tagName || "nothing");
    };
    const restOn = async (el) => {
      window.paneHost.setHover(true);
      window.paneHost.setPointer(...centre(el));
      await sleep(DELAY * 1.3);
    };
    const leave = async () => {
      window.paneHost.setPointer(4, 4);
      window.paneHost.setHover(false);
      await sleep(60);
    };
    const notes = Array.from({ length: 6 }, (_, i) => ({
      filename: `2026-10-0${i + 1}-1200-tip-${i}.md`,
      title: `Tip note ${i}`,
      time: "9 Oct",
      preview: "",
      band: "Today",
    }));

    await leave();
    doc.getElementById("browse").click();
    window.paneHost.showNotes(notes, notes.length, "");
    for (const [what, selector, want] of [
      ["pin", "[data-pin]", "Pin ⌘⏎"],
      ["✕", "[data-delete]", "Delete ⌃X"],
    ]) {
      const button = doc.querySelector(`.switcher__row ${selector}`);
      await restOn(button);
      check(`(182) a row's ${what} in ⌘P: the bubble is drawn over the list`, "bubble", onTop(), onTop() === "bubble");
      check(`(182) a row's ${what} in ⌘P: the bubble carries its key`, want, text(), squash(text()) === squash(want));
      await leave();
    }
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    doc.getElementById("switcher-search")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    window.paneHost.showToast("A long receipt that runs the whole width of the pane, under the title bar's buttons", 5000);
    await restOn(doc.getElementById("browse"));
    check("(182) a title-bar bubble is drawn over a toast", "bubble", onTop(), onTop() === "bubble");
    await leave();
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
