/*
 * The formatting commands, every one against every shape of selection.
 *
 * This exists because the commands produced a stream of bugs that could only be found by using the
 * app — bold spanning a blank line, a list marker on a blank line, `==` written across a soft break
 * where it can never render, ⌘L never moved onto the block primitive at all. Each was reported,
 * fixed, and followed by another, because "did I finish the migration?" had no answer.
 *
 * It has one now. Eleven commands × five selection shapes, asserting the **bytes** each writes and
 * whether pressing it twice returns the note to exactly what it was. Decision 5 says what lands on
 * disk is what was typed, so bytes are the only assertion worth making here.
 *
 * Run with `Scripts/test-editor.sh`. Runs in a real WKWebView against the real parser, because the
 * browser harness cannot measure layout and a mocked tree would not catch the bugs this is for.
 */

// A fixture with one of each thing that has broken: two separate paragraphs, and a pair of lines
// that are one paragraph split with ⇧⏎.
const DOC = "para one\n\npara two\n\nsoft a\nsoft b\n";

const P1 = DOC.indexOf("para one");
const P2 = DOC.indexOf("para two");
const SA = DOC.indexOf("soft a");
const END = DOC.length - 1;

const SHAPES = {
  "one word": [P1, P1 + 4],
  "one paragraph": [P1, P1 + 8],
  "two paragraphs": [P1, P2 + 8],
  "soft-break pair": [SA, END],
  everything: [P1, END],
};

const COMMANDS = [
  "Bold", "Italic", "Strikethrough", "Underline", "Highlight",
  "Inline code", "Link", "Quote", "Numbered list", "Bulleted list", "Task list",
];

/**
 * ⌘L is the one command that deliberately does not round-trip: it parks the caret in the empty
 * `()` so a URL can be pasted, so a second press has a caret rather than a selection. Selecting an
 * existing link still removes it.
 */
const NOT_REVERSIBLE = new Set([
  "Link \u00b7 everything",
  "Link \u00b7 one paragraph",
  "Link \u00b7 one word",
  "Link \u00b7 soft-break pair",
  "Link \u00b7 two paragraphs"
]);

const EXPECTED = {
  "Bold · one word": "**para** one\n\npara two\n\nsoft a\nsoft b\n",
  "Bold · one paragraph": "**para one**\n\npara two\n\nsoft a\nsoft b\n",
  "Bold · two paragraphs": "**para one**\n\n**para two**\n\nsoft a\nsoft b\n",
  "Bold · soft-break pair": "para one\n\npara two\n\n**soft a\nsoft b**\n",
  "Bold · everything": "**para one**\n\n**para two**\n\n**soft a\nsoft b**\n",
  "Italic · one word": "*para* one\n\npara two\n\nsoft a\nsoft b\n",
  "Italic · one paragraph": "*para one*\n\npara two\n\nsoft a\nsoft b\n",
  "Italic · two paragraphs": "*para one*\n\n*para two*\n\nsoft a\nsoft b\n",
  "Italic · soft-break pair": "para one\n\npara two\n\n*soft a\nsoft b*\n",
  "Italic · everything": "*para one*\n\n*para two*\n\n*soft a\nsoft b*\n",
  "Strikethrough · one word": "~~para~~ one\n\npara two\n\nsoft a\nsoft b\n",
  "Strikethrough · one paragraph": "~~para one~~\n\npara two\n\nsoft a\nsoft b\n",
  "Strikethrough · two paragraphs": "~~para one~~\n\n~~para two~~\n\nsoft a\nsoft b\n",
  "Strikethrough · soft-break pair": "para one\n\npara two\n\n~~soft a\nsoft b~~\n",
  "Strikethrough · everything": "~~para one~~\n\n~~para two~~\n\n~~soft a\nsoft b~~\n",
  "Underline · one word": "<u>para</u> one\n\npara two\n\nsoft a\nsoft b\n",
  "Underline · one paragraph": "<u>para one</u>\n\npara two\n\nsoft a\nsoft b\n",
  "Underline · two paragraphs": "<u>para one</u>\n\n<u>para two</u>\n\nsoft a\nsoft b\n",
  "Underline · soft-break pair": "para one\n\npara two\n\n<u>soft a</u>\n<u>soft b</u>\n",
  "Underline · everything": "<u>para one</u>\n\n<u>para two</u>\n\n<u>soft a</u>\n<u>soft b</u>\n",
  "Highlight · one word": "==para== one\n\npara two\n\nsoft a\nsoft b\n",
  "Highlight · one paragraph": "==para one==\n\npara two\n\nsoft a\nsoft b\n",
  "Highlight · two paragraphs": "==para one==\n\n==para two==\n\nsoft a\nsoft b\n",
  "Highlight · soft-break pair": "para one\n\npara two\n\n==soft a==\n==soft b==\n",
  "Highlight · everything": "==para one==\n\n==para two==\n\n==soft a==\n==soft b==\n",
  "Inline code · one word": "`para` one\n\npara two\n\nsoft a\nsoft b\n",
  "Inline code · one paragraph": "`para one`\n\npara two\n\nsoft a\nsoft b\n",
  "Inline code · two paragraphs": "`para one`\n\n`para two`\n\nsoft a\nsoft b\n",
  "Inline code · soft-break pair": "para one\n\npara two\n\n`soft a\nsoft b`\n",
  "Inline code · everything": "`para one`\n\n`para two`\n\n`soft a\nsoft b`\n",
  "Link · one word": "[para]() one\n\npara two\n\nsoft a\nsoft b\n",
  "Link · one paragraph": "[para one]()\n\npara two\n\nsoft a\nsoft b\n",
  "Link · two paragraphs": "[para one]()\n\n[para two]()\n\nsoft a\nsoft b\n",
  "Link · soft-break pair": "para one\n\npara two\n\n[soft a\nsoft b]()\n",
  "Link · everything": "[para one]()\n\n[para two]()\n\n[soft a\nsoft b]()\n",
  "Quote · one word": "> para one\n\npara two\n\nsoft a\nsoft b\n",
  "Quote · one paragraph": "> para one\n\npara two\n\nsoft a\nsoft b\n",
  "Quote · two paragraphs": "> para one\n\n> para two\n\nsoft a\nsoft b\n",
  "Quote · soft-break pair": "para one\n\npara two\n\n> soft a\nsoft b\n",
  "Quote · everything": "> para one\n\n> para two\n\n> soft a\nsoft b\n",
  "Numbered list · one word": "1. para one\n\npara two\n\nsoft a\nsoft b\n",
  "Numbered list · one paragraph": "1. para one\n\npara two\n\nsoft a\nsoft b\n",
  "Numbered list · two paragraphs": "1. para one\n\n2. para two\n\nsoft a\nsoft b\n",
  "Numbered list · soft-break pair": "para one\n\npara two\n\n1. soft a\nsoft b\n",
  "Numbered list · everything": "1. para one\n\n2. para two\n\n3. soft a\nsoft b\n",
  "Bulleted list · one word": "- para one\n\npara two\n\nsoft a\nsoft b\n",
  "Bulleted list · one paragraph": "- para one\n\npara two\n\nsoft a\nsoft b\n",
  "Bulleted list · two paragraphs": "- para one\n\n- para two\n\nsoft a\nsoft b\n",
  "Bulleted list · soft-break pair": "para one\n\npara two\n\n- soft a\nsoft b\n",
  "Bulleted list · everything": "- para one\n\n- para two\n\n- soft a\nsoft b\n",
  "Task list · one word": "- [ ] para one\n\npara two\n\nsoft a\nsoft b\n",
  "Task list · one paragraph": "- [ ] para one\n\npara two\n\nsoft a\nsoft b\n",
  "Task list · two paragraphs": "- [ ] para one\n\n- [ ] para two\n\nsoft a\nsoft b\n",
  "Task list · soft-break pair": "para one\n\npara two\n\n- [ ] soft a\nsoft b\n",
  "Task list · everything": "- [ ] para one\n\n- [ ] para two\n\n- [ ] soft a\nsoft b\n"
};

/**
 * Undo, which had no coverage at all and was emptying notes.
 *
 * Loading a note replaces the whole document, and that dispatch went into the history like any
 * edit — so the first ⌘Z in any note reversed the *load* and left it empty, and the write model
 * flushed that to the file. True since the first commit, and found by pressing the key rather than
 * by reading anything, which is why it is in here now.
 */
export function runUndo(view, doc) {
  const failures = [];
  let checked = 0;
  const content = doc.querySelector(".cm-content");
  const key = (k, mods = {}) =>
    content.dispatchEvent(new KeyboardEvent("keydown", {
      key: k, code: "Key" + k.toUpperCase(), bubbles: true, cancelable: true,
      metaKey: !!mods.meta, shiftKey: !!mods.shift,
    }));
  const undo = () => key("z", { meta: true });
  const redo = () => key("z", { meta: true, shift: true });

  const check = (name, want, got) => {
    checked += 1;
    if (got !== want) failures.push({ case: `undo · ${name}`, want, got });
  };

  const A = "NOTE A\n";
  const B = "NOTE B\n";

  // Opening a note is not an edit.
  window.paneHost.loadNote("a.md", A, 0, false);
  undo();
  check("straight after opening a note, does nothing", A, view.state.doc.toString());

  // An ordinary edit undoes, and redoes.
  window.paneHost.loadNote("a.md", A, 0, false);
  view.dispatch({ changes: { from: 6, insert: " edited" } });
  undo();
  check("an edit comes back", A, view.state.doc.toString());
  redo();
  check("and redo puts it back", "NOTE A edited\n", view.state.doc.toString());

  // Undo must not walk into the note you were in before.
  window.paneHost.loadNote("a.md", A, 0, false);
  view.dispatch({ changes: { from: 6, insert: " edited" } });
  window.paneHost.loadNote("b.md", B, 0, false);
  undo();
  check("cannot reach across a note switch", B, view.state.doc.toString());
  undo();
  check("still cannot, however many times", B, view.state.doc.toString());

  // A summon starts a fresh sitting, so undo cannot reach back across a dismissal into a burst of
  // typing — which would take a note written in one go all the way back to empty.
  window.paneHost.loadNote("a.md", A, 0, false);
  view.dispatch({ changes: { from: 6, insert: " written in one burst" } });
  window.paneHost.resetHistory();
  undo();
  check("cannot reach back across a summon", "NOTE A written in one burst\n", view.state.doc.toString());

  return { checked, failures };
}

/**
 * Ordered lists that renumber themselves.
 *
 * These are written from the ways the thing gets *used* rather than from what was built — which is
 * the lesson of the last attempt, whose cases were written from the implementation and passed
 * while a list split in two counted wrong. So: delete the first item, delete a middle one, insert
 * one, split a list with a paragraph, type a marker of your own, and press undo after each.
 *
 * Undo is the case that pulled this feature the first time (decision 81), so it is here from the
 * start rather than added after something goes wrong.
 */
export function runRenumber(view, doc, bar) {
  const failures = [];
  let checked = 0;

  const content = doc.querySelector(".cm-content");
  const press = (key, mods = {}) =>
    content.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true,
      metaKey: !!mods.meta, shiftKey: !!mods.shift,
    }));

  // A fixture is set with no `userEvent`, which is deliberately *not* an edit — the same as a note
  // arriving from Swift. If setting up a case renumbered it, the cases would be testing nothing.
  const set = (text) =>
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });

  const edit = (spec) => view.dispatch({ userEvent: "input.type", ...spec });
  const remove = (from, to) =>
    view.dispatch({ changes: { from, to, insert: "" }, userEvent: "delete.selection" });

  const check = (name, want) => {
    checked += 1;
    const got = view.state.doc.toString();
    if (got !== want) failures.push({ case: `renumber \u00b7 ${name}`, want, got });
  };

  // --- the case the feature exists for -------------------------------------------------------

  set("1. a\n2. b\n3. c\n");
  remove(0, 5);
  check("deleting the first item restarts at one", "1. b\n2. c\n");

  set("1. a\n2. b\n3. c\n");
  remove(5, 10);
  check("deleting a middle item closes the gap", "1. a\n2. c\n");

  set("1. a\n2. b\n");
  view.dispatch({ selection: { anchor: 4 } });
  press("Enter");
  check("an item inserted in the middle pushes the rest down", "1. a\n2. \n3. b\n");

  // The caret does not pay for the correction. Renumbering rewrites markers *above* where you are
  // typing, and two of them get shorter here — a caret that did not move with them would end up
  // two characters adrift, which is the failure everything about this editor is tuned to avoid.
  set("8. a\n9. b\n10. c\n11. d\n");
  view.dispatch({ selection: { anchor: 21 } });
  remove(0, 5);
  check("markers above the caret shrink without dragging it", "1. b\n2. c\n3. d\n");
  checked += 1;
  if (view.state.selection.main.head !== 14) {
    failures.push({
      case: "renumber \u00b7 the caret stays after the 'd'",
      want: 14,
      got: view.state.selection.main.head,
    });
  }

  // --- the author's own numbering, which is not ours to change -------------------------------

  set("5. a\n6. b\n7. c\n");
  edit({ changes: { from: 9, insert: "X" } });
  check("a run the author started at five stays at five", "5. a\n6. bX\n7. c\n");

  set("5. a\n6. b\n7. c\n");
  remove(0, 5);
  check("but an item only first because the one above went restarts at one", "1. b\n2. c\n");

  set("hello\n\n");
  view.dispatch({ selection: { anchor: 7 } });
  edit({ changes: { from: 7, insert: "5. mine" }, selection: { anchor: 14 } });
  check("a marker you type yourself is left alone", "hello\n\n5. mine");

  // --- a list split in two, which the last attempt got wrong ---------------------------------

  set("1. a\n2. b\n3. c\n4. d\n");
  edit({ changes: { from: 10, insert: "\npara\n\n" } });
  check(
    "a paragraph between items splits the list and the second half restarts",
    "1. a\n2. b\n\npara\n\n1. c\n2. d\n"
  );

  // --- alongside the things that already write list markers -----------------------------------

  // ⇧⌘7 works out its own start number by looking at the list above. The filter then sees the same
  // list and must agree with it rather than fight it.
  set("1. a\n\npara\n");
  view.dispatch({ selection: { anchor: 7 } });
  const numbered = [...bar.querySelectorAll("button")]
    .find((b) => (b.getAttribute("aria-label") || "").startsWith("Numbered list"));
  numbered.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  check("the numbered-list button and the filter agree", "1. a\n\n2. para\n");

  // Enter continues the list, and Enter on the empty marker leaves it — neither should acquire a
  // stray number on the way past.
  set("1. a\n2. b\n");
  view.dispatch({ selection: { anchor: 9 } });
  press("Enter");
  check("Enter continues the numbering", "1. a\n2. b\n3. \n");
  press("Enter");
  check("and Enter again leaves the list", "1. a\n2. b\n\n");

  // --- what it must never touch --------------------------------------------------------------

  const fenced = "1. a\n5. b\n\n```\n1. one\n5. five\n```\n";
  set(fenced);
  edit({ changes: { from: 22, insert: "" }, selection: { anchor: 22 } });
  check("digits inside a fence are code, not a list", fenced);

  set("- a\n- b\n- c\n");
  remove(0, 4);
  check("a bulleted list has nothing to count", "- b\n- c\n");

  // Opening somebody's note must not rewrite it. `loadNote` is how every note arrives, and a file
  // whose list says 1, 1, 1 is a file the user wrote that way.
  window.paneHost.loadNote("keep.md", "1. a\n1. b\n1. c\n", 0, false);
  check("opening a note renumbers nothing", "1. a\n1. b\n1. c\n");

  // --- nesting -------------------------------------------------------------------------------

  set("1. a\n   1. x\n   4. y\n2. b\n");
  remove(5, 13);
  check("a nested list counts on its own", "1. a\n   1. y\n2. b\n");

  set("3. a\n   1. x\n   2. y\n9. b\n");
  edit({ changes: { from: 12, insert: "X" } });
  check(
    "an outer run keeps its own start while the nested one keeps its",
    "3. a\n   1. xX\n   2. y\n4. b\n"
  );

  // --- undo, which is why this feature was pulled the first time ------------------------------

  const before = "1. a\n2. b\n3. c\n";
  window.paneHost.loadNote("undo.md", before, 0, false);
  remove(0, 5);
  check("the edit and its renumbering land together", "1. b\n2. c\n");
  press("z", { meta: true });
  check("and one undo takes both back", before);
  press("z", { meta: true, shift: true });
  check("redo puts both forward again", "1. b\n2. c\n");
  press("z", { meta: true });
  press("z", { meta: true });
  check("undo cannot walk past the load into an empty document", before);

  return { checked, failures };
}

export function run(view, bar, doc) {
  const failures = [];
  let checked = 0;

  for (const suite of [runUndo, runRenumber]) {
    const result = suite(view, doc, bar);
    checked += result.checked;
    failures.push(...result.failures);
  }

  const click = (label) => {
    const button = [...bar.querySelectorAll("button")]
      .find((b) => (b.getAttribute("aria-label") || "").startsWith(label));
    if (!button) throw new Error(`no format-bar button named ${label}`);
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  };

  for (const command of COMMANDS) {
    for (const [shape, [anchor, head]] of Object.entries(SHAPES)) {
      const name = `${command} · ${shape}`;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: DOC } });
      view.dispatch({ selection: { anchor, head } });

      click(command);
      const once = view.state.doc.toString();
      // A second press keeps whatever selection the editor mapped, which is what really happens.
      click(command);
      const twice = view.state.doc.toString();

      checked += 2;
      if (once !== EXPECTED[name]) {
        failures.push({ case: name, want: EXPECTED[name], got: once });
      }
      const shouldReverse = !NOT_REVERSIBLE.has(name);
      if (shouldReverse !== (twice === DOC)) {
        failures.push({
          case: `${name} (pressed twice)`,
          want: shouldReverse ? DOC : "anything but the original",
          got: twice,
        });
      }
    }
  }

  return { checked, failures };
}
