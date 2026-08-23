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
import { type Extension, type Range, RangeSet, StateField, Transaction } from "@codemirror/state";
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

/**
 * The space between two blocks the user did not separate with a blank line — decision 55.
 *
 * A tight list has no blank lines in it, so every item sat exactly one line-height below the last
 * and a five-item list read as one paragraph with bullets in it. The reference puts 8pt between
 * sibling items and between any two blocks; where the user *has* typed a blank line, that line is
 * already the gap (decision 22) and this stays out of the way.
 */
const gapLine = Decoration.line({ class: "pane-line-gap" });
const fenceLine = Decoration.line({ class: "pane-line-fence" });

/*
 * A fence that is *showing* its backticks.
 *
 * Decision 42 collapsed both fences into "the block's own padding", and that is literally what they
 * were: an 8px strip of code-slab above the first line of code and below the last. Reveal one and
 * the strip becomes a full code line with text in it, so the padding it was standing in for
 * vanishes and ```` ```python ```` sits flush against the top edge of the slab.
 *
 * The block gets that padding back explicitly for as long as the fence is visible. It costs height
 * on the way in, which decision 42 already accepted for the reveal itself.
 */
const fenceOpenRaw = Decoration.line({ class: "pane-line-fence-open-raw" });
const fenceCloseRaw = Decoration.line({ class: "pane-line-fence-close-raw" });

const syntaxMark = Decoration.mark({ class: "pane-syntax" });

/*
 * A list marker showing its source.
 *
 * `.pane-syntax` is a colour and nothing else, so a revealed marker fell back to the line's own
 * `padding-left` — while the rendered marker it replaces sits in a 16px box with a -16px margin
 * that pulls it back out into the gutter. Measured: the marker jumped **16px to the right** the
 * moment the caret landed on its line, and the whole line appeared to indent one step. Every kind
 * of list, which is what made it look like a layout bug rather than a reveal.
 *
 * The same box, so the marker stays where it was drawn. It covers the space after the marker too:
 * that space is hidden while rendered and real while raw, so without it inside the box the text
 * after the marker lands a space-width right of where it was.
 */
const rawListMark = Decoration.mark({ class: "pane-syntax pane-syntax-listmark" });

/** The text of a ticked task item. */
const doneTaskText = Decoration.mark({ class: "pane-task-done-text" });

/**
 * Two constructs the markdown parser has no node for — decision 61.
 *
 * `==highlight==` is not CommonMark (Obsidian, Bear and Typora all read it) and `<u>underline</u>`
 * is markdown's escape hatch rather than markdown, so neither arrives as a tree node and both are
 * matched on the text instead. That is only safe because the match is anchored to a whole line and
 * checked against the tree afterwards: a `==` inside code is code, not a highlight.
 */
const TEXT_CONSTRUCTS: { pattern: RegExp; open: number; close: number; class: string }[] = [
  // No space just inside the delimiters, the same rule `**bold**` follows — without it a line like
  // "a total of == two == equals" was a highlight containing the word "two".
  { pattern: /==(?!\s)([^=\n]+?)(?<!\s)==/g, open: 2, close: 2, class: "pane-mark" },
  { pattern: /<u>(.+?)<\/u>/g, open: 3, close: 4, class: "pane-underline" },
];

/** Is this offset inside code, where a `==` is two equals signs and nothing more? */
function insideCode(view: EditorView, pos: number): boolean {
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  while (node.parent) {
    if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock") {
      return true;
    }
    node = node.parent;
  }
  return false;
}

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

/**
 * A bullet glyph replacing `-`, `*` or `+`.
 *
 * Three steps, disc → circle → square. Frame 1a draws the first two and the reference draws all
 * three; a third level that reuses the second's glyph makes two different depths look like one list
 * that has lost its indent, which is exactly when the glyph is doing its only job. Deeper than three
 * repeats the square rather than inventing a fourth shape nobody could name.
 */
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
    dot.textContent = ["•", "◦", "▪"][Math.min(this.depth, 3) - 1] ?? "•";
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
/**
 * Lines holding a **caret** — an empty selection — and nothing else.
 *
 * `activeLines` is every line a selection *touches*, which is right for revealing markers and wrong
 * for anything that changes a line's height. Select the whole note and every blank line, fence and
 * rule in it un-collapses at once: measured on a four-block note, ⌘A grew the document by 24px and
 * pushed every paragraph down, which reads as the text jumping when you select it.
 *
 * Decision 44 is written in terms of "the caret's line" and that is exactly what it should have
 * keyed off. A range selection is not a place you are standing, it is a thing you have marked, and
 * `caretBlankLineSlack` already refuses to report slack for one — so with `activeLines` driving the
 * collapse, the document grew and the height Swift was told did not.
 *
 * **The rule: height-changing reveals follow the caret; the rest follow the active line.**
 */
function caretLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    if (range.empty) lines.add(view.state.doc.lineAt(range.head).number);
  }
  return lines;
}

/**
 * Whether the caret got where it is by **typing** rather than by being moved there.
 *
 * Decision 44 exempts the caret's blank line from the collapse so that pressing ⏎ in prose lands
 * the caret at full height and the first keystroke moves nothing. That argument is entirely about
 * *arriving by editing*. Applied to arriving by clicking or arrowing it buys nothing and costs the
 * thing it was written to prevent: click the blank line between two paragraphs and it grows 8px to
 * 20px under the pointer, so the note appears to gain a line you did not ask for. Reported exactly
 * that way, on the grounds that ⏎ and ⇧⏎ are how you ask for space.
 *
 * So the exemption keys off this instead. Set by any document change and cleared by a selection
 * change that is not one — never cleared by a rebuild for some other reason (a viewport scroll, a
 * tree finishing), because those do not move the caret and must not change what it is standing on.
 *
 * Module state rather than a StateField because it describes the *last update*, not the document,
 * and there is exactly one editor in this app.
 */
let caretArrivedByEdit = false;

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

/**
 * Markdown's "leaf blocks" — the constructs that hold text rather than other blocks.
 *
 * A `ListItem` is not one: the paragraph *inside* it is, which is what makes this usable for
 * spacing. Every line belongs to exactly one of these, and the line it starts on is the line that
 * opens a new block.
 */
const LEAF_BLOCKS = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "HorizontalRule",
  "Table",
]);

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
  const caret = caretLines(view);
  const tree = syntaxTree(view.state);

  /// The selection itself, for constructs that reveal on the *caret* rather than on the line —
  /// decision 57. Empty while unfocused, for the same reason `activeLines` is empty then.
  const selections = view.hasFocus ? view.state.selection.ranges : [];
  const touches = (from: number, to: number) =>
    selections.some((range) => range.from <= to && range.to >= from);

  /// Every inline construct met so far and whether the selection is inside it. The tree is walked
  /// depth-first, so a construct is always entered before its own markers: by the time a mark is
  /// reached, the answer for the thing it belongs to is already here.
  const inlineRanges: { from: number; to: number; revealed: boolean }[] = [];

  /// Line numbers inside a fenced or indented code block, so the blank-line pass below can leave
  /// their empty lines at full height.
  const codeLines = new Set<number>();

  /// Line numbers a block begins on, for the gap above it (decision 55). Collected here rather than
  /// resolved per line: a list line's innermost node at its own start offset is the ListMark, and no
  /// amount of walking *up* from there reaches the paragraph inside the item, which is the block that
  /// actually starts there. The traversal below passes through every one of them anyway.
  const blockStarts = new Set<number>();

  /*
   * The space between a marker and the text goes with the marker.
   *
   * `ListMark` covers `-` or `1.` and `QuoteMark` covers `>`, neither of which includes the space
   * after it — so that space was rendered, about 3px of it, and pushed the first line's text right
   * while the block's own continuation line stayed put. Every list was three pixels out of line
   * with itself, a task list seven because it has two such spaces, and a blockquote three.
   *
   * The slot the marker sits in *is* the gap. A literal space on top of it is the same "two sources
   * for one indent" that the leading indentation already had to lose.
   */
  const hideSpaceAfter = (at: number) => {
    const line = doc.lineAt(at);
    let end = at;
    while (end < line.to && doc.sliceString(end, end + 1) === " ") end++;
    if (end > at) decorations.push(hide.range(at, end));
  };

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

        // `ListItem` as well as the leaf blocks, because a task item has no `Paragraph` inside it —
        // its text hangs directly off the item — so `- [ ] one` / `- [x] two` were the one kind of
        // list that got no separation while every other list did.
        if (LEAF_BLOCKS.has(name) || name === "ListItem") blockStarts.add(lineNumber);

        if (name === "HorizontalRule") {
          // A line decoration, so the rule spans the pane instead of underlining three characters.
          //
          // Off the caret's line only. Drawn, the rule is 1px tall with `color: transparent` — and
          // it is still a real line the caret can be arrowed into, so without this exemption it is
          // a place you can stand, type, and see nothing happen. Every other construct reveals its
          // source under the caret; this one was the last that did not.
          if (!caret.has(lineNumber)) {
            decorations.push(ruleLine.range(doc.lineAt(node.from).from));
          }
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
            if (caret.has(first)) {
              decorations.push(fenceOpenRaw.range(doc.line(first).from));
            } else {
              decorations.push(fenceLine.range(doc.line(first).from));
            }
            if (last > first) {
              if (caret.has(last)) {
                decorations.push(fenceCloseRaw.range(doc.line(last).from));
              } else {
                decorations.push(fenceLine.range(doc.line(last).from));
              }
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
          const itemFirst = doc.lineAt(node.from);
          decorations.push(
            Decoration.line({ class: `pane-line-li-${depth}` }).range(itemFirst.from)
          );

          // A ⇧⏎ inside an item makes a second line that belongs to it, and it used to get no
          // indent at all — so "- one / two" drew `two` hard against the pane's left edge while
          // `one` sat 26px in. It takes the item's padding without the hanging indent, which is
          // what puts it under the text rather than under the marker.
          const itemLast = doc.lineAt(Math.min(node.to, doc.length));
          for (let n = itemFirst.number + 1; n <= itemLast.number; n++) {
            const line = doc.line(n);
            if (line.length === 0) continue;
            decorations.push(
              Decoration.line({ class: `pane-line-li-${depth}` }).range(line.from)
            );
            // And any literal indent an older note carries goes with it, for the same reason the
            // marker line's does: two answers to one indent is one too many.
            const spaces = /^ +/.exec(line.text)?.[0].length ?? 0;
            if (spaces > 0) decorations.push(hide.range(line.from, line.from + spaces));
          }
          return;
        }

        // An inline construct goes raw when the selection is *inside it*, not when it is anywhere
        // on the line (decision 57). Putting the caret at the end of a paragraph used to strip the
        // styling off every bold word in it and put four asterisks back on screen.
        const inlineClass = INLINE_STYLE[name];
        if (inlineClass) {
          const revealed = touches(node.from, node.to);
          inlineRanges.push({ from: node.from, to: node.to, revealed });
          if (!revealed) {
            decorations.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
          }
          return;
        }

        if (name === "TaskMarker") {
          if (isActive) return;
          const text = doc.sliceString(node.from, node.to);
          const done = /x/i.test(text);
          decorations.push(
            Decoration.replace({ widget: new TaskWidget(done, node.from) }).range(node.from, node.to)
          );
          // And the single space after `]`, which would otherwise push the text 4px past where
          // every other list's text starts. The checkbox's own 16px slot is the gap.
          if (doc.sliceString(node.to, node.to + 1) === " ") {
            decorations.push(hide.range(node.to, node.to + 1));
          }
          // A ticked item's text greys out and strikes through. `markdown.css` has described that
          // as the behaviour since the checkbox shipped and nothing has ever applied the class, so
          // a done task looked exactly like an undone one apart from the box — the fifth rule in
          // this codebase found to be stating a mechanism that never ran.
          if (done) {
            const line = doc.lineAt(node.from);
            if (node.to < line.to) {
              decorations.push(doneTaskText.range(node.to, line.to));
            }
          }
          return;
        }

        if (name === "ListMark") {
          // The literal indentation in front of the marker goes away with it.
          //
          // Indent comes from the nesting depth (see `pane-line-li-N`), and the two spaces per level
          // in the buffer were being *rendered as well* — so a second-level bullet sat a space-width
          // right of where the stylesheet put it, a third-level one two space-widths, and the error
          // compounded with depth. Level one was right, which is why this survived the measuring
          // pass: it is the one level with nothing in front of the marker.
          const lineStart = doc.lineAt(node.from);
          if (node.from > lineStart.from) {
            decorations.push(hide.range(lineStart.from, node.from));
          }

          const text = doc.sliceString(node.from, node.to);
          const ordered = /\d/.test(text);


          // A task item already has a checkbox standing in for its marker. Drawing a bullet as well
          // gives every to-do two markers, which is not what frame 1b shows.
          if (!isActive && /^\s*\[[ xX]\]/.test(doc.sliceString(node.to, Math.min(node.to + 6, doc.length)))) {
            decorations.push(hide.range(node.from, node.to));
            hideSpaceAfter(node.to);
            return;
          }

          if (isActive) {
            // Through the space after it, so the box matches the rendered marker's — see rawListMark.
            const after = doc.sliceString(node.to, Math.min(node.to + 1, doc.length));
            decorations.push(rawListMark.range(node.from, node.to + (after === " " ? 1 : 0)));
          } else if (ordered) {
            // Its own class rather than the raw-syntax one: a rendered `1.` is content the reader is
            // meant to see and is tinted with the accent, whereas `.pane-syntax` is the muted grey
            // that marks characters only showing because the caret is on the line.
            decorations.push(numberMark.range(node.from, node.to));
            hideSpaceAfter(node.to);
          } else {
            decorations.push(
              Decoration.replace({ widget: new BulletWidget(listDepth(view, node.from)) }).range(
                node.from,
                node.to
              )
            );
            hideSpaceAfter(node.to);
          }
          return;
        }

        if (MARKER_NODES.has(name)) {
          // A mark follows whatever it belongs to. Inside an inline construct that is the construct
          // — the `**` appear with the caret and stay hidden while it is elsewhere on the line. A
          // block's marks — a heading's hashes, a quote's `>`, a fence and its language — keep the
          // line rule, because they sit at the start of the line rather than inside the sentence,
          // and they are how you change what kind of block you are standing in.
          const owner = inlineRanges.find((r) => r.from <= node.from && r.to >= node.to);
          if (owner ? owner.revealed : isActive) {
            // Revealed, but muted, so the line reads as text rather than as punctuation.
            decorations.push(syntaxMark.range(node.from, node.to));
          } else if (node.to > node.from) {
            decorations.push(hide.range(node.from, node.to));
            // A quote's `>` takes its space with it, exactly as a list marker does — otherwise a
            // quoted line starts 3px right of its own continuation.
            if (name === "QuoteMark") hideSpaceAfter(node.to);
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
      //
      // An empty *document* is exempt as well, and not for rhythm: its one line carries the
      // placeholder, and an 8px box would leave "Start writing…" spilling out of the line it is
      // drawn in. An unfocused empty pane is exactly when that shows, because nothing is active.
      const exempt = caret.has(n) && caretArrivedByEdit;
      if (doc.length > 0 && line.length === 0 && !codeLines.has(n) && !exempt) {
        decorations.push(blankLine.range(line.from));
        continue;
      }

      // `==highlight==` and `<u>underline</u>`, which the parser does not know about (decision 61).
      // Same reveal rule as every other inline construct: markers show when the selection is inside
      // this one, and stay hidden when it is elsewhere on the line (decision 57).
      if (!codeLines.has(n)) {
        for (const construct of TEXT_CONSTRUCTS) {
          construct.pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = construct.pattern.exec(line.text)) !== null) {
            const from = line.from + match.index;
            const to = from + match[0].length;
            if (insideCode(view, from + 1)) continue;

            const inner = { from: from + construct.open, to: to - construct.close };
            if (touches(from, to)) {
              decorations.push(syntaxMark.range(from, inner.from));
              decorations.push(syntaxMark.range(inner.to, to));
            } else {
              decorations.push(hide.range(from, inner.from));
              decorations.push(
                Decoration.mark({ class: construct.class }).range(inner.from, inner.to)
              );
              decorations.push(hide.range(inner.to, to));
            }
          }
        }
      }

      // The gap above a block the user did not separate with a blank line — decision 55. Only where
      // there is no blank line to do the job, so nothing the user typed is ever double-counted, and
      // never at the top of the document, where there is nothing to be separated from.
      if (n > 1 && doc.line(n - 1).length > 0 && blockStarts.has(n)) {
        decorations.push(gapLine.range(line.from));
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
      // Before the rebuild below, because it decides what that rebuild draws — see the note on
      // `caretArrivedByEdit`. A doc change sets it; a bare selection change clears it; anything else
      // leaves it alone, because anything else has not moved the caret.
      // A note arriving from Swift is a document change and is emphatically not an edit — it carries
      // `addToHistory: false` for undo's sake (decision 80), and the same annotation answers this.
      // Without it, opening a note whose remembered caret offset happens to sit on a blank line
      // (decision 11 restores the exact offset) came up with that line already open, which is the
      // reported bug arriving by the one route that never touches the mouse.
      const restored = update.transactions.some(
        (tr) => tr.annotation(Transaction.addToHistory) === false
      );
      if (restored) caretArrivedByEdit = false;
      else if (update.docChanged) caretArrivedByEdit = true;
      else if (update.selectionSet) caretArrivedByEdit = false;

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
/**
 * A click on the blank line between two paragraphs does nothing at all.
 *
 * That line is a real `\n` in the file — the paragraph break itself — so the caret can perfectly
 * well stand on it, and for a long time it did. But it is drawn as an 8px strip of empty space, and
 * a strip of empty space between two paragraphs does not read as a place: it reads as the gap
 * between them. Clicking it and getting a caret you did not ask for, in a gap you were only aiming
 * *past*, is the note behaving like a text file rather than like a note. Typora and Obsidian both
 * swallow it.
 *
 * **Only a genuine separator** — an empty line with text immediately above *and* below. That is the
 * case being described and nothing else, which keeps three things working that would otherwise
 * break: a trailing blank line stays clickable, because it is where "click under the last line of
 * the note" lands; a run of blank lines stays clickable, because you may well want to delete one;
 * and a blank line inside a fenced block is content with a background, not a gap.
 *
 * Two more guards. `posAtCoords` is asked for a *precise* hit, so a click in the empty space below
 * the note returns null and falls through to CodeMirror — otherwise a note ending in a blank line
 * would swallow the most ordinary click there is. And an unfocused editor always lets the click
 * through, because swallowing it would leave the pane unfocusable by clicking in the wrong spot.
 *
 * Arrow keys still walk onto the line, and ⌫ still deletes the break (see `joinBackToParagraph`),
 * so nothing about the document has become unreachable — only the aiming has got easier.
 */
const blankLineClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!view.hasFocus) return false;

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    if (line.length !== 0) return false;
    if (line.number <= 1 || line.number >= doc.lines) return false;
    if (doc.line(line.number - 1).length === 0) return false;
    if (doc.line(line.number + 1).length === 0) return false;

    for (let node = syntaxTree(view.state).resolveInner(line.from, 1); node.parent; node = node.parent) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
    }

    event.preventDefault();
    return true;
  },
});

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
  return [livePreviewPlugin, blankLineClickHandler, taskClickHandler];
}

// Re-exported so the unused-import checker does not hide a genuine mistake if this is refactored.
export type { DecorationSet, StateField };
