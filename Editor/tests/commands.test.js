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

export function run(view, bar, doc) {
  const failures = [];
  let checked = 0;

  {
    const undoResult = runUndo(view, doc);
    checked += undoResult.checked;
    failures.push(...undoResult.failures);
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
