/*
 * Live preview: rendered markdown everywhere except the line the caret is on.
 *
 * This is the hardest thing in the product and the thing most likely to make it feel broken. The
 * brief is blunt about it — "reconciling raw source with rendered decorations is where these editors
 * break, usually as cursor instability. If it feels janky the entire premise is gone."
 *
 * The contract, from decision 5: the buffer IS the markdown. Everything here is a view-only
 * decoration. Nothing in this file may change a single byte of the document, which is what lets Pane
 * promise a byte-for-byte round trip.
 *
 * WHAT HAPPENS ON THE ACTIVE LINE. Inline constructs go fully raw — the markers reappear and the
 * inline styling drops, matching the one example the design draws ("the raw syntax stays visible on
 * the active line: **byte-for-byte**"). Block constructs — heading size, code block background,
 * blockquote bar — keep their styling and merely reveal their markers. That split is deliberate:
 * bold and italic do not change line height, so revealing them costs nothing, whereas dropping an
 * h1 to body size as the caret enters it would reflow the document under the user's hands. That is
 * exactly the instability the brief warns about.
 */

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/**
 * Block constructs are styled with **line** decorations, not marks.
 *
 * A mark wraps an inline span, and margins and padding do not apply to it — so heading sizes and
 * list indents silently did nothing until this was changed. A line decoration puts the class on
 * CodeMirror's `.cm-line` element, which is a block box and takes layout.
 */
const BLOCK_LINE: Record<string, string> = {
  ATXHeading1: "pane-line-h1",
  ATXHeading2: "pane-line-h2",
  ATXHeading3: "pane-line-h3",
  ATXHeading4: "pane-line-h3",
  ATXHeading5: "pane-line-h3",
  ATXHeading6: "pane-line-h3",
  SetextHeading1: "pane-line-h1",
  SetextHeading2: "pane-line-h2",
  FencedCode: "pane-line-code",
  CodeBlock: "pane-line-code",
  Blockquote: "pane-line-quote",
};

const INLINE_STYLE: Record<string, string> = {
  StrongEmphasis: "pane-strong",
  Emphasis: "pane-em",
  Strikethrough: "pane-strike",
  InlineCode: "pane-code",
  Link: "pane-link",
};

/**
 * Marker nodes — the literal syntax characters. Hidden off the active line, revealed on it.
 * `HeaderMark` covers both the leading hashes and Setext underlines; `ListMark` is handled separately
 * because a bullet becomes a glyph rather than simply vanishing.
 */
const MARKER_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "URL",
  "CodeInfo",
]);

const hide = Decoration.replace({});

/** A rule spans its whole line, so it is drawn on the line box rather than on the three characters. */
const ruleLine = Decoration.line({ class: "pane-rule" });
const blankLine = Decoration.line({ class: "pane-line-blank" });
const fenceLine = Decoration.line({ class: "pane-line-fence" });

const syntaxMark = Decoration.mark({ class: "pane-syntax" });

/** A rendered ordered-list number: `1.` as the reader sees it, not as raw syntax. */
const numberMark = Decoration.mark({ class: "pane-list-number" });

/** A rendered task checkbox standing in for the literal `[ ]` or `[x]` in the buffer. */
class TaskWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly pos: number
  ) {
    super();
  }

  eq(other: TaskWidget) {
    // Position matters: two checkboxes in the same state are otherwise indistinguishable, and
    // CodeMirror would reuse the DOM node and send clicks to the wrong line.
    return other.done === this.done && other.pos === this.pos;
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = `pane-task ${this.done ? "pane-task--done" : "pane-task--todo"}`;
    box.textContent = this.done ? "✓" : "";
    box.dataset.paneTask = String(this.pos);
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.done));
    return box;
  }

  ignoreEvent() {
    // Let the click reach the editor's DOM handler, which edits the buffer rather than a model.
    return false;
  }
}

/** A bullet glyph replacing `-`, `*` or `+`. Nested lists step disc → circle, per design frame 1a. */
class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: BulletWidget) {
    return other.depth === this.depth;
  }

  toDOM() {
    const dot = document.createElement("span");
    dot.className = "pane-list-marker";
    dot.textContent = this.depth > 1 ? "◦" : "•";
    return dot;
  }
}

/**
 * Line numbers touched by any selection range — where raw source shows.
 *
 * **Nothing is active while the editor is not focused.** The caret's line reveals its source because
 * that is where you are working; a pane you have clicked away from is not where you are working, and
 * a note left showing `**A research plan**` on one line reads as a rendering bug rather than as a
 * caret. It is also what anyone comparing Pane to the reference sees first, since the reference
 * never shows raw markup at all.
 *
 * This costs nothing on the way back: focus returns, the line goes raw again, and the caret is still
 * where it was (decision 11). The heights match too — the caret's blank-line exemption below keys
 * off the same set, so a blurred pane reports exactly the height `caretBlankLineSlack` was already
 * subtracting, and the window does not move on blur.
 */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  const doc = view.state.doc;
  for (const range of view.state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

/** Nesting depth of a list item, for choosing the bullet glyph. */
function listDepth(view: EditorView, pos: number): number {
  let depth = 0;
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  while (node.parent) {
    if (node.name === "BulletList" || node.name === "OrderedList") depth++;
    node = node.parent;
  }
  return depth;
}

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const active = activeLines(view);
  const tree = syntaxTree(view.state);

  /// Line numbers inside a fenced or indented code block, so the blank-line pass below can leave
  /// their empty lines at full height.
  const codeLines = new Set<number>();

  // Only the visible ranges. A 3,000-word note must not be fully decorated to draw one screen —
  // that cost lands on every keystroke, and it is where these editors get slow.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const lineNumber = doc.lineAt(node.from).number;
        const isActive = active.has(lineNumber);

        if (name === "HorizontalRule") {
          // A line decoration, so the rule spans the pane instead of underlining three characters.
          //
          // Off the caret's line only. Drawn, the rule is 1px tall with `color: transparent` — and
          // it is still a real line the caret can be arrowed into, so without this exemption it is
          // a place you can stand, type, and see nothing happen. Every other construct reveals its
          // source under the caret; this one was the last that did not.
          if (!isActive) decorations.push(ruleLine.range(doc.lineAt(node.from).from));
          return;
        }

        const blockClass = BLOCK_LINE[name];
        if (blockClass) {
          // Block styling survives the caret. Dropping an h1 to body size as the caret arrives
          // would reflow the document mid-keystroke.
          const deco = Decoration.line({ class: blockClass });
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            decorations.push(deco.range(doc.line(n).from));
            if (blockClass === "pane-line-code") codeLines.add(n);
          }

          // A fenced block's first and last lines are its ``` fences, and on the opening one the
          // language tag too. Neither is content: Pane has no syntax highlighting and no language
          // picker, so `python` is a word the user has to look at that changes nothing. Collapsing
          // both to a thin strip turns them into the block's own top and bottom padding, which is
          // what a code block looks like everywhere it is rendered rather than edited.
          //
          // COLLAPSED ONLY OFF THE CARET'S LINE. Collapsed unconditionally, a fence is a 10px strip
          // that looks exactly like the blank line usually sitting next to it and behaves nothing
          // like it: one character typed in the opening strip stops the block being a code block,
          // and one typed in the closing strip unbounds it so it swallows the rest of the note.
          // Measured, both of them. The strip has to stop being invisible the moment the caret is
          // in it, which is the same rule every other construct here already follows.
          //
          // The 10px reflow that costs is deliberate, and is why the blank-line pass below still
          // refuses the same treatment: blank lines are crossed constantly with the arrow keys,
          // whereas a fence is somewhere you arrive rarely and on purpose.
          if (name === "FencedCode") {
            if (!active.has(first)) decorations.push(fenceLine.range(doc.line(first).from));
            if (last > first && !active.has(last)) {
              decorations.push(fenceLine.range(doc.line(last).from));
            }
          }
          return;
        }

        // List items carry their nesting depth as a class, so indentation comes from the stylesheet
        // rather than from however many spaces happen to be in the buffer. Rendering the raw spaces
        // in a proportional font gives ~4px a level where the design draws 22-26px.
        if (name === "ListItem") {
          const depth = Math.min(listDepth(view, node.from), 4);
          // ONLY the item's own first line. A ListItem's range covers any nested list beneath it, so
          // decorating every line in the range stamps the outer item's depth onto its children too —
          // a third-level line ends up carrying li-1, li-2 and li-3 at once, and which indent wins is
          // then decided by stylesheet order rather than by nesting. A soft-wrapped item is still one
          // .cm-line, so nothing is lost by decorating just the first.
          decorations.push(
            Decoration.line({ class: `pane-line-li pane-line-li-${depth}` }).range(
              doc.lineAt(node.from).from
            )
          );
          return;
        }

        const inlineClass = INLINE_STYLE[name];
        if (inlineClass && !isActive) {
          decorations.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
          return;
        }

        if (name === "TaskMarker") {
          if (isActive) return;
          const text = doc.sliceString(node.from, node.to);
          const done = /x/i.test(text);
          decorations.push(
            Decoration.replace({ widget: new TaskWidget(done, node.from) }).range(node.from, node.to)
          );
          return;
        }

        if (name === "ListMark") {
          const text = doc.sliceString(node.from, node.to);
          const ordered = /\d/.test(text);

          // A task item already has a checkbox standing in for its marker. Drawing a bullet as well
          // gives every to-do two markers, which is not what frame 1b shows.
          if (!isActive && /^\s*\[[ xX]\]/.test(doc.sliceString(node.to, Math.min(node.to + 6, doc.length)))) {
            decorations.push(hide.range(node.from, node.to));
            return;
          }

          if (isActive) {
            decorations.push(syntaxMark.range(node.from, node.to));
          } else if (ordered) {
            // Its own class rather than the raw-syntax one: a rendered `1.` is content the reader is
            // meant to see and is tinted with the accent, whereas `.pane-syntax` is the muted grey
            // that marks characters only showing because the caret is on the line.
            decorations.push(numberMark.range(node.from, node.to));
          } else {
            decorations.push(
              Decoration.replace({ widget: new BulletWidget(listDepth(view, node.from)) }).range(
                node.from,
                node.to
              )
            );
          }
          return;
        }

        if (MARKER_NODES.has(name)) {
          if (isActive) {
            // Revealed, but muted, so the line reads as text rather than as punctuation.
            decorations.push(syntaxMark.range(node.from, node.to));
          } else if (node.to > node.from) {
            decorations.push(hide.range(node.from, node.to));
          }
        }
      },
    });
  }

  // Blank lines get a shorter line box.
  //
  // This is the difference between live preview and rendered markdown, and it is what made Pane's
  // block rhythm visibly looser than the reference. In rendered HTML the blank line between two
  // paragraphs *disappears* and a margin replaces it; here the user typed it, it is in the buffer,
  // and it occupies a full 22px line box — so every gap is a whole line plus whatever margin the
  // next block carries. Shrinking the empty line keeps the source honest (the newline is still
  // there, the caret still goes in it) while giving the document the spacing of the thing it is
  // pretending to be.
  //
  // THE CARET'S LINE IS EXEMPT, reversing what this comment used to say.
  //
  // It used to argue that growing the line back as the caret arrives would shift everything below it
  // on an arrow keypress, and that cursor instability is how this approach fails. The first half is
  // true and the second half is what made it the wrong call: the shift happens either way, and
  // leaving it in meant it happened *while typing* instead of while navigating.
  //
  // What that felt like, which is how it was reported: press Return in prose, and the caret lands in
  // a 10px box hard against the line above; type one character, the line becomes an ordinary
  // paragraph, and the text appears 12px BELOW where the caret just was. Every Return in prose, which
  // is the most common thing anyone does in a notes app. A caret that is not where the text lands is
  // exactly the instability the warning was about — it just arrived through the keyboard rather than
  // through the arrow keys.
  //
  // Exempting the caret's line makes typing dead stable: the line is already at its full height when
  // the caret gets there, so the first keystroke moves nothing. The cost moves to leaving a blank
  // line, where a 12px shift reads as the document closing up behind you rather than as the text
  // jumping out from under the caret. It also makes the rule uniform — every line in the document now
  // renders at its natural size under the caret, blank lines included, which is what decisions 42
  // and 34 were already reaching for.
  for (const { from, to } of view.visibleRanges) {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      // Inside a fenced block a blank line is content with a background, and collapsing it would
      // put a notch in the block's left edge.
      if (line.length === 0 && !codeLines.has(n) && !active.has(n)) {
        decorations.push(blankLine.range(line.from));
      }
    }
  }

  // Sorted on construction rather than fed through a RangeSetBuilder: the tree yields nodes in
  // document order, but an outer mark and an inner replace can share a start offset, and getting
  // their relative side wrong throws. Letting Decoration.set sort is cheap at note scale and cannot
  // be got subtly wrong.
  return Decoration.set(decorations, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Selection is in the list because moving the caret onto a line reveals its source. That is
      // the feature, and it is also why this must stay cheap.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        // Focus is in the list because losing it renders the whole document — see `activeLines`.
        // Without this the raw line simply stayed raw, because nothing else about the state changed.
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,

    // Hidden markers must not swallow the caret. Without this, arrowing across a hidden `**` leaves
    // the caret in a position the user cannot see, and every subsequent keystroke lands somewhere
    // surprising — the classic live-preview cursor bug.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? RangeSet.empty),
  }
);

/**
 * Clicking a checkbox rewrites the literal `[ ]` / `[x]` in the buffer.
 *
 * Deliberately an edit rather than a toggle on a model: there is no model. The document is the only
 * state, so the checkbox has to change the same characters the user would have changed by typing.
 */
const taskClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const marker = target?.closest?.("[data-pane-task]") as HTMLElement | null;
    if (!marker) return false;

    const pos = Number(marker.dataset.paneTask);
    if (!Number.isFinite(pos)) return false;

    const current = view.state.doc.sliceString(pos, pos + 3);
    const next = /\[[xX]\]/.test(current) ? "[ ]" : "[x]";
    view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } });

    event.preventDefault();
    return true;
  },
});

/**
 * How much taller the caret's line is than the collapsed blank line it would otherwise be.
 *
 * The caret's blank line is exempt from the collapse above, so that typing the first character moves
 * nothing. That exemption is a *rendering* choice and the window must not follow it: without this,
 * arrowing across the blank lines of a short note grows and shrinks the pane by 12px each time,
 * because every height decision goes through the content height the web layer reports (decision 40).
 * The pane would pulse for the whole length of a note.
 *
 * So the height that goes to Swift is reported as though the caret's line were still collapsed.
 * Content below the caret still opens and closes inside the pane, which is what the exemption is
 * for; the window simply does not chase it. The cost is that while the caret sits on a blank line
 * the note is 12px taller than the pane admits, so a note filling the pane exactly can put its last
 * line under the fade until the caret moves — much cheaper than a window that breathes.
 *
 * Lives here rather than in the reporter because the rule that creates the slack is the rule that
 * has to measure it; splitting them is how the two come to disagree.
 */
export function caretBlankLineSlack(view: EditorView): number {
  const range = view.state.selection.main;
  if (!range.empty) return 0;

  const line = view.state.doc.lineAt(range.head);
  if (line.length !== 0) return 0;

  // A blank line inside a code block is never collapsed, so it has no slack to give back.
  let node = syntaxTree(view.state).resolveInner(line.from, 1);
  while (node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return 0;
    node = node.parent;
  }

  const collapsed = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--blank-line-height")
  );
  if (!Number.isFinite(collapsed)) return 0;

  const slack = view.lineBlockAt(line.from).height - collapsed;
  return slack > 0 ? slack : 0;
}

/**
 * Live preview, as one extension.
 *
 * A StateField would have been the other option, but the decorations depend on the *viewport*, which
 * a StateField cannot see. Hence a ViewPlugin.
 */
export function livePreview(): Extension {
  return [livePreviewPlugin, taskClickHandler];
}

// Re-exported so the unused-import checker does not hide a genuine mistake if this is refactored.
export type { DecorationSet, StateField };
