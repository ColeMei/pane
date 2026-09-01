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
    const bullet = el.querySelector(".pane-list-marker");
    if (bullet) return bullet.textContent;
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

  /** Every decoration class on the line, so a construct can say what it rendered as. */
  const classes = (n) => [...lineEl(n).classList].filter((c) => c.startsWith("pane-")).sort().join(" ");

  /** Everything the line actually puts on screen. `hide` is a replace decoration, so hidden source
   * is not in the DOM at all and `textContent` is already the truth. */
  const visibleText = (n) => lineEl(n).textContent;

  return { lineEl, renderedDepth, depthClasses, marker, leftEdge, textEdge, height, classes,
           visibleText, contentOrigin };
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

  for (let level = 1; level <= 4; level++) {
    r.check(`level ${level}'s text sits one marker box right of its marker`,
      16, texts[level - 1] - markers[level - 1]);
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
  r.check("a first-level marker leads by the 6.5 the reference does", 6.5, i.leftEdge(1) - origin);

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

export function run(view, bar, doc) {
  const failures = [];
  let checked = 0;
  // An instrument reports; it does not fall over. A section that throws is itself a finding, and
  // the sections after it still have to run.
  for (const suite of [runTypedLists, runListStructure, runListGeometry, runLineBreaks,
                       runConstructs, runDegradation]) {
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
