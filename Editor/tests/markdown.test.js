/*
 * The markdown torture suite: what a text worker actually does to an editor.
 *
 * Separate from `commands.test.js` because it asks a different question. That file is about the
 * **commands** — eleven of them against every shape of selection. This one is about the
 * **keyboard**: what a person typing markdown gets, measured against our locked decisions first,
 * CommonMark second, and Typora third.
 *
 * It started as an instrument, printing divergences and exiting 0 while eleven of them waited for a
 * decision. All eleven are fixed, so it is a gate now: red means a regression.
 *
 * Two things make it different from everything already here:
 *
 * 1. **It types.** Every case in `commands.test.js` sets a document and presses a command. Nothing
 *    in this repo has ever driven the editor a keystroke at a time, and every list bug this project
 *    has had was found by a person typing (decisions 85, 100, 103). Typing goes through the
 *    `EditorView.inputHandler` facet, which is where `bulletInputRule` and `checkboxInputRule` live,
 *    so `- ` and `[] ` behave here exactly as they do under a real keyboard.
 *
 * 2. **It looks.** Bytes are only half the claim. A nested list whose bytes are right and whose
 *    third level renders at the second level's indent is still broken, so structure (which
 *    decoration classes and widgets landed where) and geometry (where the marker and the text
 *    actually are, in pixels) are asserted alongside the buffer.
 *
 * Not asserted: colour and anything else needing `getComputedStyle` on a painted value. The probe's
 * window is offscreen and never key, and computed values are stale there (measured).
 */

// ------------------------------------------------------------------------------------------------
// The keyboard
// ------------------------------------------------------------------------------------------------

const KEYCODE = {
  Enter: 13, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40,
  ArrowLeft: 37, ArrowRight: 39, Escape: 27,
};

/**
 * A driver that types the way a person does.
 *
 * `view.dispatch` is not typing. Real input reaches CodeMirror through the `inputHandler` facet
 * first, and Pane puts two rules in there — the one that makes `[] ` a checkbox and the one that
 * makes a new bullet take the marker the list above it is using (decision 59). A case that
 * dispatched its text straight into the document would skip both and quietly test nothing.
 *
 * The facet is reached off `view.constructor` because this module is imported as a data: URL and
 * has no access to the bundle's own imports. `EditorView.inputHandler` is a static, and esbuild
 * keeps it.
 */
function driver(view, doc) {
  const EditorView = view.constructor;
  const content = doc.querySelector(".cm-content");

  const type = (text) => {
    for (const ch of text) {
      const { from, to } = view.state.selection.main;
      const handlers = view.state.facet(EditorView.inputHandler);
      // The fifth argument is CodeMirror's `defaultInsert`, and it has to be the real thing: it
      // returns the transaction the plain insert *would* have made, and `autoCloseTags` — which is
      // live in Pane, because markdown embeds HTML — reads `.state` off it. A stand-in returning a
      // plain object throws on every `>` that closes a tag, which is one confident false bug report
      // this file already produced.
      const defaultInsert = () => view.state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: "input.type",
        scrollIntoView: true,
      });
      let handled = false;
      for (const handler of handlers) {
        if (handler(view, from, to, ch, defaultInsert)) {
          handled = true;
          break;
        }
      }
      if (handled) continue;
      view.dispatch({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: "input.type",
      });
    }
  };

  const press = (key, mods = {}) =>
    content.dispatchEvent(new KeyboardEvent("keydown", {
      key,
      code: key,
      keyCode: KEYCODE[key] ?? 0,
      bubbles: true,
      cancelable: true,
      ...mods,
    }));

  /** A fresh note. Not an edit — a note arriving from Swift is not something you can undo. */
  const reset = () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    view.dispatch({ selection: { anchor: 0 } });
  };

  /** A note that already existed, as if opened. Same reason: not an edit. */
  const load = (text) => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    view.dispatch({ selection: { anchor: 0 } });
  };

  const at = (needle, offset = 0) => {
    const index = view.state.doc.toString().indexOf(needle);
    if (index < 0) throw new Error(`no ${JSON.stringify(needle)} in the document`);
    view.dispatch({ selection: { anchor: index + offset } });
  };

  const text = () => view.state.doc.toString();

  return { type, press, reset, load, at, text, content };
}

/** A recorder that counts what passed and keeps what did not, with the keystrokes that got there. */
function recorder(section) {
  const failures = [];
  let checked = 0;
  return {
    get checked() { return checked; },
    failures,
    check(name, want, got, keys) {
      checked += 1;
      if (Object.is(want, got)) return true;
      failures.push({
        case: `${section} · ${name}${keys ? `  [${keys}]` : ""}`,
        want: show(want),
        got: show(got),
      });
      return false;
    },
  };
}

/** Newlines and spaces are the subject here, so they are printed rather than left invisible. */
function show(value) {
  if (typeof value !== "string") return String(value);
  return value.replace(/\n/g, "⏎").replace(/ /g, "·");
}

// ------------------------------------------------------------------------------------------------
// Reading the rendering
// ------------------------------------------------------------------------------------------------

/** Half a pixel matters here — the list lead-in is 6.5 — so these round to a tenth, not to a whole. */
const round = (value) => Math.round(value * 10) / 10;

function inspector(view, doc) {
  const lineEl = (n) => {
    const at = view.domAtPos(view.state.doc.line(n).from);
    const node = at.node.nodeType === 1 ? at.node : at.node.parentElement;
    return node.closest(".cm-line");
  };

  /** Every `pane-line-li-N` class on the line, in the order the DOM carries them. */
  const depthClasses = (n) => {
    const el = lineEl(n);
    if (!el) return [];
    return [...el.classList].filter((c) => /^pane-line-li-\d$/.test(c)).map((c) => Number(c.slice(-1)));
  };

  /**
   * The level the line is actually indented to.
   *
   * The **max**, not the first, and that is a finding rather than a detail: a nested line carries
   * its own class *and* every ancestor item's, because a `ListItem`'s range covers the list beneath
   * it. The four rules are equal specificity, so which one wins is decided by their order in
   * `markdown.css` — deepest last, so deepest wins, and the rendering is right for a reason nobody
   * wrote down. Reordering that block would silently un-indent every nested list in the app.
   */
  const renderedDepth = (n) => {
    const levels = depthClasses(n);
    return levels.length ? Math.max(...levels) : 0;
  };

  /** What the reader sees standing in for the marker: a glyph, a number, a checkbox, or the raw text. */
  const marker = (n) => {
    const el = lineEl(n);
    if (!el) return null;
    // A bullet is a drawn shape rather than a character now (decision 122), so what identifies it
    // is which shape was asked for. The three names stand in for the three glyphs that used to be
    // set here, so the cases below still read as "level two draws a ring".
    const bullet = el.querySelector(".pane-list-marker");
    if (bullet) {
      const depth = [...bullet.classList].find((c) => c.startsWith("pane-bullet-"));
      return { "pane-bullet-1": "•", "pane-bullet-2": "◦", "pane-bullet-3": "▪" }[depth] ?? "?";
    }
    // Trimmed: the rendered box holds the marker *and* the space after it, so that it is the same
    // width as the raw one under the caret. What this reader is asked is which number, not how wide.
    const number = el.querySelector(".pane-list-number");
    if (number) return number.textContent.trim();
    const task = el.querySelector(".pane-task");
    if (task) return task.className.includes("--done") ? "[x]" : "[ ]";
    const raw = el.querySelector(".pane-syntax-listmark");
    if (raw) return `raw:${raw.textContent}`;
    return "";
  };

  /** Left edge of the first painted thing on the line — the marker when there is one. */
  const leftEdge = (n) => {
    const el = lineEl(n);
    if (!el) return null;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    return rects.length ? round(rects[0].left) : null;
  };

  /** Left edge of the item's *text*, which is what has to line up down a level. */
  const textEdge = (n) => {
    const el = lineEl(n);
    if (!el) return null;
    const skip = new Set(["pane-list-marker", "pane-list-number", "pane-task", "pane-syntax-listmark"]);
    for (const node of el.childNodes) {
      if (node.nodeType === 1 && [...node.classList].some((c) => skip.has(c))) continue;
      const range = doc.createRange();
      range.selectNodeContents(node.nodeType === 1 ? node : el);
      if (node.nodeType !== 1) range.setStart(node, 0), range.setEnd(node, node.length);
      const rect = [...range.getClientRects()].filter((r) => r.width > 0)[0];
      if (rect) return round(rect.left);
    }
    return null;
  };

  const height = (n) => Math.round(lineEl(n).getBoundingClientRect().height);

  /** Where the editor's text column starts, so an indent can be measured from its own origin. */
  const contentOrigin = () => {
    const el = doc.querySelector(".cm-content");
    return round(el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft));
  };

  /** The left edge of a marker's **ink**, not of the box it is centred in — decision 122.
   *
   * `leftEdge` returns the first painted rect, and an `inline-block` marker paints its whole box,
   * so it answers "where does the slot start" and not "where is the dot". Those were the same
   * number while markers were left-aligned in the slot, and the reference's 6.5 is the second one. */
  const markerInk = (n) => {
    const el = lineEl(n);
    const marker = el?.querySelector(".pane-list-marker, .pane-list-number, .pane-task");
    if (!marker) return null;
    const rect = (() => {
      if (marker.classList.contains("pane-task")) return marker.getBoundingClientRect();
      // A drawn bullet has no text to measure, and its shape is centred in the box by the
      // stylesheet, so the box's centre *is* the ink's centre. Width is the shape's, not the box's.
      // The drawn shape is a real element precisely so it can be measured here.
      const shape = marker.querySelector("i");
      if (shape) return shape.getBoundingClientRect();
      const walker = doc.createTreeWalker(marker, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.replace(/\s/g, "").length) continue;
        const range = doc.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect();
      }
      return null;
    })();
    if (!rect) return null;
    return { left: round(rect.left), right: round(rect.right),
             centre: round((rect.left + rect.right) / 2),
             middle: round((rect.top + rect.bottom) / 2) };
  };

  /** The vertical middle of the line's own text, to check a marker against — decision 122.
   *
   * Every geometry case in this file measured horizontal positions, so a marker painted near the
   * bottom of its line passed all of them. Reported on sight: "why are the two dots much lower". */
  const textMiddle = (n) => {
    const el = lineEl(n);
    const skip = ["pane-list-marker","pane-list-number","pane-task","pane-syntax-listmark",
                  "pane-syntax-taskmark"];
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      let p = node.parentElement, inside = false;
      while (p && p !== el) { if (skip.some((c) => p.classList.contains(c))) { inside = true; break; } p = p.parentElement; }
      if (inside || !node.textContent.trim().length) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      return round((r.top + r.bottom) / 2);
    }
    return null;
  };

  /** Where a given word is actually painted on the line — decision 122.
   *
   * `textEdge` answers where the line's first non-marker *node* starts, and that was not enough:
   * a task's `[ ] ` was literal text at the head of that same node, so the node began in the right
   * place while every word after it sat 24px right. The question a reader asks is where the words
   * are, so this finds the word. */
  const wordEdge = (n, word) => {
    const el = lineEl(n);
    if (!el) return null;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(word);
      if (at < 0) continue;
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const rect = [...range.getClientRects()].filter((r) => r.width > 0)[0];
      if (rect) return round(rect.left);
    }
    return null;
  };

  /** Every decoration class on the line, so a construct can say what it rendered as. */
  const classes = (n) => [...lineEl(n).classList].filter((c) => c.startsWith("pane-")).sort().join(" ");

  /** Everything the line actually puts on screen. `hide` is a replace decoration, so hidden source
   * is not in the DOM at all and `textContent` is already the truth. */
  const visibleText = (n) => lineEl(n).textContent;

  return { lineEl, renderedDepth, depthClasses, marker, leftEdge, textEdge, height, classes,
           visibleText, contentOrigin, markerInk, wordEdge, textMiddle };
}

// ------------------------------------------------------------------------------------------------
// A. Lists, built the way a person builds them
// ------------------------------------------------------------------------------------------------

/**
 * Every case here is a keystroke script, and every expectation is what Typora and Obsidian both do
 * unless a locked decision says otherwise. Where our editor disagrees the case is red, which is the
 * point of the file.
 */
export function runTypedLists(view, doc) {
  const r = recorder("typed lists");
  const d = driver(view, doc);

  // --- one level, each kind ---------------------------------------------------------------------

  d.reset();
  d.type("- alpha");
  d.press("Enter");
  d.type("bravo");
  r.check("Enter continues a bulleted list", "- alpha\n- bravo", d.text(), "- alpha ⏎ bravo");

  d.reset();
  d.type("1. alpha");
  d.press("Enter");
  d.type("bravo");
  r.check("Enter continues a numbered list", "1. alpha\n2. bravo", d.text(), "1. alpha ⏎ bravo");

  d.reset();
  d.type("- [] alpha");
  r.check("[] becomes a checkbox as you type", "- [ ] alpha", d.text(), "- [] alpha");

  d.reset();
  d.type("- [] alpha");
  d.press("Enter");
  d.type("bravo");
  r.check("Enter continues a task list", "- [ ] alpha\n- [ ] bravo", d.text(), "- [] alpha ⏎ bravo");

  // Decision 59: a new bullet takes the marker the list above it is using.
  d.reset();
  d.type("* alpha");
  d.press("Enter");
  d.type("bravo");
  r.check("a starred list stays starred", "* alpha\n* bravo", d.text(), "* alpha ⏎ bravo");

  d.reset();
  d.type("+ alpha");
  d.press("Enter");
  d.type("bravo");
  r.check("a plus list stays plus", "+ alpha\n+ bravo", d.text(), "+ alpha ⏎ bravo");

  // `1)` is CommonMark's other ordered delimiter, and a file can arrive carrying it.
  d.reset();
  d.type("1) alpha");
  d.press("Enter");
  d.type("bravo");
  r.check("a paren-delimited list continues as itself", "1) alpha\n2) bravo", d.text(),
    "1) alpha ⏎ bravo");

  // --- going down: Tab ---------------------------------------------------------------------------

  // A nested item has to be indented to where its parent's *text* starts, or the file means
  // something else everywhere but here: 2 under `- `, 3 under `1. `. CommonMark decides this, and
  // Typora and Obsidian both indent to the content column.
  d.reset();
  d.type("- alpha");
  d.press("Enter");
  d.press("Tab");
  d.type("bravo");
  r.check("Tab nests under a bullet", "- alpha\n  - bravo", d.text(), "- alpha ⏎ ⇥ bravo");

  d.reset();
  d.type("1. alpha");
  d.press("Enter");
  d.press("Tab");
  d.type("bravo");
  r.check("Tab nests under a number", "1. alpha\n   1. bravo", d.text(), "1. alpha ⏎ ⇥ bravo");

  d.reset();
  d.type("- [] alpha");
  d.press("Enter");
  d.press("Tab");
  d.type("bravo");
  r.check("Tab nests under a task", "- [ ] alpha\n  - [ ] bravo", d.text(),
    "- [] alpha ⏎ ⇥ bravo");

  // Three levels, which is where a per-level indent that is wrong compounds.
  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Enter"); d.press("Tab"); d.type("three");
  r.check("three bulleted levels", "- one\n  - two\n    - three", d.text(),
    "- one ⏎ ⇥ two ⏎ ⇥ three");

  d.reset();
  d.type("1. one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Enter"); d.press("Tab"); d.type("three");
  r.check("three numbered levels", "1. one\n   1. two\n      1. three", d.text(),
    "1. one ⏎ ⇥ two ⏎ ⇥ three");

  // Four, because `pane-line-li-4` exists and something has to reach it.
  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Enter"); d.press("Tab"); d.type("three");
  d.press("Enter"); d.press("Tab"); d.type("four");
  r.check("four bulleted levels", "- one\n  - two\n    - three\n      - four", d.text(),
    "- one ⏎⇥ two ⏎⇥ three ⏎⇥ four");

  // Tab in the middle of an item's text indents the item, it does not insert a tab stop.
  d.reset();
  d.type("- alpha");
  d.press("Enter");
  d.type("bravo");
  d.at("bravo", 2);
  d.press("Tab");
  r.check("Tab with the caret inside the text still indents the item", "- alpha\n  - bravo",
    d.text(), "caret mid-word, ⇥");

  // The first item of a list has nothing to be a child of. Pressing Tab there used to fall through
  // to CodeMirror's generic `indentMore`, which put two spaces in front of the marker and then four
  // — and four spaces under a blank line is an indented code block to pandoc, not a list at all.
  // Refusing has to mean the key is *consumed*, not handed on.
  d.reset();
  d.type("- one");
  d.press("Tab");
  r.check("Tab on the first item of a list does nothing", "- one", d.text(), "- one ⇥");

  d.reset();
  d.type("- one");
  d.press("Tab");
  d.press("Tab");
  r.check("Tab on the first item does nothing twice either", "- one", d.text(), "- one ⇥ ⇥");

  d.reset();
  d.type("1. one");
  d.press("Tab");
  r.check("Tab on the first item of a numbered list does nothing", "1. one", d.text(), "1. one ⇥");

  // The same guard on the second level: an item that is already the first child of its parent has
  // no sibling above it to nest under either.
  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Tab");
  r.check("Tab on the first item of a nested list does nothing", "- one\n  - two", d.text(),
    "- one ⏎ ⇥ two ⇥");

  // --- coming back up: Shift-Tab -----------------------------------------------------------------

  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Enter"); d.press("Tab"); d.type("three");
  d.press("Tab", { shiftKey: true });
  r.check("Shift-Tab outdents one level", "- one\n  - two\n  - three", d.text(),
    "⇧⇥ on the third level");

  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Tab", { shiftKey: true });
  d.press("Tab", { shiftKey: true });
  r.check("Shift-Tab at the top level does nothing", "- one\n- two", d.text(),
    "⇧⇥ twice from level two");

  // --- leaving: Enter on an empty marker ---------------------------------------------------------

  // One level at a time, which is what every notes editor does and what decision 43 says for quotes.
  // Straight to a paragraph from three levels down loses two levels of structure on one keystroke.
  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Enter"); d.press("Tab"); d.type("three");
  d.press("Enter");
  d.press("Enter");
  d.type("back");
  r.check("Enter on an empty third-level item comes back one level",
    "- one\n  - two\n    - three\n  - back", d.text(), "⏎ ⏎ back");

  d.reset();
  d.type("- one");
  d.press("Enter");
  d.press("Enter");
  d.type("para");
  r.check("Enter on an empty top-level item leaves the list", "- one\n\npara", d.text(),
    "- one ⏎ ⏎ para");

  d.reset();
  d.type("1. one");
  d.press("Enter");
  d.press("Enter");
  d.type("para");
  r.check("and the same for a numbered list", "1. one\n\npara", d.text(),
    "1. one ⏎ ⏎ para");

  d.reset();
  d.type("- [] one");
  d.press("Enter");
  d.press("Enter");
  d.type("para");
  r.check("and for a task list", "- [ ] one\n\npara", d.text(), "- [] one ⏎ ⏎ para");

  // --- mixed kinds ------------------------------------------------------------------------------

  // Enter has already put a marker on the new line, so nobody types `1. ` after it — they press
  // the key for the kind they want. ⇧⌘7/8/9 are the sanctioned path and are what the format bar's
  // buttons run (decision 100).
  const convert = (digit) => d.press(digit, {
    metaKey: true, shiftKey: true, code: `Digit${digit}`, keyCode: digit.charCodeAt(0),
  });

  d.reset();
  d.type("- alpha");
  d.press("Enter"); d.press("Tab"); convert("7"); d.type("one");
  d.press("Enter"); d.type("two");
  r.check("a numbered list nested under a bullet", "- alpha\n  1. one\n  2. two", d.text(),
    "- alpha ⏎⇥ ⇧⌘7 one ⏎ two");

  d.reset();
  d.type("1. alpha");
  d.press("Enter"); d.press("Tab"); convert("8"); d.type("one");
  d.press("Enter"); d.type("two");
  r.check("a bulleted list nested under a number", "1. alpha\n   - one\n   - two", d.text(),
    "1. alpha ⏎⇥ ⇧⌘8 one ⏎ two");

  d.reset();
  d.type("- alpha");
  d.press("Enter"); d.press("Tab"); convert("9"); d.type("one");
  d.press("Enter"); d.type("two");
  r.check("a task list nested under a bullet", "- alpha\n  - [ ] one\n  - [ ] two", d.text(),
    "- alpha ⏎⇥ ⇧⌘9 one ⏎ two");

  // --- a marker typed into an item (decision 135) ------------------------------------------------
  //
  // `1. 1. three` is a nested list to CommonMark, which is never what anybody means by it — a
  // nested list is made with ⇥. Reported as "1. 1.3 dollars works and 1. 1. 3 dollars messes up",
  // so both halves are here: a marker needs its space, and the one that has it gets escaped.

  d.reset();
  d.type("1. 1. 3 dollars");
  r.check("a number typed into an item is escaped", "1. 1\\. 3 dollars", d.text(),
    "1. 1. 3 dollars");

  d.reset();
  d.type("1. 1.3 dollars");
  r.check("and a number with no space after it is untouched", "1. 1.3 dollars", d.text(),
    "1. 1.3 dollars");

  d.reset();
  d.type("- * hello");
  r.check("a bullet of another kind typed into an item is escaped", "- \\* hello", d.text(),
    "- * hello");

  d.reset();
  d.type("- - hello");
  r.check("and so is one of the same kind", "- \\- hello", d.text(), "- - hello");

  d.reset();
  d.type("1) 2. three");
  r.check("the backslash goes in front of the punctuation, not the digits", "1) 2\\. three",
    d.text(), "1) 2. three");

  // Only at the item's content column, because that is the only place a marker can begin a block.
  d.reset();
  d.type("1. a 1. b");
  r.check("a marker after the item's text is already text", "1. a 1. b", d.text(), "1. a 1. b");

  d.reset();
  d.type("- [] x - y");
  r.check("and so is one after a checkbox", "- [ ] x - y", d.text(), "- [] x - y");

  // A quote is not a list, and `> - x` is how a list inside one is written.
  d.reset();
  d.type("> - quoted");
  r.check("a bullet typed into a quote is a bullet", "> - quoted", d.text(), "> - quoted");

  // ⇥ first, so the escape has to survive being nested.
  d.reset();
  d.type("- a");
  d.press("Enter"); d.press("Tab"); d.type("* b");
  r.check("a marker typed into a nested item is escaped too", "- a\n  - \\* b", d.text(),
    "- a ⏎⇥ * b");

  // --- numbering --------------------------------------------------------------------------------

  d.reset();
  d.type("1. one");
  d.press("Enter"); d.type("two");
  d.press("Enter"); d.type("three");
  r.check("a numbered list counts up", "1. one\n2. two\n3. three", d.text(), "three items");

  d.reset();
  d.type("1. one");
  d.press("Enter"); d.press("Tab"); d.type("a");
  d.press("Enter"); d.type("b");
  d.press("Enter"); d.press("Tab", { shiftKey: true }); d.type("two");
  r.check("coming back up resumes the outer count",
    "1. one\n   1. a\n   2. b\n2. two", d.text(), "1. one ⏎⇥ a ⏎ b ⏎⇧⇥ two");

  // An author's own start number is theirs (decision 85) — but the item after it still follows on.
  d.reset();
  d.type("5. five");
  d.press("Enter"); d.type("six");
  r.check("a list that starts at five continues at six", "5. five\n6. six", d.text(),
    "5. five ⏎ six");

  // --- a soft break inside an item ---------------------------------------------------------------

  d.reset();
  d.type("- alpha");
  d.press("Enter", { shiftKey: true });
  d.type("continued");
  r.check("Shift-Enter continues the item under its own text", "- alpha\n  continued", d.text(),
    "- alpha ⇧⏎ continued");

  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.press("Enter", { shiftKey: true });
  d.type("continued");
  r.check("a soft break inside a nested item keeps the item's indent",
    "- one\n  - two\n    continued", d.text(), "nested, ⇧⏎ continued");

  // --- Backspace at the front of an item ---------------------------------------------------------

  d.reset();
  d.type("- one");
  d.press("Enter"); d.press("Tab"); d.type("two");
  d.at("two", 0);
  d.press("Backspace");
  r.check("Backspace at the start of a nested item outdents it", "- one\n- two", d.text(),
    "caret before `two`, ⌫");

  d.reset();
  d.type("- one");
  d.press("Enter"); d.type("two");
  d.at("two", 0);
  d.press("Backspace");
  // A blank line, for `exitListToParagraph`'s reason: without it the text that has just stopped
  // being an item is a lazy continuation of the item above, which is the same bug in a new place.
  r.check("Backspace at the start of a top-level item makes it a paragraph", "- one\n\ntwo",
    d.text(), "caret before `two`, ⌫");

  return { checked: r.checked, failures: r.failures };
}


// ------------------------------------------------------------------------------------------------
// B. What the reader sees
// ------------------------------------------------------------------------------------------------

/**
 * Bytes are half the claim. These load documents another markdown tool would have written and ask
 * what Pane draws: which level each line is indented to, what stands in for its marker, and whether
 * the source that should be hidden is hidden.
 *
 * The severe case is the last one. If a document whose bytes are flat renders as nested, then what
 * you see in Pane is not what the file says, and the file is what you own (decision 1).
 */
export function runListStructure(view, doc) {
  const r = recorder("list rendering");
  const d = driver(view, doc);
  const i = inspector(view, doc);

  // Live preview renders the whole document flat while the editor is unfocused (decision 53), and
  // the probe's window can never become key. Only that gate is stubbed, as `runLayout` does.
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });

  const away = () => view.dispatch({ selection: { anchor: view.state.doc.length } });

  const BULLETS = "- one\n  - two\n    - three\n      - four\n\npara\n";
  d.load(BULLETS);
  d.at("para");
  for (const [line, depth] of [[1, 1], [2, 2], [3, 3], [4, 4]]) {
    r.check(`a bullet at level ${depth} is indented to level ${depth}`, depth, i.renderedDepth(line));
  }
  r.check("a paragraph after a list is indented to no level", 0, i.renderedDepth(6));
  for (const [line, glyph] of [[1, "•"], [2, "◦"], [3, "▪"], [4, "▪"]]) {
    r.check(`level ${line} draws ${glyph}`, glyph, i.marker(line));
  }
  r.check("the source of a bullet is hidden", "one", i.visibleText(1).replace("•", ""));
  r.check("the indent of a nested bullet is hidden too", "three",
    i.visibleText(3).replace("▪", ""));

  const NUMBERS = "1. one\n   1. two\n      1. three\n\npara\n";
  d.load(NUMBERS);
  d.at("para");
  for (const [line, depth] of [[1, 1], [2, 2], [3, 3]]) {
    r.check(`a number at level ${depth} is indented to level ${depth}`, depth, i.renderedDepth(line));
  }
  r.check("a nested number restarts its own count", "1.", i.marker(2));
  r.check("and so does the level below it", "1.", i.marker(3));

  const TASKS = "- [ ] one\n  - [x] two\n    - [ ] three\n\npara\n";
  d.load(TASKS);
  d.at("para");
  for (const [line, depth] of [[1, 1], [2, 2], [3, 3]]) {
    r.check(`a task at level ${depth} is indented to level ${depth}`, depth, i.renderedDepth(line));
  }
  r.check("an unticked box draws unticked", "[ ]", i.marker(1));
  r.check("a ticked box draws ticked", "[x]", i.marker(2));
  r.check("a ticked item's text is struck", true,
    !!i.lineEl(2).querySelector(".pane-task-done-text"));

  const MIXED = "- one\n  1. two\n  2. three\n     - four\n\npara\n";
  d.load(MIXED);
  d.at("para");
  r.check("a numbered list inside a bulleted one is level two", 2, i.renderedDepth(2));
  r.check("and its numbers are its own", "1.", i.marker(2));
  r.check("the second one counts on", "2.", i.marker(3));
  r.check("a bullet under that is level three", 3, i.renderedDepth(4));
  r.check("and takes level three's glyph", "▪", i.marker(4));

  // A quote is a container, not a kind (decision 100), so it stacks.
  d.load("> - one\n> - two\n\npara\n");
  d.at("para");
  r.check("a list inside a quote is still a list", 1, i.renderedDepth(1));
  r.check("and the line is still a quote", true, i.classes(1).includes("pane-line-quote"));

  // --- two markers on one line, and a numbered to-do (decision 135) ------------------------------
  //
  // Both of these are documents another tool can hand us, so they are loaded rather than typed —
  // the input rule above stops Pane writing the first one, and cannot stop it arriving.

  // A line has one marker slot, so a one-line nesting draws the **outer** marker in it and leaves
  // the inner one literal. Both boxed paint on top of each other — measured, both at x=46 — and
  // boxing the inner one instead inverts them, because a box pulls into the gutter and text does
  // not: `1. 1.` came out as `1.1.` with the inner marker in front.
  const boxed = (n, sel) => i.lineEl(n).querySelectorAll(sel).length;

  d.load("1. 1. three\n\npara\n");
  d.at("para");
  r.check("a list nested on one line reads as its own characters", "1. 1. three", i.visibleText(1));
  r.check("and boxes one marker, not two", 1, boxed(1, ".pane-list-number"));

  d.load("- * three\n\npara\n");
  d.at("para");
  r.check("the bullet equivalent keeps its inner marker as text", "* three",
    i.visibleText(1).replace("•", ""));
  r.check("and boxes one bullet, not two", 1, boxed(1, ".pane-list-marker"));

  // A checkbox stands in for a bullet, which says only "an item". A number also says which item.
  //
  // **Measured, not counted.** The first draft of this asserted that both elements were present,
  // found them, and passed — while they were painting on top of each other at 24..40 and 25..39.
  // The number holds the line's one slot and the box stands in the flow after it.
  const rect = (n, sel) => {
    const el = i.lineEl(n).querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right) };
  };

  d.load("1. [ ] one\n2. [x] two\n\npara\n");
  d.at("para");
  r.check("a numbered to-do keeps its number", "1.",
    i.lineEl(1).querySelector(".pane-list-number")?.textContent.trim());
  r.check("the second one counts on", "2.",
    i.lineEl(2).querySelector(".pane-list-number")?.textContent.trim());
  r.check("and its box is clear of the number, not on top of it", true,
    rect(1, ".pane-task").left >= rect(1, ".pane-list-number").right);
  r.check("a ticked numbered to-do is clear too", true,
    rect(2, ".pane-task").left >= rect(2, ".pane-list-number").right);

  // The bullet's to-do is untouched: there the box *is* the item's marker, so it keeps the slot.
  d.load("- [ ] one\n1. [ ] two\n\npara\n");
  d.at("para");
  r.check("a bulleted to-do draws no bullet beside its box", 0,
    i.lineEl(1).querySelectorAll(".pane-list-marker").length);
  r.check("and its box is still in the marker slot", true,
    rect(1, ".pane-task").left < rect(2, ".pane-task").left);

  // --- the raw source under the caret ------------------------------------------------------------

  d.load(BULLETS);
  d.at("three", 1);
  r.check("the caret's own marker goes raw", "raw:- ", i.marker(3));
  r.check("but the line above keeps its glyph", "◦", i.marker(2));
  r.check("a revealed marker does not reveal the indent as well", "- three", i.visibleText(3));

  // --- what a flat document must not look like -----------------------------------------------------
  //
  // `  2. bravo` under `1. alpha` is indented two spaces where the parent's content starts at three,
  // so every markdown tool reads the two lines as siblings of one list. If Pane draws the second one
  // indented, the pane and the file disagree — which is the one failure decision 1 cannot absorb.
  d.load("1. alpha\n  2. bravo\n\npara\n");
  d.at("para");
  r.check("two spaces under `1. ` is not a nested list", 1, i.renderedDepth(2));

  // The bullet equivalent, which *is* a real nesting, as the control for the case above.
  d.load("- alpha\n  - bravo\n\npara\n");
  d.at("para");
  r.check("two spaces under `- ` is a nested list", 2, i.renderedDepth(2));

  // Which class a nested line ends up obeying is decided by stylesheet order, not by nesting. It
  // comes out right today; it is one reordered block away from not.
  d.load("- one\n  - two\n    - three\n\npara\n");
  d.at("para");
  r.check("a nested line carries only its own depth class", "3", i.depthClasses(3).join(","));

  // A line typed straight after a list item or a quote with no blank line between them is a **lazy
  // continuation** of that block, not a new paragraph. Every markdown tool reads it that way, so
  // Pane has to draw it that way — and the fact that it does is what makes leaving a block without
  // a blank line a correctness problem rather than a formatting preference.
  d.load("- one\npara\n");
  d.at("one", 1);
  r.check("a line after a list item renders as part of the item", 1, i.renderedDepth(2));

  d.load("> quoted\nout\n");
  d.at("quoted", 2);
  r.check("a line after a quote renders as part of the quote", true,
    i.classes(2).includes("pane-line-quote"));

  return { checked: r.checked, failures: r.failures };
}

// ------------------------------------------------------------------------------------------------
// C. Where the indent actually lands
// ------------------------------------------------------------------------------------------------

/**
 * Indentation is a pixel claim, and this is the only place it gets checked as one.
 *
 * Everything here is asserted as a **relation** rather than as a literal — the step between two
 * levels, the gap between a marker and its text, one kind against another at the same level.
 * Decision 82: a number derived from another number is derived, not written down, or the next text
 * size invalidates the whole file.
 */
export function runListGeometry(view, doc) {
  const r = recorder("list geometry");
  const d = driver(view, doc);
  const i = inspector(view, doc);
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });

  d.load("- one\n  - two\n    - three\n      - four\npara\n");
  d.at("para");

  const markers = [1, 2, 3, 4].map((n) => i.leftEdge(n));
  const texts = [1, 2, 3, 4].map((n) => i.textEdge(n));

  const step = markers[1] - markers[0];
  for (let level = 2; level <= 4; level++) {
    r.check(`level ${level} steps in by the same amount level 2 did`,
      step, markers[level - 1] - markers[level - 2]);
  }
  r.check("the step is the 22px the design draws and the reference measures", 22, step);

  // The marker box plus the gap after it — decision 122. It was the box alone, because the box
  // abutted the text and the only space any marker had was whatever its own glyph left inside the
  // box: 9.2px after a bullet and 1.4px after a number, both measured, neither intended.
  for (let level = 1; level <= 4; level++) {
    r.check(`level ${level}'s text sits one marker box and gap right of its marker`,
      23.5, texts[level - 1] - markers[level - 1]);
  }

  // A list line's marker is where a paragraph's text is, plus the level's indent. The first level is
  // the one the typography pass found pushed 12pt too far right, so it is worth its own case.
  // Measured from the text column's own origin, which is the only origin these numbers are about.
  d.load("- one\n\npara\n");
  d.at("para");
  const origin = i.contentOrigin();
  
  // The reference's own figures are a marker at 31 with paragraph text at 24.5 — so its marker
  // leads by 6.5. The absolute numbers are not comparable between the two: the text column is
  // centred with `margin: 0 auto`, so where it starts moves with the pane's width, and the
  // reference was measured in a 496pt window. The **lead** is comparable, and ours was 10.
  //
  // **Superseded by decision 122, and the assertion changes with it.** 6.5 is where a *bullet's
  // ink* lands, and that is a consequence of centring a 5px glyph in the marker box, not a lead
  // applied before a left-aligned one. Chasing the number would mean shrinking our dot to the
  // reference's, which nothing has measured a reason for; what is worth pinning is the model the
  // number came out of. So the case below asks the question the report asked: **do the three
  // marker kinds sit on one centre axis**, which is the thing that was visibly wrong.
  r.check("the marker box starts one lead in from the text column", 1, i.leftEdge(1) - origin);

  // All three kinds, each on its own line, centred on the same axis. Left-aligned, their ink
  // centres were 2.8px apart at 15px text — a checkbox at 35.0, a number at 35.8 and a bullet at
  // 33.0 — because each glyph is a different width and each started at the box's left edge.
  const inkCentre = (text) => {
    d.load(text + "\npara\n");
    d.at("para");
    return i.markerInk(1).centre - i.contentOrigin();
  };
  const bulletCentre = inkCentre("- one");
  for (const [name, text] of [["a number", "1. one"], ["a checkbox", "- [ ] one"]]) {
    r.check(`${name} centres on the same axis a bullet does`, true,
      Math.abs(inkCentre(text) - bulletCentre) <= 1,
      `bullet ${bulletCentre} against ${inkCentre(text)}`);
  }

  // A marker never wraps inside its own box — decision 122, and reported on sight the moment the
  // box became a fixed width. An `inline-block` with a fixed width is a block container, so a
  // marker wider than the box breaks onto a second line *inside* it and the item is drawn two
  // lines tall with its number stranded above its text. Every geometry case above stayed green,
  // because they all measure horizontal positions and this fault is vertical.
  //
  // Both the widths that can exceed the box: a revealed `2. ` (real text, and wider than the
  // rendered `2.` it replaces) and a two-digit marker.
  const oneLineTall = (doc_, line, where) => {
    d.load(doc_);
    d.at(where);
    return i.height(line);
  };
  const prose = oneLineTall("para\n", 1, "para");
  r.check("a numbered item with the caret on it is one line tall",
    prose, oneLineTall("1. one\n", 1, "one"));
  r.check("a two-digit numbered item is one line tall",
    prose, oneLineTall("10. ten\n", 1, "ten"));
  r.check("a two-digit numbered item is one line tall with the caret away",
    prose, oneLineTall("10. ten\npara\n", 1, "para"));
  // The reported reproduction exactly: a second item, caret in it, marker revealed. `2. ` is a
  // hair over the box where `1. ` is a hair under, which is why one digit was not enough to see it.
  //
  // Compared against *itself* with the caret away, not against prose: a second list item carries
  // decision 55's 8px block gap and is legitimately taller than a paragraph. What must not change
  // is the item's height when its marker is revealed.
  r.check("revealing the second item's marker does not change its height",
    oneLineTall("1. one\n2. two\npara\n", 2, "para"),
    oneLineTall("1. one\n2. two\npara\n", 2, "two"));

  // Revealing a marker never moves the item's words — decision 122, and a task was the one kind
  // that did. A bullet's and a number's source is drawn inside the box the widget was occupying,
  // so the advance is unchanged; a task's `[ ] ` was literal text *after* that box, so putting the
  // caret on a to-do pushed every word of it right by the width of the brackets.
  const wordsOf = (doc_, where) => {
    d.load(doc_);
    d.at(where);
    return i.wordEdge(1, "task");
  };
  for (const [name, src] of [["an unticked", "- [ ] task one"], ["a ticked", "- [x] task one"]]) {
    r.check(`revealing ${name} task's marker does not move its words`,
      wordsOf(src + "\npara\n", "para"), wordsOf(src + "\npara\n", "task"));
  }

  // A marker sits at the middle of its line, not at the bottom of it — decision 122.
  //
  // The bullet is a drawn shape inside the marker span, so it is centred by the span rather than
  // by the line, and the first version of that centring left both dots sitting a half-line low.
  // Nothing here saw it: every other geometry case in this file asks where something is from the
  // left. Two pixels of tolerance, because a glyph's optical middle and its box's middle are not
  // the same thing and the number is set in the body font.
  for (const [name, src] of [["a bullet", "- one"], ["a number", "1. one"], ["a checkbox", "- [ ] one"]]) {
    d.load(src + "\npara\n");
    d.at("para");
    const ink = i.markerInk(1);
    r.check(`${name} sits at the vertical middle of its line`, true,
      Math.abs(ink.middle - i.textMiddle(1)) <= 2,
      `marker ${ink.middle} against text ${i.textMiddle(1)}`);
  }

  // The raw list-marker box must never declare a fixed `width` — decision 122, and this is a
  // guard on a rule rather than on behaviour because the fault is not reachable from here.
  //
  // That box holds real document text ending in the marker's space. Given a fixed width the space
  // lands in the box's own slack, WebKit refuses to place a caret after it, and the next character
  // typed goes *in front of* it: a new `- ` item becomes `-a`, which is not a list item at all.
  // Nothing about the DOM looks different, and this suite cannot see it either — it inserts text
  // through CodeMirror, while the fault is in WebKit's own insertion into contenteditable. It was
  // found by typing into the built app and comparing against the previous build. So what is pinned
  // is the declaration, which is the thing that has to stay true.
  const listmarkRule = [...doc.styleSheets]
    .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
    .find((rule) => rule.selectorText === ".pane-syntax-listmark");
  r.check("the raw list-marker box is declared", true, !!listmarkRule);
  r.check("the raw list-marker box sets no fixed width",
    "", listmarkRule ? listmarkRule.style.getPropertyValue("width") : "?");
  r.check("the raw list-marker box sets a min-width instead",
    true, !!listmarkRule && listmarkRule.style.getPropertyValue("min-width") !== "");

  // Every kind puts its text in the same place, or a list that mixes kinds looks ragged.
  const textEdgeOf = (text) => {
    d.load(text + "\npara\n");
    d.at("para");
    return i.textEdge(1);
  };
  const bullet = textEdgeOf("- one\n");
  r.check("a number's text starts where a bullet's does", bullet, textEdgeOf("1. one\n"));
  r.check("a task's text starts where a bullet's does", bullet, textEdgeOf("- [ ] one\n"));

  // And the same at depth, where the three kinds carry different marker widths.
  const nestedTextEdge = (second) => {
    d.load("- one\n" + second + "\npara\n");
    d.at("para");
    return i.textEdge(2);
  };
  const nestedBullet = nestedTextEdge("  - two\n");
  r.check("a nested number's text starts where a nested bullet's does",
    nestedBullet, nestedTextEdge("  1. two\n"));
  r.check("a nested task's text starts where a nested bullet's does",
    nestedBullet, nestedTextEdge("  - [ ] two\n"));

  // A revealed marker must not move the line. This is `runLayout`'s case, taken down a level, where
  // `min-width: 16px` on the raw mark meets a marker that is wider than 16.
  d.load("1. one\n   10. ten\n\npara\n");
  d.at("para");
  const before = i.textEdge(2);
  d.at("ten", 1);
  r.check("revealing a wide marker does not move the text", before, i.textEdge(2));

  // A soft-wrapped item lines up under its own text rather than back under its marker.
  const LONG = "- " + "word ".repeat(60) + "\n\npara\n";
  d.load(LONG);
  d.at("para");
  const el = i.lineEl(1);
  const rects = [...el.getClientRects()];
  r.check("a long item wraps onto more than one visual line", true,
    Math.round(el.getBoundingClientRect().height) > 25);
  {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 1);
    const first = lines[0];
    const second = lines.find((rect) => Math.round(rect.top) > Math.round(first.top) + 4);
    r.check("and its second line hangs under its text, not under its marker",
      Math.round(i.textEdge(1)), second ? Math.round(second.left) : null);
  }

  // A continuation line made with ⇧⏎ belongs to the item and sits under its text.
  d.load("- one\n  continued\n\npara\n");
  d.at("para");
  r.check("a ⇧⏎ continuation sits under the item's text", i.textEdge(1), i.leftEdge(2));

  return { checked: r.checked, failures: r.failures };
}


// ------------------------------------------------------------------------------------------------
// D. Line breaks, everywhere a break can be pressed
// ------------------------------------------------------------------------------------------------

/**
 * Decision 63: ⏎ starts a new paragraph and ⇧⏎ stays in the one you are in — and the two wrote the
 * same single newline for four releases without anyone noticing, which took decision 55's whole
 * rhythm with it. `runBackspace` covers the pair around a paragraph. This covers the pair around
 * everything else: headings, quotes, fences, and the ends of a document.
 */
export function runLineBreaks(view, doc) {
  const r = recorder("line breaks");
  const d = driver(view, doc);

  d.reset();
  d.type("one");
  d.press("Enter");
  d.type("two");
  r.check("Enter between two paragraphs writes a blank line", "one\n\ntwo", d.text(),
    "one ⏎ two");

  d.reset();
  d.type("one");
  d.press("Enter", { shiftKey: true });
  d.type("two");
  r.check("Shift-Enter writes one newline", "one\ntwo", d.text(), "one ⇧⏎ two");

  // A heading is one line. The line after it is prose.
  d.reset();
  d.type("# Title");
  d.press("Enter");
  d.type("body");
  r.check("Enter after a heading starts a paragraph, not another heading", "# Title\n\nbody",
    d.text(), "# Title ⏎ body");

  d.reset();
  d.type("### Deep");
  d.press("Enter");
  d.type("body");
  r.check("and the same at level three", "### Deep\n\nbody", d.text(), "### Deep ⏎ body");

  // Quotes continue, and come off one level at a time keeping the typed style (decision 43).
  d.reset();
  d.type("> quoted");
  d.press("Enter");
  d.type("still");
  r.check("Enter continues a quote", "> quoted\n> still", d.text(), "> quoted ⏎ still");

  d.reset();
  d.type(">>> deep");
  d.press("Enter");
  d.press("Enter");
  d.type("still");
  r.check("an empty quote line comes off one level, keeping the typed style",
    ">>> deep\n>> still", d.text(), ">>> deep ⏎ ⏎ still");

  d.reset();
  d.type("> quoted");
  d.press("Enter");
  d.press("Enter");
  d.type("out");
  r.check("and the last level leaves the quote", "> quoted\n\nout", d.text(),
    "> quoted ⏎ ⏎ out");

  // Inside a fence every Enter is a newline in the code, and ⇧⏎ is the way out.
  d.load("```js\nconst a = 1;\n```\n");
  d.at("const a = 1;", 12);
  d.press("Enter");
  d.type("const b = 2;");
  r.check("Enter inside a fence is one newline in the code, not a paragraph break",
    "```js\nconst a = 1;\nconst b = 2;\n```\n", d.text(), "caret at the end of the code, ⏎ code");

  d.load("```\ncode\n```\n");
  d.at("code", 4);
  d.press("Enter", { shiftKey: true });
  d.type("after");
  r.check("Shift-Enter leaves a closed fence", "```\ncode\n```\nafter", d.text(),
    "caret after `code`, ⇧⏎ after");

  // A hard break is two spaces at the end of a line, and it is the one place trailing whitespace
  // means something. Nothing may trim it.
  d.reset();
  d.type("one  ");
  d.press("Enter", { shiftKey: true });
  d.type("two");
  r.check("a hard break's two trailing spaces survive", "one  \ntwo", d.text(),
    "one·· ⇧⏎ two");

  // Backspace against Enter, at the two places `runBackspace` does not go.
  d.reset();
  d.type("# Title");
  d.press("Enter");
  d.press("Backspace");
  r.check("Backspace undoes the break after a heading", "# Title", d.text(), "# Title ⏎ ⌫");

  d.reset();
  d.type("> quoted");
  d.press("Enter");
  d.press("Backspace");
  r.check("Backspace undoes the break after a quote line", "> quoted", d.text(),
    "> quoted ⏎ ⌫");

  // A bullet typed under a paragraph is text until something makes it a list. Backspace there is
  // an ordinary Backspace — it takes one character — and must not reach back past the marker into
  // the break above it.
  d.reset();
  d.type("hello");
  d.press("Enter");
  d.type("- ");
  d.press("Backspace");
  r.check("Backspace after a bullet typed under a paragraph deletes one character",
    "hello\n\n-", d.text(), "hello ⏎ '- ' ⌫");

  // A second Enter adds **one** line, not another paragraph break.
  //
  // ⏎ from a line with text writes `\n\n`; ⏎ from a line that is already blank writes one `\n`.
  // So holding the key stacks blank lines at one a press rather than two, which is decision 89's
  // argument — the gap between two paragraphs is not a place — without taking away the writer's
  // ability to put deliberate space in a note. Locked rather than left as the shape the code
  // happened to have.
  d.reset();
  d.type("one");
  d.press("Enter");
  d.press("Enter");
  d.type("two");
  r.check("a second Enter adds one line, not a second paragraph break", "one\n\n\ntwo",
    d.text(), "one ⏎ ⏎ two");

  d.reset();
  d.type("one");
  d.press("Enter");
  d.press("Enter");
  d.press("Enter");
  d.type("two");
  r.check("and a third adds one more", "one\n\n\n\ntwo", d.text(), "one ⏎ ⏎ ⏎ two");

  return { checked: r.checked, failures: r.failures };
}

// ------------------------------------------------------------------------------------------------
// E. Every construct the app says it supports
// ------------------------------------------------------------------------------------------------

/**
 * One honest pass over the whole format: type it, check the bytes are what was typed, check it
 * rendered as the thing it is, and check the source comes back under the caret and goes away again
 * (decision 57 — the caret owns raw source, not the line it sits on).
 */
export function runConstructs(view, doc) {
  const r = recorder("constructs");
  const d = driver(view, doc);
  const i = inspector(view, doc);
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });

  const line1 = (name, typed, wantBytes, wantClass, exits = 1) => {
    d.reset();
    d.type(typed);
    for (let n = 0; n < exits; n++) d.press("Enter");
    d.type("elsewhere");
    const bytes = view.state.doc.toString();
    r.check(`${name} writes what was typed`, wantBytes + "\n\nelsewhere", bytes, typed);
    if (wantClass !== undefined) {
      r.check(`${name} renders as ${wantClass || "plain text"}`, wantClass, i.classes(1));
    }
  };

  // --- headings ---------------------------------------------------------------------------------

  line1("an H1", "# One", "# One", "pane-line-h1");
  line1("an H2", "## Two", "## Two", "pane-line-h2");
  line1("an H3", "### Three", "### Three", "pane-line-h3");
  // Four, five and six are real CommonMark and the design draws three heading levels, so they
  // render at level three **on purpose** — a decision, not a gap. The bytes keep all six hashes,
  // which is the half that matters: the file keeps its levels for whatever opens it next, and Pane
  // simply has no fourth size to show them at.
  line1("an H4 keeps its hashes and renders at level three", "#### Four", "#### Four",
    "pane-line-h3");
  line1("an H5 does the same", "##### Five", "##### Five", "pane-line-h3");
  line1("an H6 does the same", "###### Six", "###### Six", "pane-line-h3");
  // `#Title` with no space is not a heading in CommonMark, and must not draw as one.
  line1("a hash with no space is not a heading", "#Title", "#Title", "");

  // --- rules ------------------------------------------------------------------------------------

  line1("a dashed rule", "---", "---", "pane-rule");
  line1("a starred rule", "***", "***", "pane-rule");
  line1("an underscored rule", "___", "___", "pane-rule");

  // --- quotes -----------------------------------------------------------------------------------

  line1("a quote", "> quoted", "> quoted", "pane-line-quote", 2);
  line1("a nested quote", ">> deeper", ">> deeper", "pane-line-quote", 3);

  // --- inline -----------------------------------------------------------------------------------

  // `before` and `after` are there so the construct is not the whole line: decision 57 says raw
  // source follows the caret *into the construct*, so a case has to have somewhere on the line to
  // put the caret that is outside it.
  const inline = (name, typed, wantClass) => {
    const whole = `before ${typed} after`;
    d.reset();
    d.type(whole);
    d.press("Enter");
    d.type("elsewhere");
    r.check(`${name} writes what was typed`, `${whole}\n\nelsewhere`,
      view.state.doc.toString(), whole);
    const drawn = () => !!i.lineEl(1).querySelector(`.${wantClass}`);
    d.at("elsewhere");
    r.check(`${name} renders with the caret on another line`, true, drawn());
    d.at("before", 0);
    r.check(`${name} still renders with the caret on the line but outside it`, true, drawn());
    d.at(typed, Math.max(1, Math.floor(typed.length / 2)));
    r.check(`${name} goes raw with the caret inside it`, false, drawn());
  };

  inline("bold", "**bold**", "pane-strong");
  inline("italic", "*italic*", "pane-em");
  inline("bold-italic", "***both***", "pane-strong");
  inline("strikethrough", "~~gone~~", "pane-strike");
  inline("inline code", "`code`", "pane-code");
  inline("underline", "<u>under</u>", "pane-underline");
  inline("highlight", "==marked==", "pane-mark");
  inline("a link", "[text](http://x.com)", "pane-link");

  // --- links you can still read (decision 121, issue #1) -----------------------------------------
  //
  // `inline` above asks whether the class landed, and it cannot see a construct rendered as
  // *nothing*: an empty `.pane-link` span satisfies it exactly as a full one does. The report was
  // that a pasted URL's line goes blank the moment the caret leaves it — the class was there the
  // whole time. So the question a link has to answer is what the **line says**, which is the one
  // thing a reader of the note cares about.
  //
  // Three forms, and they are three different node shapes rather than one with variations:
  // GFM's bare autolink is a `URL` with no `Link` around it at all; CommonMark's angle form is a
  // `Link` whose entire content is the URL; and the labelled form is a `Link` whose content is a
  // label the URL is not part of. Only the third may hide its URL.
  const linkReads = (name, typed, wantVisible, wantHidden, wantClass = "pane-link") => {
    const whole = `before ${typed} after`;
    d.reset();
    d.type(whole);
    d.press("Enter");
    d.type("elsewhere");
    d.at("elsewhere");
    const shown = i.visibleText(1);
    r.check(`${name} is readable with the caret off its line`, true,
      shown.includes(wantVisible), `${whole} → "${shown}"`);
    if (wantHidden) {
      r.check(`${name} hides its target with the caret off its line`, false,
        shown.includes(wantHidden), `${whole} → "${shown}"`);
    }
    if (wantClass) {
      r.check(`${name} carries the link class`, true,
        !!i.lineEl(1).querySelector(`.${wantClass}`), whole);
    }
  };

  linkReads("a bare URL", "https://x.com/a/b", "https://x.com/a/b");
  linkReads("an angle autolink", "<http://x.com>", "http://x.com", "<");
  linkReads("a labelled link", "[text](http://x.com)", "text", "http://x.com");

  // GFM autolinks the reporter did not mention and the tree found: all three parse as a bare `URL`
  // exactly as a pasted `https://` one does, so all three were invisible for the same reason.
  linkReads("a bare www address", "www.x.com/page", "www.x.com/page");
  linkReads("a bare email address", "someone@example.com", "someone@example.com");
  linkReads("a bare URL with a query", "https://x.com/a?b=1&c=2", "https://x.com/a?b=1&c=2");

  // Images are out of scope, so an image renders as its own source rather than as a rendering of
  // something Pane has decided not to render. Both halves matter: `![alt](…)` used to draw the
  // bare word `alt` with its target invisible, and `![](…)` — no alt text — used to draw nothing
  // at all, which is this decision's own fault in the one construct nobody reported.
  // No class assertion: an `Image` is not in `INLINE_STYLE` and its source is plain text.
  linkReads("an image", "![alt](http://x.com/a.png)", "![alt](http://x.com/a.png)", null, null);
  linkReads("an image with no alt text", "![](http://x.com/a.png)", "![](http://x.com/a.png)",
    null, null);

  // Underscore emphasis is the other half of CommonMark and a file can arrive carrying it.
  inline("underscore italic", "_italic_", "pane-em");
  inline("underscore bold", "__bold__", "pane-strong");

  // --- code blocks ------------------------------------------------------------------------------

  // Opening a fence has to close it. Typora and Obsidian both write the closing ``` the moment you
  // press Enter on the opening one, and the reason is not convenience: an unclosed fence swallows
  // the entire rest of the note, so everything typed afterwards is code — in the file as well as on
  // screen.
  d.reset();
  d.type("```python");
  d.press("Enter");
  d.type("x = 1");
  r.check("opening a fence closes it", "```python\nx = 1\n```",
    view.state.doc.toString(), "```python ⏎ x = 1");

  // And with a fence that *is* closed, ⇧⏎ is the way out of it.
  d.load("```python\nx = 1\ny = 2\n```\n");
  d.at("y = 2", 5);
  d.press("Enter", { shiftKey: true });
  d.type("after");
  r.check("Shift-Enter leaves a closed fence", "```python\nx = 1\ny = 2\n```\nafter",
    view.state.doc.toString(), "caret at the end of the code, ⇧⏎ after");

  d.load("```python\nx = 1\ny = 2\n```\n\nafter\n");
  d.at("after");
  r.check("a closed fence collapses to a strip", true, i.height(1) < 15);
  r.check("every line inside the block is the same height", i.height(2), i.height(3));

  // A four-space indented code block is CommonMark's other code form. Live preview draws no rule
  // for it, so the question is only whether the source survives.
  d.reset();
  d.type("para");
  d.press("Enter");
  d.type("    indented code");
  r.check("an indented code block keeps its four spaces", "para\n\n    indented code",
    view.state.doc.toString(), "para ⏎ ····indented code");

  // --- an escape --------------------------------------------------------------------------------

  d.reset();
  d.type("\\*not bold\\*");
  d.press("Enter");
  d.type("elsewhere");
  r.check("an escaped asterisk stays escaped", "\\*not bold\\*\n\nelsewhere",
    view.state.doc.toString(), "\\*not bold\\*");
  d.at("elsewhere");
  r.check("and does not render as emphasis", false, !!i.lineEl(1).querySelector(".pane-em"));

  // The backslash itself is chrome (decision 135). It has to be, because an escape is the only way
  // markdown can write a literal `1. ` at the start of an item — and the caret rule rather than the
  // line rule, or writing one would leave a backslash on screen for the rest of the sentence.
  d.load("1. 1\\. 3 dollars\n\npara\n");
  d.at("para");
  r.check("an escape's backslash is hidden", "1. 1. 3 dollars", i.visibleText(1));
  d.at("\\. 3", 1);
  r.check("and shows with the caret inside it", "1. 1\\. 3 dollars", i.visibleText(1));
  d.at("dollars");
  r.check("but not from elsewhere on the line", "1. 1. 3 dollars", i.visibleText(1));

  return { checked: r.checked, failures: r.failures };
}

// ------------------------------------------------------------------------------------------------
// F. What happens to what we do not support
// ------------------------------------------------------------------------------------------------

/**
 * Tables, images, footnotes and raw HTML are all out of scope and none of them is going to render.
 * That is fine. What is not fine is any of them being *changed* — a construct we do not draw is
 * still somebody's text, and the promise is that the file holds what was typed (decision 5).
 *
 * So there is exactly one question here, asked of each: are the bytes still what was typed. The
 * auto-closing brackets are part of the answer, not an exception to it — typing `[` inserts a pair
 * and typing `]` types over it, so a person who types the whole construct gets the whole construct.
 */
export function runDegradation(view, doc) {
  const r = recorder("degradation");
  const d = driver(view, doc);

  const survives = (name, typed, want = typed) => {
    d.reset();
    try {
      d.type(typed);
    } catch (error) {
      r.check(name, want, `threw: ${String(error).slice(0, 200)}`, typed);
      return;
    }
    r.check(name, want, view.state.doc.toString(), typed);
  };

  survives("an image", "![alt](http://x.com/a.png)");
  survives("a reference link", "[text][ref]");
  survives("a link definition", "[ref]: http://x.com");
  survives("a footnote reference", "Text[^1]");
  survives("a footnote definition", "[^1]: the note");
  survives("an autolink", "<http://x.com>");
  survives("raw HTML", "<div class=\"x\">body</div>");
  survives("an HTML comment", "<!-- hidden -->");
  survives("an entity", "caf&eacute;");
  survives("a YAML frontmatter fence", "---\ntitle: x\n---");
  survives("a tilde fence", "~~~\ncode\n~~~");
  survives("a math block", "$$\nx = 1\n$$");
  survives("a wiki link", "[[Some Note]]");
  survives("a tag", "#tag and #another");
  survives("emoji and CJK", "写作 🙂 déjà vu");
  survives("a windows path", "C:\\Users\\x\\notes");

  // A table typed row by row, which is the shape most likely to meet a list or renumber filter.
  d.reset();
  d.type("| a | b |");
  d.press("Enter", { shiftKey: true });
  d.type("| - | - |");
  d.press("Enter", { shiftKey: true });
  d.type("| 1 | 2 |");
  r.check("a table survives being typed", "| a | b |\n| - | - |\n| 1 | 2 |",
    view.state.doc.toString(), "three table rows with ⇧⏎");

  // A setext heading is a heading whose marker is on the *next* line, which is the one construct
  // where pressing Enter could plausibly rewrite the line above it.
  d.reset();
  d.type("Title");
  d.press("Enter", { shiftKey: true });
  d.type("=====");
  r.check("a setext heading survives", "Title\n=====", view.state.doc.toString(),
    "Title ⇧⏎ =====");

  // Numbers at the start of lines that are not lists, which the renumbering filter must not touch.
  d.reset();
  d.type("2026 was a year");
  d.press("Enter");
  d.type("1984 was another");
  r.check("a year at the start of a line is not a list", "2026 was a year\n\n1984 was another",
    view.state.doc.toString(), "two lines starting with numbers");

  // A long line, because wrapping is where measurement goes wrong.
  const long = "word ".repeat(400).trim();
  d.reset();
  d.type(long);
  r.check("a 400-word line is kept whole", long.length, view.state.doc.length, "400 words");

  return { checked: r.checked, failures: r.failures };
}

// ------------------------------------------------------------------------------------------------
// What a selection reveals, and what it draws
// ------------------------------------------------------------------------------------------------

/**
 * Decision 77 settled the sentence and applied it to half the problem: *"a range selection is not a
 * place you are standing, it is a thing you have marked."* Everything that was not height-changing
 * kept following whatever a selection *touched*, so ⌘A turned the whole note back into its source —
 * the heading's hashes, the `**`, the backticks, the quote's `>` and every list marker at once.
 *
 * It was also three visible defects in one. A revealed list marker is an `inline-block`, because it
 * has to hold the marker column; an `inline-block` is an atomic inline box, so the selection crossing
 * it paints a rectangle at its `line-height` rather than at the font's painted height. Measured off
 * the shipped build's pixels: the marker's rectangle 20pt tall against the text's 15pt, sharing a
 * bottom edge, with the marker's own `margin-right` unpainted between them — two and three
 * mismatched rectangles a line where the reference draws one. That is decision 101's mechanism one
 * construct over: 101 stepped the *rendered* markers out of the selection and said in so many words
 * that the raw one "is real text with no rule here", which stopped being true at decision 122.
 *
 * So the reveal follows a range only while that range stays inside one line. This section is the
 * gate on it, plus the two declarations no harness here can reach.
 */
export function runSelectionReveal(view, doc) {
  const r = recorder("selection reveal");
  const d = driver(view, doc);
  const i = inspector(view, doc);
  // The probe's window is never key, and `activeLines` correctly reports nothing while unfocused —
  // which would make every case below pass for the wrong reason.
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });

  const ES = view.state.selection.constructor;
  const select = (from, to) => view.dispatch({ selection: { anchor: from, head: to } });
  const selectAll = () => select(0, view.state.doc.length);
  const at = (needle, offset = 0) => view.state.doc.toString().indexOf(needle) + offset;
  const lines = () =>
    [...doc.querySelectorAll(".cm-line")].map((el) => el.textContent).join("⏎");

  const NOTE = [
    "# Heading one",
    "",
    "Some **bold** and `code` and *em* here.",
    "",
    "> quoted line",
    "",
    "1. [ ] numbered todo",
    "- * two bullets",
    "",
  ].join("\n");

  // --- a selection that spans lines renders, it does not reveal ----------------------------------

  d.load(NOTE);
  selectAll();
  // The hashes' own space stays, exactly as it does with the pane blurred: `HeadingMark` hides the
  // marker and not the space after it, which is the rendering this has always had.
  // The task's `[ ]` is a widget, so it contributes no text; the hashes' own space stays, exactly
  // as it does with the pane blurred — `HeadingMark` hides the marker and not the space after it.
  r.check("⌘A leaves the note rendered",
    " Heading one⏎⏎Some bold and code and em here.⏎⏎quoted line⏎⏎1. numbered todo⏎* two bullets⏎",
    lines());

  r.check("⌘A reveals no raw list marker", 0, doc.querySelectorAll(".pane-syntax-listmark").length);
  r.check("⌘A reveals no raw task marker", 0, doc.querySelectorAll(".pane-syntax-taskmark").length);
  // The other half of the same claim: the markers are still *there*, drawn. A rule that hid them
  // outright would satisfy the two above and be a different bug.
  r.check("⌘A still draws the numbered item's number", "1.", i.marker(7));
  r.check("⌘A still draws its checkbox", true, !!i.lineEl(7).querySelector(".pane-task"));
  r.check("⌘A still draws the bullet", "•", i.marker(8));

  // A selection that merely reaches into a second line is the same case, and this is the one a
  // person makes by dragging rather than by pressing a key.
  d.load(NOTE);
  select(at("numbered"), at("two bullets"));
  r.check("a drag into the next line stops revealing too", "1.", i.marker(7));

  // --- a selection inside one line still reveals -------------------------------------------------

  d.load(NOTE);
  select(at("numbered"), at("numbered") + 8);
  r.check("a selection inside one line still reveals its marker", "raw:1. ", i.marker(7));
  r.check("and its task marker", true,
    !!i.lineEl(7).querySelector(".pane-syntax-taskmark"));
  // Decision 57's rule, unchanged: an inline construct reveals when the selection is inside it.
  d.load(NOTE);
  select(at("bold"), at("bold") + 4);
  r.check("an inline construct still reveals inside one line", true,
    i.lineEl(3).textContent.includes("**bold**"));
  r.check("and its neighbours on the same line stay rendered", false,
    i.lineEl(3).textContent.includes("`code`"));

  // --- the caret is untouched --------------------------------------------------------------------

  d.load(NOTE);
  d.at("numbered");
  r.check("a caret still reveals its marker", "raw:1. ", i.marker(7));

  // --- and nothing moves when the reveal drops ---------------------------------------------------

  // The payoff of the raw marker sitting in the rendered marker's own box (decision 108): a drag
  // that crosses out of the line changes what the marker is drawn as and must not move the item's
  // words. Measured rather than argued, because this is the shape of fault decision 122 shipped.
  //
  // `wordEdge`, not `textEdge`: decision 122's lesson, and it would have read as a pass here too.
  // `textEdge` answers where the line's first non-marker *node* begins, and it does not skip the
  // revealed task marker — so it reports the marker box in one state and the words in the other,
  // which is 48 against 69 and looks like a 21px jump that is not there.
  d.load(NOTE);
  select(at("numbered"), at("numbered") + 3);
  const revealed = i.wordEdge(7, "numbered");
  select(at("numbered"), at("two bullets"));
  r.check("the item's words do not move when the reveal drops", revealed, i.wordEdge(7, "numbered"));

  // --- no caret while text is selected ------------------------------------------------------------

  d.load(NOTE);
  d.at("numbered");
  r.check("a caret carries no data-ranged", false, view.dom.hasAttribute("data-ranged"));
  select(at("numbered"), at("numbered") + 8);
  r.check("a range carries data-ranged", true, view.dom.hasAttribute("data-ranged"));
  selectAll();
  r.check("⌘A carries data-ranged", true, view.dom.hasAttribute("data-ranged"));
  // The source writes this as `every range is non-empty` rather than `the main range is`, so that a
  // mixed multi-range would keep the carets belonging to its empty ranges — which is what AppKit
  // does. **That branch is unreachable in Pane and this is the proof**: `allowMultipleSelections` is
  // never enabled, so a second range does not survive being dispatched. Asserted rather than left
  // implied, because `every` reads like a tested distinction and is not one.
  view.dispatch({ selection: ES.create([ES.range(0, 5), ES.cursor(20)]) });
  r.check("a second range does not survive — Pane has no multi-cursor", 1,
    view.state.selection.ranges.length);
  d.at("numbered");

  // --- two declarations this harness cannot reach --------------------------------------------------

  const rules = [...doc.styleSheets]
    .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } });

  // A guard on the declaration, decision 122's shape, because the paint is out of reach from here.
  // `.cm-cursor` is drawn by `drawSelection`'s cursor layer, which draws one per range head whether
  // the range is empty or not and offers no option — so the only lever is CSS, and CSS cannot see
  // the selection, which is what `data-ranged` above is for.
  const caretRule = rules.find((rule) => rule.selectorText === ".cm-editor[data-ranged] .cm-cursor");
  r.check("no caret is drawn while text is selected", "none",
    caretRule ? caretRule.style.getPropertyValue("display") : "no rule");

  // The selection here is the **browser's**, not CodeMirror's (see the note in markdown.css), and on
  // blur only the *window* resigns key: the content element keeps DOM focus, so the DOM selection
  // survives and `::selection` keeps painting a note you have clicked away from. No harness can see
  // it — a real `contentDOM.blur()` clears the DOM selection and nothing paints, so the state only
  // exists in a window that has lost key with its editor still focused. Reproduced by hand against
  // the shipped build; pinned here as the rule that fixes it.
  const blurRule = rules.find(
    (rule) => rule.selectorText === ".cm-editor:not(.cm-focused) .cm-line ::selection, " +
                                   ".cm-editor:not(.cm-focused) .cm-line::selection, " +
                                   ".cm-editor:not(.cm-focused) .cm-content ::selection"
  );
  r.check("an unfocused pane paints no selection", "transparent",
    blurRule ? blurRule.style.getPropertyValue("background-color") : "no rule");

  // Third declaration, same reason. A blank line's `line-height: 8px` sets the line box and not the
  // inline box's content area, which stays the font's em box and overflows about 5px each way — so
  // WebKit started the *next* line's selection below that overflow and painted it 14pt against the
  // 18pt of a line with no blank above it. Measured off the shipped build's pixels; `getClientRects`
  // reports 18 for every one of them, so nothing in this harness can see the difference.
  const blankRule = rules.find((rule) => rule.selectorText === ".cm-line.pane-line-blank");
  r.check("a blank line clips, so it does not shorten the line below it", "hidden",
    blankRule ? blankRule.style.getPropertyValue("overflow") : "no rule");

  delete view.hasFocus;
  return { checked: r.checked, failures: r.failures };
}

export function run(view, bar, doc) {
  const failures = [];
  let checked = 0;
  // An instrument reports; it does not fall over. A section that throws is itself a finding, and
  // the sections after it still have to run.
  for (const suite of [runTypedLists, runListStructure, runListGeometry, runLineBreaks,
                       runConstructs, runDegradation, runSelectionReveal]) {
    try {
      const result = suite(view, doc, bar);
      checked += result.checked;
      failures.push(...result.failures);
    } catch (error) {
      checked += 1;
      failures.push({
        case: `${suite.name} · threw`,
        want: "the section to finish",
        got: String(error && error.message ? error.message : error).slice(0, 400),
      });
    }
  }
  return { checked, failures };
}
