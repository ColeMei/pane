/*
 * Tab and ⇧Tab inside a list.
 *
 * These were `indentWithTab` — CodeMirror's generic indent, which adds one `indentUnit` (two
 * spaces) to the line whatever the line happens to be. In markdown that is not an indent, it is a
 * guess, and it was right by coincidence for exactly one case:
 *
 *     - alpha        ⏎ ⇥ beta        - alpha
 *       - beta       →               ··- beta      ✓ a bullet's content starts at column 2
 *
 *     1. alpha       ⏎ ⇥ beta        1. alpha
 *       2. beta      →               ··2. beta     ✗ a number's content starts at column 3
 *
 * The second one is not a nested list. CommonMark needs a child indented to the **parent's content
 * column**, and two spaces under `1. ` falls short of three — so every markdown tool, pandoc
 * included, reads those two lines as one flat list with two items, and so does Pane. The keystroke
 * did nothing except add junk whitespace and confuse the renumbering filter, which then counted
 * straight through the levels: 1., 2., 3., 4. where the writer meant 1., 1., 2., 2.
 *
 * So indentation is computed from the list rather than from a constant. Tab moves an item to the
 * content column of the sibling above it; ⇧Tab moves it back to its parent's column. Both carry
 * everything nested underneath along with them, because an item and its children are one thing to
 * everyone except the buffer.
 */

import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** `   1. ` — the indent, the marker, and the space between the marker and the text. */
const MARKER = /^([ \t]*)((?:[-*+]|\d+[.)]))([ \t]+)/;

interface Item {
  /** Line numbers, inclusive: the item's own lines and everything nested under it. */
  first: number;
  last: number;
  /** Columns. `indent` is where the marker starts; `content` is where the text starts. */
  indent: number;
  content: number;
}

/** The list item the caret is in, with the lines it owns — or null when the caret is not in one. */
function itemAt(state: EditorState, pos: number): Item | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const match = MARKER.exec(line.text);
  if (!match) {
    // A continuation line of an item is still in the item, and Tab there should move the item.
    const owner = ownerOfContinuation(state, line.number);
    return owner ? itemAt(state, doc.line(owner).from) : null;
  }

  // Past the indent, because **`ListItem` starts at the line start for a top-level item and at the
  // marker for a nested one** — decision 85's trap, third file to meet it. At `line.from` on a
  // nested item the innermost node is still the outer item, so Tab on `   1. a` would have moved
  // its parent.
  const [, indent, marker, gap] = match as unknown as [string, string, string, string];
  const node = listItemAt(state, line.from + indent.length);
  if (!node) return null;

  return {
    first: doc.lineAt(node.from).number,
    last: doc.lineAt(Math.min(node.to, doc.length)).number,
    indent: indent.length,
    content: indent.length + marker.length + gap.length,
  };
}

function listItemAt(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node.parent && node.name !== "ListItem") node = node.parent;
  return node.name === "ListItem" ? node : null;
}

/** The line number of the item a marker-less line belongs to, or null. */
function ownerOfContinuation(state: EditorState, lineNumber: number): number | null {
  const doc = state.doc;
  if (doc.line(lineNumber).text.trim() === "") return null;
  const node = listItemAt(state, doc.line(lineNumber).from);
  if (!node) return null;
  const owner = doc.lineAt(node.from).number;
  return owner === lineNumber ? null : owner;
}

/**
 * The nearest line above `first` carrying a marker, at or shallower than `indent`.
 *
 * Blank lines are skipped: a blank line does not end a list, and a loose list is still a list. A
 * marker-less line is a continuation of something above and is skipped for the same reason.
 */
function markerAbove(state: EditorState, first: number, indent: number) {
  const doc = state.doc;
  for (let n = first - 1; n >= 1; n--) {
    const line = doc.line(n);
    if (line.text.trim() === "") continue;
    const match = MARKER.exec(line.text);
    if (!match) continue;
    const [, lead, marker, gap] = match as unknown as [string, string, string, string];
    const at = lead.length;
    if (at > indent) continue;
    return { indent: at, content: at + marker.length + gap.length };
  }
  return null;
}

/** Rewrites the leading whitespace of every line an item owns, blank lines left alone. */
function shift(view: EditorView, item: Item, delta: number): boolean {
  if (delta === 0) return false;
  const doc = view.state.doc;
  const changes = [];

  for (let n = item.first; n <= item.last; n++) {
    const line = doc.line(n);
    if (line.text.trim() === "") continue;
    const leading = /^[ \t]*/.exec(line.text)![0];
    const width = Math.max(0, leading.length + delta);
    changes.push({ from: line.from, to: line.from + leading.length, insert: " ".repeat(width) });
  }
  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    // `input.indent` rather than a bare selection change, so the renumbering filter treats it as
    // the edit it is: an item that has just changed level has to start counting from 1, and its old
    // siblings have to close the gap it left.
    userEvent: "input.indent",
    scrollIntoView: true,
  });
  return true;
}

/**
 * ⇥ — nest the item under the one above it.
 *
 * Declines when there is no sibling above, which is CommonMark's rule rather than a nicety: the
 * first item of a list has nothing to be a child of, and indenting it produces either a code block
 * or a lazy continuation depending on how far it goes. Typora and Obsidian both refuse it.
 */
export function indentListItem(view: EditorView): boolean {
  const state = view.state;
  const item = itemAt(state, state.selection.main.head);
  if (!item) return false;

  const sibling = markerAbove(state, item.first, item.indent);
  if (!sibling || sibling.indent !== item.indent) return false;

  return shift(view, item, sibling.content - item.indent);
}

/** ⇧⇥ — move the item back out to its parent's column, or to the margin when it has no parent. */
export function outdentListItem(view: EditorView): boolean {
  const state = view.state;
  const item = itemAt(state, state.selection.main.head);
  if (!item || item.indent === 0) return false;

  const parent = markerAbove(state, item.first, item.indent - 1);
  return shift(view, item, (parent ? parent.indent : 0) - item.indent);
}

/**
 * The Tab binding: a list item first, CodeMirror's own indentation everywhere else.
 *
 * Tab outside a list still indents by `indentUnit`, which is what it means in a code block and does
 * no harm in prose. **Inside one it never falls through**, and that distinction is the whole rule:
 * `indentListItem` declining means "this item may not move", not "nobody handled the key", so
 * handing Tab on to `indentMore` put two spaces in front of a first item's marker and four in front
 * of it on the second press — which pandoc reads as an indented code block rather than a list.
 * A refusal has to consume the key.
 */
export const listAwareTab = {
  key: "Tab",
  run: (view: EditorView) => {
    if (itemAt(view.state, view.state.selection.main.head)) return indentListItem(view) || true;
    return indentMore(view);
  },
  shift: (view: EditorView) => {
    if (itemAt(view.state, view.state.selection.main.head)) return outdentListItem(view) || true;
    return indentLess(view);
  },
};

/** Where an item's text starts, for anything that needs to line a new line up under it. */
export function contentColumn(state: EditorState, pos: number): number | null {
  const item = itemAt(state, pos);
  return item ? item.content : null;
}
