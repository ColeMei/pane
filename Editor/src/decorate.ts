/*
 * What the tree draws as — every construct as one function, dispatched by node name.
 *
 * `buildDecorations` walks the visible part of the syntax tree once and hands each node to the
 * handler its name selects (`CONSTRUCTS`), then runs one pass over the visible lines for what has no
 * node: blank lines, `==highlight==` and `<u>`, and the gap between blocks. Whether a construct is
 * *revealed* is not decided here — `reveal.ts` answers that once per rebuild and every handler reads
 * the answer — so this file is only ever asked "given that, what is drawn". Nothing in it changes a
 * byte of the document (decision 5).
 */

import { syntaxTree } from "@codemirror/language";
import { endOfOwnContent } from "./blocks";
import type { SyntaxNodeRef } from "@lezer/common";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type { Reveal } from "./reveal";

/** Block constructs are line decorations: a mark wraps an inline span and takes no margin or padding,
 * so heading sizes and list indents did nothing as marks. */
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
  // CommonMark's `<https://x.com>`. A separate node type from `Link`, and leaving it out meant it
  // had no owner in `inlineRanges` — so its `<` and `>` fell back to the line rule, and its `URL`
  // was hidden as a marker with nothing left to show. Decision 121.
  Autolink: "pane-link",
  // A bare `https://x.com`, `www.x.com` or `a@b.com`. GFM parses these as a `URL` with no
  // construct around it at all, so this entry is what gives them the accent — and, because
  // `INLINE_STYLE` is what `inlineRanges` is built from, what makes them reveal under the caret
  // like every other inline construct. Guarded below: a `[label](target)` link's `URL` is a
  // marker, not content, and must not match here.
  URL: "pane-link",
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

/** The gap above a block the user did not separate with a blank line — decision 55. Where a blank
 * line exists it is already the gap. */
const gapLine = Decoration.line({ class: "pane-line-gap" });
const fenceLine = Decoration.line({ class: "pane-line-fence" });

/* A fence showing its backticks gets the block's padding back explicitly: collapsed, the fence *is*
 * the padding, and revealing it left ```` ```python ```` flush with the slab's top edge (decision 42,
 * amended 2026-09-17). */
const fenceOpenRaw = Decoration.line({ class: "pane-line-fence-open-raw" });
const fenceCloseRaw = Decoration.line({ class: "pane-line-fence-close-raw" });

const syntaxMark = Decoration.mark({ class: "pane-syntax" });

/* A revealed list marker keeps the rendered marker's fixed box, space included: `.pane-syntax` alone
 * let it jump 16px right and the text a space-width further (decisions 108, 122). */
const rawListMark = Decoration.mark({ class: "pane-syntax pane-syntax-listmark" });

/** The text of a ticked task item. */
const doneTaskText = Decoration.mark({ class: "pane-task-done-text" });

/** `==highlight==` and `<u>` have no parser node, so they are matched on the line's text and checked
 * against the tree — a `==` inside code is code (decision 61). */
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

/** A revealed `[ ]`, in the checkbox's box — its own class because it wants a fixed width where
 * `rawListMark` must not have one: a raw list marker ends in a space a fixed box strands (decision 122). */
const rawTaskMark = Decoration.mark({ class: "pane-syntax pane-syntax-taskmark" });

/** The same, for a to-do inside a **numbered** item, where the number already has the line's one
 * marker slot — so this stands in the text flow after it rather than in the slot. See `TaskWidget`. */
const rawTaskMarkInFlow = Decoration.mark({
  class: "pane-syntax pane-syntax-taskmark pane-syntax-taskmark--inflow",
});

/** A rendered task checkbox standing in for the literal `[ ]` or `[x]` in the buffer. */
class TaskWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly pos: number,
    /** The item is numbered, so the number holds the line's marker slot and this box does not. */
    readonly inFlow = false
  ) {
    super();
  }

  eq(other: TaskWidget) {
    // Position matters: two checkboxes in the same state are otherwise indistinguishable, and
    // CodeMirror would reuse the DOM node and send clicks to the wrong line.
    return other.done === this.done && other.pos === this.pos && other.inFlow === this.inFlow;
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = `pane-task ${this.done ? "pane-task--done" : "pane-task--todo"}${
      this.inFlow ? " pane-task--inflow" : ""
    }`;
    // Done is a **fill**, drawn in CSS, not a tick glyph. A ✓ set in the body font is a character
    // with the body font's own optical centre and side bearings, so it never sits square in a box
    // — and it has to be re-tuned every time the box size changes, which is decision 82's class.
    // A filled square inside the outline is the same shape at every size and needs no metrics.
    box.textContent = "";
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

/** A bullet glyph: disc → circle → square, then square again — a third level reusing the second's
 * glyph reads as a lost indent (frame 1a; the reference draws three). */
class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: BulletWidget) {
    return other.depth === this.depth;
  }

  toDOM() {
    // Drawn in CSS, not a character: `•` `◦` `▪` paint 3/3/7px of ink and no multiplier fixes all three
    // (decision 122). A real element, so the shape can be measured.
    const dot = document.createElement("span");
    dot.className = `pane-list-marker pane-bullet-${Math.min(this.depth, 3)}`;
    // A real element rather than a `::before`, so the shape can be measured. A pseudo-element has
    // no rect any test can read, and the first version of this centring painted both dots a
    // half-line low with the whole geometry suite green — it could see the marker's box and not
    // the mark inside it.
    dot.appendChild(document.createElement("i"));
    return dot;
  }
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

/** Everything the walk shares: the document, the reveal answer, and the lists being built. */
interface Walk {
  view: EditorView;
  doc: EditorView["state"]["doc"];
  reveal: Reveal;
  decorations: Range<Decoration>[];
  /// Every inline construct met so far and whether the selection is inside it. The tree is walked
  /// depth-first, so a construct is always entered before its own markers: by the time a mark is
  /// reached, the answer for the thing it belongs to is already here.
  inlineRanges: { from: number; to: number; revealed: boolean }[];

  /// Line numbers inside a fenced or indented code block, so the blank-line pass below can leave
  /// their empty lines at full height.
  codeLines: Set<number>;

  /// Line numbers a block begins on, for the gap above it (decision 55). Collected here rather than
  /// resolved per line: a list line's innermost node at its own start offset is the ListMark, and no
  /// amount of walking *up* from there reaches the paragraph inside the item, which is the block that
  /// actually starts there. The traversal below passes through every one of them anyway.
  blockStarts: Set<number>;

  /** The space after a marker goes with the marker; see the note on the function below. */
  hideSpaceAfter: (at: number) => void;
}

function horizontalRule(node: SyntaxNodeRef, w: Walk): void {
  const lineNumber = w.doc.lineAt(node.from).number;
  // A line decoration, off the caret's line only: drawn, the rule is a 1px line you can stand in and
  // type into unseen (decision 42).
  if (!w.reveal.lines.has(lineNumber)) {
    w.decorations.push(ruleLine.range(w.doc.lineAt(node.from).from));
  }
  return;
}

function blockLines(node: SyntaxNodeRef, w: Walk): void {
  const name = node.name;
  const blockClass = BLOCK_LINE[name];
  if (blockClass) {
    // Block styling survives the caret. Dropping an h1 to body size as the caret arrives
    // would reflow the document mid-keystroke.
    const deco = Decoration.line({ class: blockClass });
    const first = w.doc.lineAt(node.from).number;
    const last = w.doc.lineAt(node.to).number;
    for (let n = first; n <= last; n++) {
      w.decorations.push(deco.range(w.doc.line(n).from));
      if (blockClass === "pane-line-code") w.codeLines.add(n);
    }

    // Both fences and the info string are chrome, collapsed into the block's own padding — only off the
    // caret's line: a collapsed fence is a 10px strip that looks like a blank line and unbounds the block
    // when typed into (decisions 34, 42). Blank lines refuse the same treatment: they are crossed constantly.
    if (name === "FencedCode") {
      if (w.reveal.lines.has(first)) {
        w.decorations.push(fenceOpenRaw.range(w.doc.line(first).from));
      } else {
        w.decorations.push(fenceLine.range(w.doc.line(first).from));
      }
      if (last > first) {
        if (w.reveal.lines.has(last)) {
          w.decorations.push(fenceCloseRaw.range(w.doc.line(last).from));
        } else {
          w.decorations.push(fenceLine.range(w.doc.line(last).from));
        }
      }
    }
    return;
  }
}

function listItem(node: SyntaxNodeRef, w: Walk): void {
  const depth = Math.min(listDepth(w.view, node.from), 4);
  // ONLY the item's own first line. A ListItem's range covers any nested list beneath it, so
  // decorating every line in the range stamps the outer item's depth onto its children too —
  // a third-level line ends up carrying li-1, li-2 and li-3 at once, and which indent wins is
  // then decided by stylesheet order rather than by nesting. A soft-wrapped item is still one
  // .cm-line, so nothing is lost by decorating just the first.
  const itemFirst = w.doc.lineAt(node.from);
  w.decorations.push(
    Decoration.line({ class: `pane-line-li-${depth}` }).range(itemFirst.from)
  );

  // A ⇧⏎ continuation line takes the item's padding without the hanging indent, so it sits under the
  // text (108). Only the item's *own* lines: its range covers the nested list beneath it, and stamping
  // the outer depth on every line left four equal-specificity rules deciding the indent (108, 71's trap).
  const itemLast = w.doc.lineAt(Math.min(endOfOwnContent(w.view.state, node.node), w.doc.length));
  for (let n = itemFirst.number + 1; n <= itemLast.number; n++) {
    const line = w.doc.line(n);
    if (line.length === 0) continue;
    w.decorations.push(
      Decoration.line({ class: `pane-line-li-${depth}` }).range(line.from)
    );
    // And any literal indent an older note carries goes with it, for the same reason the
    // marker line's does: two answers to one indent is one too many.
    const spaces = /^ +/.exec(line.text)?.[0].length ?? 0;
    if (spaces > 0) w.decorations.push(hide.range(line.from, line.from + spaces));
  }
  return;
}

function inlineConstruct(node: SyntaxNodeRef, w: Walk): void {
  const name = node.name;
  // An inline construct goes raw when the selection is inside it, not anywhere on the line (57). A
  // `URL` is a marker only inside `[label](target)`; everywhere else it is the only thing to show, and
  // an image is left as the markdown it is — nothing renders as nothing (121).
  const parentName =
    name === "URL" || MARKER_NODES.has(name) ? node.node.parent?.name : undefined;
  const insideImage = parentName === "Image";
  const inlineClass =
    name === "URL" && (parentName === "Link" || parentName === "Autolink" || insideImage)
      ? undefined
      : INLINE_STYLE[name];
  if (inlineClass) {
    const revealed = w.reveal.touches(node.from, node.to);
    w.inlineRanges.push({ from: node.from, to: node.to, revealed });
    if (!revealed) {
      w.decorations.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
    }
    return;
  }
  // A `URL` inside a link or an image is not a construct of its own: it is that
  // construct's marker, and takes the marker row below.
  marker(node, w);
}

function escape(node: SyntaxNodeRef, w: Walk): void {
  const owner = w.inlineRanges.find((r) => r.from <= node.from && r.to >= node.to);
  if (owner ? owner.revealed : w.reveal.touches(node.from, node.to)) {
    w.decorations.push(syntaxMark.range(node.from, node.from + 1));
  } else {
    w.decorations.push(hide.range(node.from, node.from + 1));
  }
  return;
}

function taskMarker(node: SyntaxNodeRef, w: Walk): void {
  const lineNumber = w.doc.lineAt(node.from).number;
  const isActive = w.reveal.lines.has(lineNumber);
  // A numbered to-do keeps its number in the line's one marker slot and the box stands in the flow
  // after it — both in the slot painted on top of each other (decision 135).
  const inFlow = /^[ \t]*\d+[.)][ \t]/.test(w.doc.lineAt(node.from).text);
  if (isActive) {
    // The raw `[ ]` goes in the checkbox's box, as a revealed `-` or `1.` does; as literal text after
    // it, it pushed the words 24px right (decision 122).
    w.decorations.push((inFlow ? rawTaskMarkInFlow : rawTaskMark).range(node.from, node.to));
    if (w.doc.sliceString(node.to, node.to + 1) === " ") {
      w.decorations.push(hide.range(node.to, node.to + 1));
    }
    return;
  }
  const text = w.doc.sliceString(node.from, node.to);
  const done = /x/i.test(text);
  w.decorations.push(
    Decoration.replace({ widget: new TaskWidget(done, node.from, inFlow) }).range(
      node.from,
      node.to
    )
  );
  // And the single space after `]`, which would otherwise push the text 4px past where
  // every other list's text starts. The checkbox's own 16px slot is the gap.
  if (w.doc.sliceString(node.to, node.to + 1) === " ") {
    w.decorations.push(hide.range(node.to, node.to + 1));
  }
  // A ticked item's text greys out and strikes through. `markdown.css` has described that
  // as the behaviour since the checkbox shipped and nothing has ever applied the class, so
  // a done task looked exactly like an undone one apart from the box — the fifth rule in
  // this codebase found to be stating a mechanism that never ran.
  if (done) {
    const line = w.doc.lineAt(node.from);
    if (node.to < line.to) {
      w.decorations.push(doneTaskText.range(node.to, line.to));
    }
  }
  return;
}

function listMark(node: SyntaxNodeRef, w: Walk): void {
  const lineNumber = w.doc.lineAt(node.from).number;
  const isActive = w.reveal.lines.has(lineNumber);
  // The literal indentation in front of the marker goes with it — indent comes from `pane-line-li-N`,
  // and rendering the spaces too put level two a space-width right (108). Only where that span is
  // whitespace: on `1. 1. three` the inner marker's "indentation" is the outer marker, there is one
  // marker slot, so the outer keeps it and the inner stays literal (135, 121).
  const lineStart = w.doc.lineAt(node.from);
  //
  // `>` counts as indentation and a list marker does not. A quote is a container rather
  // than a kind (decision 100), so `> - one` is one marker behind a bar and the bar is
  // hidden by `QuoteMark` anyway; a marker in front of a marker is the nesting above.
  if (node.from > lineStart.from) {
    if (!/^[ \t>]*$/.test(w.doc.sliceString(lineStart.from, node.from))) return;
    w.decorations.push(hide.range(lineStart.from, node.from));
  }

  const text = w.doc.sliceString(node.from, node.to);
  const ordered = /\d/.test(text);

  // A bullet's to-do shows the checkbox alone; a number stays, because it says *which* item (135).
  // The trailing space is part of the test: `- [ ]` at a line end is no task marker to the parser, and
  // hiding the `-` there hid it in favour of nothing (121).
  if (
    !ordered &&
    /^[ \t]*\[[ xX]\][ \t]/.test(w.doc.sliceString(node.to, Math.min(node.to + 6, w.doc.length)))
  ) {
    w.decorations.push(hide.range(node.from, node.to));
    w.hideSpaceAfter(node.to);
    return;
  }

  if (isActive) {
    // Through the space after it, so the box matches the rendered marker's — see rawListMark.
    const after = w.doc.sliceString(node.to, Math.min(node.to + 1, w.doc.length));
    w.decorations.push(rawListMark.range(node.from, node.to + (after === " " ? 1 : 0)));
  } else if (ordered) {
    // Its own class: a rendered number is content the reader sees, not muted syntax. Through the space
    // after it, so the rendered and raw boxes match for any digit count and item ten does not shift on
    // reveal (108). Load-bearing: dropping the space centres the digits and breaks both that and the
    // caret after a new item — the number sits ~2px left of centre on purpose (122).
    const gap = w.doc.sliceString(node.to, Math.min(node.to + 1, w.doc.length)) === " " ? 1 : 0;
    w.decorations.push(numberMark.range(node.from, node.to + gap));
  } else {
    w.decorations.push(
      Decoration.replace({ widget: new BulletWidget(listDepth(w.view, node.from)) }).range(
        node.from,
        node.to
      )
    );
    w.hideSpaceAfter(node.to);
  }
  return;
}

function marker(node: SyntaxNodeRef, w: Walk): void {
  const name = node.name;
  const lineNumber = w.doc.lineAt(node.from).number;
  const isActive = w.reveal.lines.has(lineNumber);
  const parentName = node.node.parent?.name;
  const insideImage = parentName === "Image";
  // An image hides none of itself, for the reason above: it is markdown Pane does not
  // interpret, so every character of it stays on screen.
  if (insideImage) return;
  // Inside an `Autolink` the URL is the content and the `<` `>` are the markers, so it
  // takes neither branch below: the construct's own mark already covers it. A bare URL
  // never reaches here — it was handled as an inline construct above.
  if (name === "URL" && parentName !== "Link") return;

  // A mark follows whatever it belongs to. Inside an inline construct that is the construct
  // — the `**` appear with the caret and stay hidden while it is elsewhere on the line. A
  // block's marks — a heading's hashes, a quote's `>`, a fence and its language — keep the
  // line rule, because they sit at the start of the line rather than inside the sentence,
  // and they are how you change what kind of block you are standing in.
  const owner = w.inlineRanges.find((r) => r.from <= node.from && r.to >= node.to);
  if (owner ? owner.revealed : isActive) {
    // Revealed, but muted, so the line reads as text rather than as punctuation.
    w.decorations.push(syntaxMark.range(node.from, node.to));
  } else if (node.to > node.from) {
    w.decorations.push(hide.range(node.from, node.to));
    // A quote's `>` takes its space with it, exactly as a list marker does — otherwise a
    // quoted line starts 3px right of its own continuation.
    if (name === "QuoteMark") w.hideSpaceAfter(node.to);
  }
}

/**
 * One handler per node name. A name that is not here draws nothing of its own — its text is just
 * text — and a `URL` is the one name in two sets: an inline construct on its own, and a marker inside
 * a link, which `inlineConstruct` decides.
 */
type Handler = (node: SyntaxNodeRef, w: Walk) => void;
const CONSTRUCTS: Record<string, Handler> = {
  HorizontalRule: horizontalRule,
  ...Object.fromEntries(Object.keys(BLOCK_LINE).map((name) => [name, blockLines])),
  ListItem: listItem,
  ...Object.fromEntries(Object.keys(INLINE_STYLE).map((name) => [name, inlineConstruct])),
  Escape: escape,
  TaskMarker: taskMarker,
  ListMark: listMark,
  ...Object.fromEntries([...MARKER_NODES].filter((name) => name !== "URL").map((name) => [name, marker])),
};

/** The pass over visible lines, for what has no node: blank lines, text-matched constructs, the gap above a block. */
function linePass(w: Walk): void {
  // Blank lines get a shorter line box, so the note has rendered markdown's rhythm while the newline
  // stays in the buffer (55). The caret's own blank line is exempt — the rule and its history are
  // `reveal.ts` (44, 89, 132).
  for (const { from, to } of w.view.visibleRanges) {
    const first = w.doc.lineAt(from).number;
    const last = w.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const line = w.doc.line(n);
      // Inside a fenced block a blank line is content with a background, and collapsing it would
      // put a notch in the block's left edge.
      //
      // An empty *document* is exempt as well, and not for rhythm: its one line carries the
      // placeholder, and an 8px box would leave "Start writing…" spilling out of the line it is
      // drawn in. An unfocused empty pane is exactly when that shows, because nothing is active.
      //
      const exempt = w.reveal.blankLineExempt(n);
      if (w.doc.length > 0 && line.length === 0 && !w.codeLines.has(n) && !exempt) {
        w.decorations.push(blankLine.range(line.from));
        continue;
      }

      // `==highlight==` and `<u>underline</u>`, which the parser does not know about (decision 61).
      // Same reveal rule as every other inline construct: markers show when the selection is inside
      // this one, and stay hidden when it is elsewhere on the line (decision 57).
      if (!w.codeLines.has(n)) {
        for (const construct of TEXT_CONSTRUCTS) {
          construct.pattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = construct.pattern.exec(line.text)) !== null) {
            const from = line.from + match.index;
            const to = from + match[0].length;
            if (insideCode(w.view, from + 1)) continue;

            const inner = { from: from + construct.open, to: to - construct.close };
            if (w.reveal.touches(from, to)) {
              w.decorations.push(syntaxMark.range(from, inner.from));
              w.decorations.push(syntaxMark.range(inner.to, to));
            } else {
              w.decorations.push(hide.range(from, inner.from));
              w.decorations.push(
                Decoration.mark({ class: construct.class }).range(inner.from, inner.to)
              );
              w.decorations.push(hide.range(inner.to, to));
            }
          }
        }
      }

      // The gap above a block the user did not separate with a blank line — decision 55. Only where
      // there is no blank line to do the job, so nothing the user typed is ever double-counted, and
      // never at the top of the document, where there is nothing to be separated from.
      if (n > 1 && w.doc.line(n - 1).length > 0 && w.blockStarts.has(n)) {
        w.decorations.push(gapLine.range(line.from));
      }
    }
  }
}

export function buildDecorations(view: EditorView, reveal: Reveal): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);

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

  /* The space after a marker goes with the marker: `ListMark` and `QuoteMark` exclude it, and rendered
   * it pushed the first line's text ~3px right of its own continuation (decisions 108, 122). */
  const hideSpaceAfter = (at: number) => {
    const line = doc.lineAt(at);
    let end = at;
    while (end < line.to && doc.sliceString(end, end + 1) === " ") end++;
    if (end > at) decorations.push(hide.range(at, end));
  };

  const w: Walk = { view, doc, reveal, decorations, inlineRanges, codeLines, blockStarts, hideSpaceAfter };

  // Only the visible ranges. A 3,000-word note must not be fully decorated to draw one screen —
  // that cost lands on every keystroke, and it is where these editors get slow.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        // `ListItem` as well as the leaf blocks, because a task item has no `Paragraph` inside it —
        // its text hangs directly off the item — so `- [ ] one` / `- [x] two` were the one kind of
        // list that got no separation while every other list did.
        if (LEAF_BLOCKS.has(name) || name === "ListItem") blockStarts.add(doc.lineAt(node.from).number);

        CONSTRUCTS[name]?.(node, w);
      },
    });
  }

  linePass(w);

  // Sorted on construction rather than fed through a RangeSetBuilder: the tree yields nodes in
  // document order, but an outer mark and an inner replace can share a start offset, and getting
  // their relative side wrong throws. Letting Decoration.set sort is cheap at note scale and cannot
  // be got subtly wrong.
  return Decoration.set(decorations, true);
}
