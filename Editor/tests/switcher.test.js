/*
 * The ⌘P switcher's geometry: what the arrow keys actually put on screen.
 *
 * The third suite driven by `Scripts/editor-probe.swift`, and it exists for the same reason the
 * markdown suite does — the bug it was written for is invisible to anything that only reads the DOM.
 * The rows were right, the selection was right, the scroll offset was right, and the list still
 * looked broken, because a `position: absolute` overlay inside a scroll container scrolls with the
 * content: the bottom fade rode up into the middle of the list and washed out whichever row it
 * landed on. Nothing short of measuring painted boxes catches that.
 *
 * So every assertion here is a rectangle, compared against the rectangle of the thing that must not
 * cover it.
 *
 * ⌘K is measured here too rather than in a file of its own. The two panels are one component in two
 * modes (decision 46), they are placed by one calculation and now capped by one token, and the way
 * that arrangement breaks is a row of one of them ending up somewhere no key can reach.
 */

const BANDS = ["Yesterday", "This week", "August", "July", "June"];

function notes(count) {
  return Array.from({ length: count }, (_, i) => ({
    filename: `2026-08-${String((i % 28) + 1).padStart(2, "0")}-1200-note-${i}.md`,
    title: `Note number ${i}`,
    time: "23 Aug",
    preview: `first line of body for note ${i}`,
    band: BANDS[Math.floor(i / 6)] ?? BANDS[BANDS.length - 1],
  }));
}

export function run(view, bar, doc) {
  const failures = [];
  let checked = 0;

  function check(name, want, got, ok) {
    checked += 1;
    if (!ok) failures.push({ case: name, want: String(want), got: String(got) });
  }

  const root = doc.getElementById("switcher");
  const list = doc.getElementById("switcher-list");
  const search = doc.getElementById("switcher-search");

  function openWith(count) {
    if (!doc.querySelector(".pane").hasAttribute("data-switcher")) {
      doc.getElementById("browse").click();
    }
    window.paneHost.showNotes(notes(count), count, "");
    list.scrollTop = 0;
  }

  const press = (key) =>
    search.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

  const fadeEl = () => doc.querySelector(".switcher__fade");
  const fadeHeight = () => parseFloat(getComputedStyle(fadeEl()).height) || 0;
  const fadeShown = () => getComputedStyle(fadeEl()).display !== "none";
  const groupPad = () =>
    parseFloat(getComputedStyle(list).scrollPaddingTop) || 0;

  // ---- The fade is pinned to the bottom edge, at every scroll offset --------------------------
  //
  // The original bug, stated as arithmetic: the fade's offset from the top of the viewport used to
  // fall by exactly `scrollTop`, so one flick down put a grey gradient across the middle of the list.
  openWith(30);
  {
    const h = fadeHeight();
    for (const target of [0, 100, 200, 400, list.scrollHeight]) {
      list.scrollTop = target;
      if (!fadeShown()) continue;  // at the end of the list it is hidden, tested below
      const lb = list.getBoundingClientRect();
      const fb = fadeEl().getBoundingClientRect();
      const bottomGap = Math.round(lb.top + list.clientHeight - fb.bottom);
      check(
        `fade is pinned to the bottom edge at scrollTop ${Math.round(list.scrollTop)}`,
        `flush with the bottom edge, ${h}px tall`,
        `${bottomGap}px above the bottom edge, ${Math.round(fb.height)}px tall`,
        Math.abs(bottomGap) <= 1 && Math.abs(fb.height - h) <= 1
      );
    }
  }

  // ---- The fade only claims there is more below when there is ---------------------------------
  openWith(30);
  list.scrollTop = list.scrollHeight;
  check("fade is gone at the end of a long list", "hidden", fadeShown() ? "shown" : "hidden", !fadeShown());

  openWith(3);
  check("fade is gone when the list does not scroll", "hidden", fadeShown() ? "shown" : "hidden", !fadeShown());

  // ---- Arrow keys never park the selection under the fade, or under a band header --------------
  //
  // `scrollIntoView({ block: "nearest" })` parks a row flush against whichever edge it came from,
  // and both edges are occupied. The list's `scroll-padding` is what holds it clear; these are the
  // assertions that say so.
  openWith(30);
  {
    const pad = groupPad();
    const sweep = [...Array(29).fill("ArrowDown"), ...Array(29).fill("ArrowUp")];
    let worstBottom = 0;
    let worstTop = 0;

    for (const key of sweep) {
      press(key);
      const sel = list.querySelector('[aria-selected="true"]');
      const lb = list.getBoundingClientRect();
      const sb = sel.getBoundingClientRect();
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      const atTop = list.scrollTop <= 1;

      // Below: the fade is hidden at the very end, so only a scrolled list has to hold clear of it.
      if (!atEnd) {
        const under = sb.bottom - (lb.top + list.clientHeight - fadeHeight());
        worstBottom = Math.max(worstBottom, Math.round(under));
      }
      // Above: at scrollTop 0 there is nothing to reveal, so the first rows are exempt.
      if (!atTop) {
        const short = lb.top + pad - sb.top;
        worstTop = Math.max(worstTop, Math.round(short));
      }
    }

    check(
      "no arrow key leaves the selected row under the bottom fade",
      "0px of the row under the gradient",
      `${worstBottom}px under the gradient at the worst step`,
      worstBottom <= 1
    );
    check(
      "no arrow key leaves the selected row tight against the top edge",
      `at least ${pad}px of room above the row, for the band header`,
      `${worstTop}px short of it at the worst step`,
      worstTop <= 1
    );
  }

  // ---- A band's first row arrives with the header that names it --------------------------------
  //
  // The reason the top padding is a band header's height and not an arbitrary margin: the bands are
  // the switcher's landmarks (see the note at the top of switcher.css), and a landmark that scrolls
  // out of frame with the row it labels is not one.
  openWith(30);
  {
    // Scroll a band boundary to the very top of the viewport, so the header is exactly off-screen,
    // then arrow onto the row underneath it.
    const rows = [...list.querySelectorAll(".switcher__row")];
    const first = rows.find(
      (r) => r.previousElementSibling?.classList.contains("switcher__group") && r.offsetTop > 200
    );
    const index = Number(first.dataset.index);
    for (let i = 0; i < index + 1; i++) press("ArrowDown");
    list.scrollTop = first.offsetTop;
    press("ArrowUp");
    press("ArrowDown");

    const lb = list.getBoundingClientRect();
    const hb = first.previousElementSibling.getBoundingClientRect();
    check(
      "a band header is on screen with the first row of its band",
      "header fully inside the list",
      `header top is ${Math.round(hb.top - lb.top)}px from the list's top edge`,
      hb.top - lb.top >= -1
    );
  }

  // ---- The arrow keys stop at the ends -----------------------------------------------------------
  //
  // Measured against Raycast Notes, the reference this panel is built to: ArrowDown on its last row
  // moves neither the selection nor the scroll offset, and ArrowUp on its first does the same. The
  // switcher used to wrap, which read as the list jumping back to the top of its own accord.
  openWith(30);
  {
    for (let i = 0; i < 40; i++) press("ArrowDown");
    const atEnd = Number(list.querySelector('[aria-selected="true"]').dataset.index);
    const scrollAtEnd = list.scrollTop;
    press("ArrowDown");
    check(
      "ArrowDown stops on the last row instead of wrapping",
      "row 29, and the list does not move",
      `row ${Number(list.querySelector('[aria-selected="true"]').dataset.index)}, scrollTop ` +
        `${Math.round(list.scrollTop)} (was ${Math.round(scrollAtEnd)})`,
      atEnd === 29 &&
        Number(list.querySelector('[aria-selected="true"]').dataset.index) === 29 &&
        Math.abs(list.scrollTop - scrollAtEnd) <= 1
    );

    for (let i = 0; i < 40; i++) press("ArrowUp");
    const scrollAtTop = list.scrollTop;
    press("ArrowUp");
    check(
      "ArrowUp stops on the first row instead of wrapping",
      "row 0, and the list does not move",
      `row ${Number(list.querySelector('[aria-selected="true"]').dataset.index)}, scrollTop ` +
        `${Math.round(list.scrollTop)} (was ${Math.round(scrollAtTop)})`,
      Number(list.querySelector('[aria-selected="true"]').dataset.index) === 0 &&
        Math.abs(list.scrollTop - scrollAtTop) <= 1
    );
  }

  // ---- Selecting a row must not change its height ----------------------------------------------
  //
  // The row's buttons are `visibility: hidden` rather than absent precisely so that the list does
  // not reflow under the selection. A reflow here would make every measurement above meaningless.
  openWith(30);
  {
    const rows = [...list.querySelectorAll(".switcher__row")];
    const heights = new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height * 10)));
    check(
      "a selected row is the same height as an unselected one",
      "one row height throughout the list",
      [...heights].map((h) => h / 10).join(", "),
      heights.size === 1
    );
  }

  // ---- The two overlays are one rectangle ---------------------------------------------------------
  //
  // The pane grows to hold whichever panel is open (decision 45), so a panel's height is a window
  // size. ⌘K had no ceiling at all and asked the pane for 744pt to show sixteen rows of menu, while
  // ⌘P asked for 676 — two different windows for the same slot. The ceiling is on the panels rather
  // than on the lists inside them precisely so that this assertion can exist: the switcher carries a
  // footer ⌘K does not, so equal lists would mean unequal panels.
  const CEILING = Number.parseFloat(
    getComputedStyle(doc.documentElement).getPropertyValue("--overlay-panel-height")
  );

  openWith(30);
  const switcherPanel = Math.round(root.offsetHeight);
  const switcherViewport = list.clientHeight;

  press("Escape");
  doc.getElementById("open-actions").click();
  const actions = doc.getElementById("actions");
  const actionsList = doc.getElementById("actions-list");
  const actionsSearch = doc.getElementById("actions-search");
  const actionRows = actionsList.querySelectorAll(".actions__row").length;
  const actionsPanel = Math.round(actions.offsetHeight);

  check(
    "a full ⌘P and a full ⌘K are the same height",
    `both ${CEILING}pt`,
    `⌘P ${switcherPanel}pt, ⌘K ${actionsPanel}pt`,
    switcherPanel === actionsPanel && switcherPanel === CEILING
  );
  check(
    "the action list scrolls rather than growing the panel to hold every row",
    `content taller than the ${actionsList.clientHeight}px viewport`,
    `content ${actionsList.scrollHeight}px in a ${actionsList.clientHeight}px viewport`,
    actionsList.scrollHeight > actionsList.clientHeight + 1
  );
  check(
    "the switcher's footer comes out of its list, not out of its panel",
    "a ⌘K list taller than the switcher's by the footer's height",
    `⌘P list ${switcherViewport}px, ⌘K list ${actionsList.clientHeight}px`,
    actionsList.clientHeight > switcherViewport
  );

  // ---- The ceiling is a ceiling, not a height ------------------------------------------------------
  //
  // A pane must not grow for rows that are not there. Four notes get a four-note switcher, and a ⌘K
  // filtered down to a couple of rows is a couple of rows tall.
  {
    actionsSearch.value = "note";
    actionsSearch.dispatchEvent(new Event("input", { bubbles: true }));
    const filtered = Math.round(actions.offsetHeight);
    check(
      "a filtered ⌘K shrinks to what it is showing",
      `shorter than the ${CEILING}pt ceiling`,
      `${filtered}pt`,
      filtered < CEILING && filtered > 0
    );

    actionsSearch.value = "";
    actionsSearch.dispatchEvent(new Event("input", { bubbles: true }));
    openWith(3);
    const small = Math.round(root.offsetHeight);
    check(
      "a three-note switcher shrinks to what it is showing",
      `shorter than the ${CEILING}pt ceiling`,
      `${small}pt`,
      small < CEILING && small > 0
    );
    press("Escape");
    doc.getElementById("open-actions").click();
  }

  // ---- and the rows below the fold are still reachable ------------------------------------------
  //
  // This is the assertion the cap has to earn. It was removed once precisely because a capped list
  // put Delete Note below the fold with no way to get to it; it is back because the arrow keys now
  // carry the selection there and scroll it into view.
  {
    for (let i = 0; i < actionRows + 5; i++)
      actionsSearch.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
      );
    const sel = actionsList.querySelector('[aria-selected="true"]');
    const lb = actionsList.getBoundingClientRect();
    const sb = sel.getBoundingClientRect();
    const label = sel.querySelector(".actions__label")?.textContent ?? "?";
    check(
      "the last action is reachable by keyboard and on screen when it is",
      "the last row selected, fully inside the viewport",
      `"${label}" at [${Math.round(sb.top - lb.top)}, ${Math.round(sb.bottom - lb.top)}]` +
        ` of 0..${actionsList.clientHeight}`,
      sel === actionsList.querySelectorAll(".actions__row")[actionRows - 1] &&
        sb.top - lb.top >= -1 &&
        sb.bottom - lb.top <= actionsList.clientHeight + 1
    );
  }

  return { checked, failures };
}
