/*
 * The format bar — design frame 2b.
 *
 * Every button is a text edit. There is no rich-text model to toggle: wrapping a selection in `**`
 * inserts two pairs of asterisks into the document, exactly as typing them would. That is decision 5
 * holding at the UI layer — the buffer is the markdown, all the way up.
 *
 * The bar replaces the footer row rather than stacking below it (the pane's CSS does that), and its
 * active state is a pressed fill, never the accent.
 */

import { syntaxTree } from "@codemirror/language";

import { blocksIn, linesOf } from "./blocks";
import { describe } from "./tooltip";
import type { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

interface Button {
  label: string;
  title: string;
  className?: string;
  /** Wraps the selection, e.g. "**" for bold. */
  wrap?: string;
  /** Anything the two simple shapes above can't express. */
  custom?: (view: EditorView) => void;
  svg?: string;
  /**
   * Lezer node names that mean this button is on. Without these the pressed fill in `pane.css` has
   * nothing to key off and can never render — which is exactly what the design audit found.
   */
  active?: string[];
  /** Names that *cancel* `active` — see the bullet button, which a task would otherwise light. */
  inactiveWith?: string[];
  /**
   * The same, for the two constructs the parser has no node for (decision 61). Underline and
   * highlight were the only buttons on the bar that could never draw themselves pressed, which
   * made them the only two you could not tell the state of without reading the note.
   */
  activePair?: [string, string];
}

/**
 * One wrapper for every drawn icon in the pane's chrome, so the grid, the stroke and the terminals
 * are stated once instead of per icon.
 *
 * The icons are **Lucide** (ISC), inlined as path data rather than pulled in as a dependency — same
 * `<svg>` strings the hand-drawn ones were, from a set that was designed against itself. What they
 * buy is the thing hand-drawing could not: one 24-unit grid, one stroke weight, round terminals, and
 * optical sizing already done. The set before this had seven rendered sizes across the app and four
 * stroke weights on one bar, because every icon was authored on its own.
 *
 * `SIZE` is 14 and `STROKE` is 2.25 rather than Lucide's own 2, and both numbers are derived rather
 * than picked: 14px in the 26px button leaves exactly 6px a side (13 left it on a half-pixel), and
 * 2.25 user units on a 24-unit grid rendered at 14 is 1.31px on screen — the weight the bar was
 * already tuned to, and close enough to the letterforms' stems that a drawing sits beside a B
 * without reading heavier.
 *
 * Deliberately *not* applied to Bold, Italic, Strikethrough and Underline: those stay as type,
 * because each one is rendered in the effect it applies. The B is bold, the I is italic, the U is
 * underlined. No drawn glyph can do that, and it is worth more than a uniform visual language.
 */
const ICON_SIZE = 14;
const ICON_STROKE = 2.25;

export function icon(body: string, size = ICON_SIZE): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${body}</svg>`
  );
}

const SEPARATOR: unique symbol = Symbol("separator");

/*
 * The bar, in groups, and the groups are by **what the mark applies to** — which is the rule the
 * separators had never actually followed.
 *
 *   Heading · Bold · Italic · Strikethrough · Underline · Highlight   marks on characters
 *   Inline code · Code block · Link · Quote                           inline objects and containers
 *   Numbered · Bulleted · Task                                        lists
 *
 * Underline and Highlight used to sit in the second group, which made it a catch-all of six: two
 * character marks, two inline constructs and two block containers, sharing a run for no reason
 * anybody had written down. They are decision 61's pair and they are the same *kind* of thing as
 * bold and italic — a mark on a span of characters — so they belong beside them. Heading leads the
 * run rather than standing alone because a paragraph-style control at the head of the text-format
 * group is what every toolbar does, and it reads as "how this text looks" with the rest.
 */
const BUTTONS: (Button | typeof SEPARATOR)[] = [
  {
    label: "B",
    title: "Bold ⌘B",
    className: "format-bar__bold",
    wrap: "**",
    active: ["StrongEmphasis"],
  },
  { label: "I", title: "Italic ⌘I", className: "format-bar__italic", wrap: "*", active: ["Emphasis"] },
  {
    label: "S",
    title: "Strikethrough ⇧⌘S",
    className: "format-bar__strike",
    wrap: "~~",
    active: ["Strikethrough"],
  },
  {
    label: "U",
    title: "Underline ⌘U",
    className: "format-bar__underline",
    custom: (view: EditorView) => applyWrapPair(view, "<u>", "</u>"),
    activePair: ["<u>", "</u>"],
  },
  {
    label: "",
    title: "Highlight ⇧⌘M",
    custom: (view: EditorView) => applyWrap(view, "=="),
    activePair: ["==", "=="],
    svg: icon(`<path d="m9 11-6 6v3h9l3-3" /><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />`),
  },
  SEPARATOR,
  {
    label: "",
    title: "Inline code ⌘E",
    wrap: "`",
    active: ["InlineCode"],
    // The one letterform that had to go. `</>` set three characters in a 26px box and measured
    // 20.8×12.3 — 2.4× the width of the B beside it, and the widest thing on the bar. Unlike B, I,
    // S and U it was never a specimen of its own effect either: inline code is not spelled `</>`.
    svg: icon(`<path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" />`),
  },
  {
    label: "",
    title: "Code block ⌥⌘C",
    custom: applyCodeBlock,
    active: ["FencedCode"],
    svg: icon(`<path d="m10 9-3 3 3 3" /><path d="m14 15 3-3-3-3" /><rect x="3" y="3" width="18" height="18" rx="2" />`),
  },
  {
    label: "",
    title: "Link ⌘L",
    custom: applyLink,
    active: ["Link"],
    svg: icon(`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />`),
  },
  {
    label: "",
    title: "Quote ⇧⌘B",
    custom: applyQuote,
    active: ["Blockquote"],
    svg: icon(`<path d="M17 5H3" /><path d="M21 12H8" /><path d="M21 19H8" /><path d="M3 12v7" />`),
  },
  SEPARATOR,
  // Numbered before bulleted, matching the reference bar. Reads as an ordering of increasing
  // looseness — numbered, bulleted, then tasks — rather than the arbitrary pair it was.
  {
    label: "",
    title: "Numbered list ⇧⌘7",
    custom: applyOrderedList,
    active: ["OrderedList"],
    svg: icon(`<path d="M11 5h10" /><path d="M11 12h10" /><path d="M11 19h10" /><path d="M4 4h1v5" /><path d="M4 9h2" /><path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />`),
  },
  {
    label: "",
    title: "Bulleted list ⇧⌘8",
    custom: applyBulletList,
    active: ["BulletList"],
    // A task is a bullet in the tree — `BulletList` > `ListItem` > `Task` — so this lit alongside
    // Task list on every checkbox, which reads as the line being two kinds of list at once. The
    // three are one control with three values, so the most specific wins.
    inactiveWith: ["Task"],
    svg: icon(`<path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" />`),
  },
  {
    label: "",
    title: "Task list ⇧⌘9",
    custom: applyTaskList,
    active: ["Task"],
    svg: icon(`<path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" />`),
  },
];

/**
 * `[label](url)`, which is one of the two things frame 2b draws that had no implementation.
 *
 * With a selection, the selected text becomes the label and the caret lands in the empty target,
 * because the text is the part you already have and the URL is the part you are about to paste.
 * Without one, both halves are empty and the caret goes in the label.
 */
function applyLink(view: EditorView): void {
  const state = view.state;
  const { from, to } = state.selection.main;

  // No selection: an empty link with the caret in the label.
  if (from === to) {
    view.dispatch({ changes: { from, insert: "[]()" }, selection: { anchor: from + 1 } });
    view.focus();
    return;
  }

  // Already links? Take them off — `[text](url)` back to `text`, because every other button on
  // this bar toggles and this one only ever added.
  const all = spansPerBlock(state, from, to);
  const links = all.map((span) => constructAround(state, span, "[", "Link"));
  if (all.length > 0 && links.every(Boolean)) {
    const changes = links.flatMap((link) => {
      const text = state.doc.sliceString(link!.from, link!.to);
      return [
        { from: link!.from, to: link!.from + 1, insert: "" },
        { from: link!.from + text.lastIndexOf("]("), to: link!.to, insert: "" },
      ];
    });
    const set = state.changes(changes);
    view.dispatch({
      changes: set,
      selection: selectionAround(set, links.map((link) => link!)),
      userEvent: "input",
    });
    view.focus();
    return;
  }

  // One link per block. Across two paragraphs the old version wrote a single `[rest` … `rest]()`
  // spanning the blank line, which is not a link to any parser — the same fault bold had, in the
  // one command that never moved onto the block primitive.
  const spans = spansPerBlock(state, from, to);
  if (spans.length === 0) return;

  const changes = spans.flatMap((span) => [
    { from: span.from, insert: "[" },
    { from: span.to, insert: "]()" },
  ]);
  const set = state.changes(changes);
  // The caret lands in the first link's empty target, because the text is the half you have and
  // the URL is the half you are about to paste.
  const target = set.mapPos(spans[0]!.to, 1) - 1;
  view.dispatch({ changes: set, selection: { anchor: target }, userEvent: "input" });
  view.focus();
}

/**
 * Which formatting the caret is currently inside.
 *
 * Read from the syntax tree rather than from the raw text, so it agrees with what the live preview
 * is rendering — the two would drift immediately if one parsed and the other pattern-matched.
 */
function activeMarks(state: EditorState): Set<string> {
  const names = new Set<string>();

  // Bias to the left so that having just typed the closing `**` still counts as bold: the caret sits
  // after the construct, and resolving right would land outside it.
  //
  // A cursor rather than a node chain — `TreeCursor.parent()` walks up in place, which avoids naming
  // the node type and the casts that came with it.
  const cursor = syntaxTree(state).cursorAt(state.selection.main.head, -1);
  // Only the innermost list counts. A bullet nested inside a numbered list has both on its ancestor
  // chain, so both buttons lit — true about the caret, and not what the bar is answering. The bar
  // says what *this line* is, and a line has exactly one kind of marker.
  let listSeen = false;
  do {
    const isList = cursor.name === "BulletList" || cursor.name === "OrderedList";
    if (isList) {
      if (listSeen) continue;
      listSeen = true;
    }
    names.add(cursor.name);
  } while (cursor.parent());

  return names;
}

/**
 * The parser node each marker produces, where the parser has one.
 *
 * Used to decide whether a press means "wrap" or "unwrap", from the same walk `activeMarks` uses to
 * decide whether the button looks pressed — so the two can never disagree. Matching on the text
 * instead would get `*` wrong the moment the caret is inside `**bold**`, where the asterisks it
 * would find belong to the construct one level up.
 */
const WRAP_NODES: Record<string, string> = {
  "**": "StrongEmphasis",
  "*": "Emphasis",
  "~~": "Strikethrough",
  "`": "InlineCode",
};

/** The construct of this kind the caret is inside, if any. Same bias as `activeMarks`. */
function enclosingNode(
  state: EditorState,
  name: string
): { from: number; to: number } | null {
  const cursor = syntaxTree(state).cursorAt(state.selection.main.head, -1);
  do {
    if (cursor.name === name) return { from: cursor.from, to: cursor.to };
  } while (cursor.parent());
  return null;
}

/**
 * The construct of this kind wrapping a *span*, for the per-block toggle.
 *
 * `enclosingNode` asks about the caret, which is one position — right for a caret and wrong for a
 * selection over three paragraphs, where it answers about whichever block the head happens to be
 * in. Pressing ⌘B twice on such a selection un-bolded exactly one of them and left the rest bold.
 */
function constructAround(
  state: EditorState,
  span: { from: number; to: number },
  open: string,
  nodeName: string | undefined
): { from: number; to: number } | null {
  if (!nodeName) return pairAround(state, span, open, open === "<u>" ? "</u>" : open);

  let node = syntaxTree(state).resolveInner(span.from, 1);
  while (node.parent) {
    if (node.name === nodeName && node.from <= span.from && node.to >= span.to) {
      return { from: node.from, to: node.to };
    }
    node = node.parent;
  }
  return null;
}

/**
 * The same question for the two constructs the parser has no node for — `==highlight==` and
 * `<u>underline</u>` (decision 61). Matched on the caret's line, and only when the selection sits
 * *inside* the pair rather than spanning it.
 */
function enclosingPair(
  state: EditorState,
  open: string,
  close: string
): { from: number; to: number } | null {
  return pairAround(state, state.selection.main, open, close);
}

function pairAround(
  state: EditorState,
  range: { from: number; to: number },
  open: string,
  close: string
): { from: number; to: number } | null {
  // The span may *be* the construct rather than sit inside it — which is exactly what the mapped
  // selection looks like after one press, so without this a second press wrapped it again.
  const text = state.doc.sliceString(range.from, range.to);
  if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
    return { from: range.from, to: range.to };
  }

  const line = state.doc.lineAt(range.from);
  const head = range.from - line.from;
  const tail = range.to - line.from;

  // Containment, matching what the tree path tests for the constructs that have a node: the
  // construct has to *contain* the span, not sit strictly outside it. Requiring the span to start
  // after the opening delimiter was stricter than bold's rule, so a selection that happened to
  // include a marker — which is what a selection looks like once it has been wrapped once — found
  // nothing and wrapped again.
  const start = line.text.lastIndexOf(open, head);
  if (start === -1 || start > head) return null;
  const end = line.text.indexOf(close, start + open.length);
  if (end === -1 || end + close.length < tail) return null;

  return { from: line.from + start, to: line.from + end + close.length };
}

/**
 * Narrows a range to the text inside it, ignoring whitespace at either end.
 *
 * A delimiter next to a space is not a delimiter: `**select **` is not bold to CommonMark, or to
 * Obsidian, or to anything else that will ever open the file — it renders as four literal
 * asterisks. Double-clicking a word and dragging one character too far is enough to produce it, so
 * the button is not allowed to write it.
 */
function trimmed(state: EditorState, from: number, to: number): { from: number; to: number } {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(state.doc.sliceString(start, start + 1))) start++;
  while (end > start && /\s/.test(state.doc.sliceString(end - 1, end))) end--;
  return { from: start, to: end };
}

/** Removes a construct's delimiters, leaving the text and selecting it. */
function unwrap(view: EditorView, node: { from: number; to: number }, open: number, close: number): void {
  view.dispatch({
    changes: [
      { from: node.from, to: node.from + open },
      { from: node.to - close, to: node.to },
    ],
    selection: { anchor: node.from, head: node.to - open - close },
    userEvent: "input",
  });
  view.focus();
}

/**
 * The selection, put back around the **text** after markers were placed around it.
 *
 * Not `selection.map(changes)`, which was the bug. That maps both ends the same way and an
 * insertion sitting exactly on an end pushes that end past it — and worse, ⌘A selects a block
 * *including its trailing newline*, so the closing marker was inserted strictly inside the
 * selection and no mapping bias could have saved it. Wrapping `word` left the selection covering
 * `word**\n`.
 *
 * Invisible until a *second, different* button was pressed: ⌘B then ⌘E wrapped that selection and
 * wrote ``**`word**` ``, four literal characters to any parser — decision 64's own rule broken by
 * the selection rather than by the command. The matrix missed it because it presses each command
 * twice and unwrapping reads the syntax tree, so the too-wide selection was still inside the
 * construct and the round trip passed while the state in between was wrong.
 *
 * So the selection is rebuilt from the spans that were actually wrapped rather than mapped from
 * whatever the user had: the first span's start biased **forward** past its opening marker, the
 * last span's end biased **backward** before its closing one.
 */
function selectionAround(
  set: ChangeSet,
  spans: { from: number; to: number }[]
): { anchor: number; head: number } {
  const first = spans[0]!;
  const last = spans[spans.length - 1]!;
  return { anchor: set.mapPos(first.from, 1), head: set.mapPos(last.to, -1) };
}

/**
 * Wraps the selection, or unwraps the construct the caret is already in.
 *
 * The unwrap half used to test whether the *selection text* began and ended with the marker, which
 * is true only if the markers happen to be selected. So selecting a word inside `**bold**` and
 * pressing ⌘B added a second pair — `***bold***` — while the button sat there drawn as pressed,
 * because the pressed state was read from the syntax tree and the toggle was read from a string.
 * Both read the tree now, so a button that says it is on turns off.
 */
function applyWrap(view: EditorView, marker: string): void {
  toggleWrap(view, marker, marker, WRAP_NODES[marker]);
}

/**
 * Adds a construct, or takes it off — over one caret or over every span a selection covers.
 *
 * One function for all six inline constructs, because they had drifted into three half-paths with
 * a different bug in each: `**` toggled off only the block the caret happened to be in, `<u>` and
 * `==` stopped toggling off at all once a selection spanned more than one line, and only `**` knew
 * about blocks. Off happens only when *every* span is already wrapped, so a mixed selection
 * finishes the job rather than undoing half of it — the rule the list buttons already follow.
 */
function toggleWrap(
  view: EditorView,
  open: string,
  close: string,
  nodeName: string | undefined
): void {
  const state = view.state;
  const { from, to } = state.selection.main;

  // A caret is one position, so one construct: unwrap the one it is in, or open an empty pair.
  if (from === to) {
    const inside = nodeName ? enclosingNode(state, nodeName) : enclosingPair(state, open, close);
    // Length rather than the marker itself: `_italic_` and `*italic*` are one node and both
    // delimiters are one character, so removing by length handles the spelling the user chose.
    if (inside) unwrap(view, inside, open.length, close.length);
    else wrapPerBlock(view, open, close, !nodeName);
    return;
  }

  // Constructs the parser knows span a soft break happily, so they go per block. `==` and `<u>`
  // are matched on a line's text (decision 61), so markup spanning a newline would never render —
  // they go per line.
  const spans = (nodeName ? spansPerBlock : spansPerLine)(state, from, to);
  if (spans.length === 0) return;

  const wrapping = spans.map((span) => constructAround(state, span, open, nodeName));
  if (!wrapping.every(Boolean)) {
    wrapPerBlock(view, open, close, !nodeName);
    return;
  }

  const changes = wrapping.flatMap((found) => [
    { from: found!.from, to: found!.from + open.length, insert: "" },
    { from: found!.to - close.length, to: found!.to, insert: "" },
  ]);
  const set = state.changes(changes);
  view.dispatch({
    changes: set,
    selection: selectionAround(set, wrapping.map((found) => found!)),
    userEvent: "input",
  });
  view.focus();
}

/**
 * The part of each **line** a selection covers, for the two constructs the parser has no node for.
 *
 * `==highlight==` and `<u>…</u>` are matched on the line's text (decision 61) — live preview's
 * patterns are `[^=\n]` and a non-dotall `.`, both of which stop at a newline. So wrapping a ⇧⏎
 * pair as one construct wrote markup that could never render: the text simply lost its styling and
 * nothing said why. Per line, they render.
 */
function spansPerLine(
  state: EditorState,
  from: number,
  to: number
): { from: number; to: number }[] {
  const doc = state.doc;
  const spans = [];
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    if (line.text.trim() === "") continue;
    const span = trimmed(state, Math.max(from, line.from), Math.min(to, line.to));
    if (span.from < span.to) spans.push(span);
  }
  return spans;
}

/** The part of each block a selection actually covers, trimmed, with the empty ones dropped. */
function spansPerBlock(
  state: EditorState,
  from: number,
  to: number
): { from: number; to: number }[] {
  return blocksIn(state, from, to)
    .map((block) => trimmed(state, Math.max(from, block.from), Math.min(to, block.to)))
    .filter((span) => span.from < span.to);
}

/**
 * Wraps the selection **once per block it covers**, not once across the whole range.
 *
 * `**` over two paragraphs used to produce `**rest` … `rest**`, which is not emphasis to any
 * parser — a delimiter run cannot span a blank line — so the text stopped rendering and nothing
 * explained why. Per block it produces `**rest**` and `**rest**`, which is what the reference does
 * and what the user meant.
 *
 * A paragraph broken with ⇧⏎ is still *one* block, so a selection across those two lines gets one
 * pair of markers spanning the newline — correct, because a soft break inside a paragraph is not a
 * block boundary and emphasis crosses it happily.
 */
function wrapPerBlock(
  view: EditorView,
  open: string,
  close: string,
  perLine = false
): void {
  const state = view.state;
  const { from, to } = state.selection.main;

  // No selection: an empty pair at the caret, ready to type between.
  if (from === to) {
    view.dispatch({
      changes: { from, insert: open + close },
      selection: { anchor: from + open.length },
      userEvent: "input",
    });
    view.focus();
    return;
  }

  const wrapped = (perLine ? spansPerLine : spansPerBlock)(state, from, to);
  const changes: { from: number; to?: number; insert: string }[] = [];
  for (const span of wrapped) {
    changes.push({ from: span.from, insert: open });
    changes.push({ from: span.to, insert: close });
  }
  if (changes.length === 0) return;

  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: selectionAround(set, wrapped), userEvent: "input" });
  view.focus();
}

/**
 * Wraps the selection in a pair that is not the same at both ends — `<u>` … `</u>`.
 *
 * `applyWrap` above takes one marker and uses it twice, which every markdown construct but this one
 * allows. Toggling off is the same test in two halves: text already wrapped in the pair loses it.
 */
function applyWrapPair(view: EditorView, open: string, close: string): void {
  toggleWrap(view, open, close, undefined);
}

/**
 * The block commands, defined once because they are pressed two ways.
 *
 * The format bar's buttons and the keyboard shortcuts used to be **two implementations of the same
 * command**, each passing its own literals to `applyBlockMarker`. So fixing the buttons left ⇧⌘7,
 * ⇧⌘8 and ⇧⌘9 doing the old thing, and the matrix — which presses buttons — passed the whole time.
 * That is decision 84 in a new costume: a suite that covers what you built is not one that covers
 * what people do, and people press the key.
 *
 * **Function declarations, not `const` arrows.** The button table is a module-scope array built at
 * import time, so an arrow declared further down is still in its temporal dead zone when the table
 * is constructed — which took out Quote, Bulleted list and Task list entirely, and the matrix said
 * so in fifteen assertions at once.
 */
/** A leading `1. ` or `1) `, which is what "already an ordered list" means. */
const ORDERED_MARKER = /^(\d+)[.)]\s/;

/** A leading `- [ ] ` or `- [x] `. Tested before `BULLET_MARKER`, which it would otherwise match. */
const TASK_MARKER = /^[-*+]\s\[[ xX]\]\s/;

/**
 * A bullet that is **not** a task.
 *
 * The negative lookahead is load-bearing rather than tidy. Without it, pressing Bulleted list on
 * `- [ ] Hi` matched the leading `- ` and "removed" it, leaving `[ ] Hi` — not a task, not a bullet,
 * not a list at all, and the only one of these faults that destroyed structure rather than doubling
 * it.
 */
const BULLET_MARKER = /^[-*+]\s(?!\[[ xX]\]\s)/;

/**
 * Any list marker of any kind, which is what the three list buttons *replace* rather than stack on.
 *
 * The three are one control with three values — a line is a bullet, or numbered, or a task, and
 * never two of those at once. Every command here used to test only for **its own** marker, so a
 * marker of a different kind was invisible to it and the new one went in front: `1. Hi` + Bulleted
 * gave `- 1. Hi`, `- Hi` + Numbered gave `1. - Hi`, and `1. Hi` + Task gave `- [ ] 1. Hi`. Each of
 * those is a list item whose *text* begins with what looks like a marker, so the pane drew both and
 * the format bar lit both buttons — which is how it was reported, as the bullet button looking
 * pressed on a numbered list. The button was telling the truth about a document the commands had
 * corrupted.
 *
 * Task first: `- [ ] ` starts with a bullet, so testing bullets first would match half of it.
 *
 * Blockquote deliberately does not use this. `> - a` is a real thing to want and CommonMark agrees;
 * a quote is a container, and these three are kinds of the same leaf.
 */
const ANY_LIST_MARKER = new RegExp(
  `(?:${TASK_MARKER.source.slice(1)}|${BULLET_MARKER.source.slice(1)}|${ORDERED_MARKER.source.slice(1)})`
);
const ANY_LIST_MARKER_AT_START = new RegExp(`^${ANY_LIST_MARKER.source}`);

/** The leading whitespace of a line, which every marker sits *after* rather than at column zero. */
function indentOf(text: string): number {
  return /^[ \t]*/.exec(text)![0].length;
}

/**
 * Puts a marker on **each block** the selection covers, and on nothing else.
 *
 * This replaced a per-*line* prefix, which was wrong three ways at once and all three were visible
 * in one screenshot: blank lines between paragraphs became empty list items, a paragraph broken
 * with ⇧⏎ became two items rather than one, and an ordered list wrote "1." on every line because
 * the prefix was a constant string.
 *
 * One marker per block fixes all three. `blocksIn` skips blank lines by construction — they belong
 * to no block — and a soft-wrapped paragraph is one block, so it takes one marker with its
 * continuation lines indented to sit under the text rather than under the marker.
 *
 * @param markerFor  the marker for the n-th block, given its indent so an ordered list can count
 *                   each nesting level separately.
 * @param existing   what already counts as this marker, for the toggle-off test.
 * @param replaces   what a *different* kind of the same thing looks like, which this one takes the
 *                   place of rather than sitting in front of.
 */
function applyBlockMarker(
  view: EditorView,
  markerFor: (index: number, indent: number) => string,
  existing: RegExp,
  replaces?: RegExp
): void {
  const state = view.state;
  const blocks = blocksIn(state, state.selection.main.from, state.selection.main.to);
  if (blocks.length === 0) return;

  const doc = state.doc;
  // Everything is measured after the leading whitespace, not at column zero. A nested item is
  // indented — `   1. a` — so a marker anchored at `^` matched nothing on it, and the command
  // cheerfully wrote its own marker in front of the indent: `-    1. a`, which is a top-level
  // bullet whose text happens to start with spaces. Every list in the report was nested, which is
  // why this arrived alongside the stacking rather than after it.
  const markerStart = (line: { from: number; text: string }) => line.from + indentOf(line.text);
  const body = (text: string) => text.slice(indentOf(text));

  // Off only when every block already carries **this** marker — on a mixed selection the button
  // should finish the job rather than strip the markers from half of it. A selection of a bullet
  // and a numbered item is mixed in exactly this sense, so Bulleted converts the numbered one.
  const removing = blocks.every((block) => existing.test(body(doc.lineAt(block.from).text)));

  const changes: { from: number; to: number; insert: string }[] = [];

  blocks.forEach((block, index) => {
    const lines = linesOf(state, block);
    const first = lines[0]!;
    const text = body(first.text);
    const own = existing.exec(text)?.[0].length ?? 0;
    // Going on, a marker of another kind is *replaced*; coming off, only our own is taken, so a
    // press that removes cannot also eat something it did not put there.
    const had = removing ? own : Math.max(own, replaces?.exec(text)?.[0].length ?? 0);
    const insert = removing ? "" : markerFor(index, indentOf(first.text));
    const start = markerStart(first);

    changes.push({ from: start, to: start + had, insert });

    // Continuation lines follow the marker in or out, so the text stays aligned under itself.
    for (const line of lines.slice(1)) {
      const indent = /^ */.exec(line.text)![0].length;
      if (removing) {
        const drop = Math.min(indent, had);
        if (drop > 0) changes.push({ from: line.from, to: line.from + drop, insert: "" });
      }
      // No literal indent on the way in. Spaces in a proportional font are ~8px where the list's
      // own indent is 26 (decision 55's lesson), so they misaligned rather than aligned — live
      // preview indents the continuation line instead, which is where every other list indent
      // comes from. CommonMark reads an unindented continuation as part of the item regardless.
    }
  });

  const set = state.changes(changes);
  view.dispatch({ changes: set, selection: state.selection.map(set, 1), userEvent: "input" });
  view.focus();
}

/**
 * The numbered list, which numbers — and continues from a list already above it.
 *
 * It used to go through the line prefix with a constant `"1. "`, so three selected lines became
 * "1." three times: legal CommonMark, and a list that cannot count in an editor which draws the
 * literal number the buffer holds rather than rendering one.
 */
function applyOrderedList(view: EditorView): void {
  const state = view.state;
  const blocks = blocksIn(state, state.selection.main.from, state.selection.main.to);
  if (blocks.length === 0) return;

  // Look past the blank line that separates a paragraph from the list above it — otherwise
  // extending a list always restarts at one, because the line directly above is never the list.
  //
  // Only a line at the **same indent** counts. A nested list is a different list, so continuing
  // from its parent would number a new top-level item after the deepest number above it — and
  // continuing from a *child* would be worse still.
  const firstLine = state.doc.lineAt(blocks[0]!.from);
  const depth = indentOf(firstLine.text);
  let start = 1;
  for (let n = firstLine.number - 1; n >= 1; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") continue;
    const indent = indentOf(text);
    if (indent > depth) continue;
    if (indent === depth) {
      const previous = ORDERED_MARKER.exec(text.slice(indent));
      if (previous) start = Number(previous[1]) + 1;
    }
    break;
  }

  // Each nesting level counts for itself.
  //
  // A flat `start + index` across every block in the selection numbered straight through the
  // indents — `1. Hi`, `2. A`, `   3. a`, `   4. b` — and the renumbering filter then left the
  // nested pair alone, correctly, because decision 85 keeps a run's first number when the author
  // chose it. It could not tell that nobody had.
  //
  // A deeper level restarts at 1, and going back out resets it, which is what a sublist is.
  const counters = new Map<number, number>();
  applyBlockMarker(
    view,
    (_index, indent) => {
      for (const level of [...counters.keys()]) if (level > indent) counters.delete(level);
      const next = (counters.get(indent) ?? (indent === depth ? start : 1) - 1) + 1;
      counters.set(indent, next);
      return `${next}. `;
    },
    ORDERED_MARKER,
    ANY_LIST_MARKER_AT_START
  );
}

/** The three list kinds and the quote, each written once. See the note above `ORDERED_MARKER`. */
function applyBulletList(view: EditorView): void {
  applyBlockMarker(view, () => "- ", BULLET_MARKER, ANY_LIST_MARKER_AT_START);
}

function applyTaskList(view: EditorView): void {
  applyBlockMarker(view, () => "- [ ] ", TASK_MARKER, ANY_LIST_MARKER_AT_START);
}

/** No `replaces`: `> - a` is a real thing to want, so a quote stacks where a list kind replaces. */
function applyQuote(view: EditorView): void {
  applyBlockMarker(view, () => "> ", /^>\s?/);
}

/**
 * Wraps the selected lines in a fenced code block, or opens an empty one.
 *
 * Whole lines, never part of one: a fence is only a fence at the start of a line, so wrapping a
 * selection mid-sentence would write three backticks into the middle of a paragraph and render as
 * literal text. With no selection it opens an empty block and puts the caret inside it, which is
 * what the button is for most of the time.
 */
function applyCodeBlock(view: EditorView): void {
  // Inside one already: take the fences off rather than wrapping the block in a second block,
  // which is what every other button on this bar now does when it is drawn pressed.
  const fenced = enclosingNode(view.state, "FencedCode");
  if (fenced) {
    const doc = view.state.doc;
    const first = doc.lineAt(fenced.from);
    const last = doc.lineAt(Math.min(fenced.to, doc.length));
    view.dispatch({
      changes: [
        { from: first.from, to: Math.min(first.to + 1, doc.length) },
        { from: Math.max(last.from - 1, first.from), to: last.to },
      ],
      userEvent: "input",
    });
    view.focus();
    return;
  }

  const { from, to } = view.state.selection.main;
  const first = view.state.doc.lineAt(from);
  const last = view.state.doc.lineAt(to);
  const body = view.state.doc.sliceString(first.from, last.to);

  view.dispatch({
    changes: { from: first.from, to: last.to, insert: "```\n" + body + "\n```" },
    // Inside the block: past the opening fence and its newline.
    selection: { anchor: first.from + 4 + body.length },
    scrollIntoView: true,
  });
}

/**
 * Sets, changes or clears the heading level of the caret's line.
 *
 * Not `applyLinePrefix("# ")`: that toggles one exact string, so going from H1 to H2 produced
 * `# ## ` rather than a heading. Any existing marker is stripped first, and asking for the level a
 * line already has clears it — which is what a pressed button should do when you press it again.
 */
function setHeading(view: EditorView, level: number): void {
  const state = view.state;
  const doc = state.doc;
  // Per block, so the blank line between two paragraphs does not become `# ` — which is what
  // iterating lines did, and it is not even a heading, just a hash on an empty line.
  const blocks = blocksIn(state, state.selection.main.from, state.selection.main.to);
  const changes = [];

  for (const block of blocks) {
    const line = doc.lineAt(block.from);
    const existing = /^(#{1,6})\s+/.exec(line.text);
    const already = existing?.[1]?.length === level;
    const insert = already ? "" : "#".repeat(level) + " ";
    changes.push({ from: line.from, to: line.from + (existing?.[0]?.length ?? 0), insert });
  }

  const set = view.state.changes(changes);
  view.dispatch({ changes: set, selection: view.state.selection.map(set, 1) });
  view.focus();
}

export { setHeading };

/**
 * The markdown formatting keys — and they are deliberately **not** rebindable.
 *
 * Pane's shortcuts come in two tiers and this is the second one. Tier 1 is Pane's own furniture —
 * ⌘K, ⌘P, ⌘N, ⌘, and the rest of the ⌘K rows — which is a matter of taste and machine, so it lives in
 * `Settings.shortcutActions`, appears in the Shortcuts tab, and has a Restore Defaults button for
 * when somebody paints themselves into a corner. Tier 2 is *markdown convention*: ⌘B has meant bold
 * in every editor anyone has used for thirty years. Offering to rebind it invites a user to break
 * something no one wants broken, and costs a row in the tab to do it.
 *
 * The keys match Raycast's Format palette exactly, for decision 39's reason: the person switching
 * already has them in their fingers. ⌥⌘1/2/3 are here too, so every fixed markdown key has one home
 * rather than being split between this file and the editor's keymap.
 *
 * Each entry stays a plain text edit — decision 5 holds at the keyboard as it does at the format bar.
 */
export const MARKDOWN_FORMAT_KEYS: {
  key: string;
  /** What the Shortcuts tab prints beside it, since these are shown but not recorded. */
  label: string;
  run: (view: EditorView) => boolean;
}[] = [
  { key: "Mod-b", label: "Bold", run: (v) => (applyWrap(v, "**"), true) },
  { key: "Mod-i", label: "Italic", run: (v) => (applyWrap(v, "*"), true) },
  { key: "Shift-Mod-s", label: "Strikethrough", run: (v) => (applyWrap(v, "~~"), true) },
  { key: "Mod-e", label: "Inline code", run: (v) => (applyWrap(v, "`"), true) },
  { key: "Mod-l", label: "Link", run: (v) => (applyLink(v), true) },
  { key: "Mod-u", label: "Underline", run: (v) => (applyWrapPair(v, "<u>", "</u>"), true) },
  { key: "Shift-Mod-m", label: "Highlight", run: (v) => (applyWrap(v, "=="), true) },
  { key: "Alt-Mod-c", label: "Code block", run: (v) => (applyCodeBlock(v), true) },
  { key: "Shift-Mod-b", label: "Quote", run: (v) => (applyQuote(v), true) },
  { key: "Shift-Mod-7", label: "Numbered list", run: (v) => (applyOrderedList(v), true) },
  { key: "Shift-Mod-8", label: "Bulleted list", run: (v) => (applyBulletList(v), true) },
  { key: "Shift-Mod-9", label: "Task list", run: (v) => (applyTaskList(v), true) },
  { key: "Alt-Mod-1", label: "Heading 1", run: (v) => (setHeading(v, 1), true) },
  { key: "Alt-Mod-2", label: "Heading 2", run: (v) => (setHeading(v, 2), true) },
  { key: "Alt-Mod-3", label: "Heading 3", run: (v) => (setHeading(v, 3), true) },
];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The heading level at the caret, or null when the line is not a heading. */
function currentHeadingLevel(view: EditorView): number | null {
  const marks = activeMarks(view.state);
  for (const level of [1, 2, 3, 4, 5, 6]) {
    if (marks.has(`ATXHeading${level}`)) return level;
  }
  return null;
}

export function mountFormatBar(
  root: HTMLElement,
  view: EditorView,
  onClose: () => void,
  onHeadingMenu: (buttonRect: Rect, currentLevel: number | null) => void
): { refresh: () => void } {
  root.innerHTML = "";

  /** Every button that declares an active state, so `refresh` is a walk rather than a re-query. */
  const stateful: {
    element: HTMLButtonElement;
    names: string[];
    unless: string[];
    pair?: [string, string];
  }[] = [];

  // The heading control is a dropdown, as the design draws it: H1, H2 and H3 with their shortcuts.
  // A single "H" button could only ever mean H1, which makes the other two levels undiscoverable.
  const heading = document.createElement("button");
  heading.className = "format-bar__heading";
  describe(heading, "Heading");
  heading.setAttribute("aria-haspopup", "true");
  heading.innerHTML = `H<svg class="format-bar__chevron" width="7" height="5" viewBox="0 0 7 5" aria-hidden="true"><path d="M0.5 1.2 3.5 4 6.5 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  root.appendChild(heading);
  stateful.push({
    element: heading,
    names: ["ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6"],
    unless: [],
  });

  // The menu itself is native, opened by Swift.
  //
  // It was a DOM popup, and a DOM popup cannot go where this one needs to go: the format bar sits at
  // the bottom of the pane, so the list has to hang *below* it — past the window's own edge. Anything
  // rendered in the web view is clipped to the window, so opening upward over the note was the only
  // option and it covered the text you were about to format.
  //
  // An NSMenu also brings its dismissal rules with it, which is the other half of the problem: it
  // closes on an outside click, on Escape, when the app deactivates, and when the pane is dismissed —
  // all of it handled by AppKit rather than by a pile of listeners here that would each have to be
  // remembered.
  heading.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const rect = heading.getBoundingClientRect();
    onHeadingMenu(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      currentHeadingLevel(view)
    );
  });

  for (const item of BUTTONS) {
    if (item === SEPARATOR) {
      const rule = document.createElement("span");
      rule.className = "format-bar__separator";
      root.appendChild(rule);
      continue;
    }

    const button = document.createElement("button");
    if (item.className) button.className = item.className;
    button.setAttribute("aria-label", item.title);
    describe(button, item.title);
    if (item.svg) button.innerHTML = item.svg;
    else button.textContent = item.label;

    button.addEventListener("mousedown", (event) => {
      // mousedown, not click, and prevented: the editor must never lose the selection the button is
      // about to act on.
      event.preventDefault();
      if (item.custom) item.custom(view);
      else if (item.wrap) applyWrap(view, item.wrap);
    });

    if (item.active || item.activePair) {
      stateful.push({
        element: button,
        names: item.active ?? [],
        unless: item.inactiveWith ?? [],
        pair: item.activePair,
      });
    }
    root.appendChild(button);
  }

  const spacer = document.createElement("span");
  spacer.className = "format-bar__spacer";
  root.appendChild(spacer);

  const rule = document.createElement("span");
  rule.className = "format-bar__separator";
  root.appendChild(rule);

  const close = document.createElement("button");
  close.className = "format-bar__close";
  describe(close, "Close ⌥⌘,");
  close.setAttribute("aria-label", "Close formatting bar");
  // A filled disc rather than a bare glyph — it reads as "dismiss this bar" rather than as one more
  // formatting button that happens to look like an ✕.
  close.innerHTML = `<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.25" fill="currentColor" opacity="0.16"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  close.addEventListener("mousedown", (event) => {
    event.preventDefault();
    onClose();
    view.focus();
  });
  root.appendChild(close);

  return {
    refresh() {
      // Skipped while the bar is hidden: this runs on every selection change, and parsing the tree
      // to style something nobody is looking at is exactly the kind of cost that shows up as a
      // stutter while typing.
      if (!root.offsetParent) return;
      const marks = activeMarks(view.state);
      for (const { element, names, unless, pair } of stateful) {
        const on =
          !unless.some((n) => marks.has(n)) &&
          (names.some((n) => marks.has(n)) ||
            (pair ? enclosingPair(view.state, pair[0], pair[1]) !== null : false));
        element.setAttribute("aria-pressed", String(on));
      }
    },
  };
}
