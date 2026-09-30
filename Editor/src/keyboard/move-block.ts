/*
 * ⌥↑ and ⌥↓, ⌃⌘↑ and ⌃⌘↓: move the block the caret is in — decision 174.
 *
 * CodeMirror's default binds ⌥↑ to "move line", which in a list moved the item and in prose pulled
 * one line into the paragraph break: two paragraphs merged and a blank line was left behind. The
 * unit here is the block, as in Typora: a list item with everything nested under it, among its
 * sibling items, or a paragraph, heading, quote, code block or list among its neighbours. The gap
 * between the two swaps with them untouched, and the caret moves with its block. At the first or
 * last sibling nothing happens. ⌃⌘↑ is the same key under the shortcut Raycast uses (39).
 *
 * ⇧⌥↑ and ⇧⌥↓ select to the block's start or end, as they do in macOS text; the default duplicated
 * the line. ⌘⌥↑ and ⌘⌥↓ added a second caret, which Pane does not keep, and parked the one it did
 * keep on the break; they now do nothing.
 */

import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { fencesOf, markerSpanEnd } from "../blocks";
import type { Command } from "./edit";

/** The block the caret moves with: its list item, or its block at the top of the note. */
function blockAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "ListItem") return node;
      if (node.parent?.name === "Document") return node;
    }
  }
  return null;
}

/** A block's whole lines, from its first line's start to its last line with anything on it. */
function linesOf(state: EditorState, node: SyntaxNode): { from: number; to: number } {
  const doc = state.doc;
  let last = doc.lineAt(Math.min(node.to, doc.length)).number;
  if (node.name === "FencedCode") last = fencesOf(state, node).last;
  const first = doc.lineAt(node.from).number;
  while (last > first && doc.line(last).text.trim() === "") last--;
  return { from: doc.line(first).from, to: doc.line(last).to };
}

/** A list item's own marker, `1.` or `-`, and where it is. */
function markOf(state: EditorState, node: SyntaxNode): { from: number; to: number; text: string } | null {
  if (node.name !== "ListItem") return null;
  const mark = node.getChild("ListMark");
  return mark ? { from: mark.from, to: mark.to, text: state.sliceDoc(mark.from, mark.to) } : null;
}

function move(direction: -1 | 1): Command {
  return (view) => {
    const state = view.state;
    const range = state.selection.main;
    const block = blockAt(state, range.head);
    if (!block) return true;
    const other = direction < 0 ? block.prevSibling : block.nextSibling;
    if (!other) return true;
    const a = linesOf(state, direction < 0 ? other : block);
    const b = linesOf(state, direction < 0 ? block : other);
    if (a.to >= b.from) return true;
    let first = state.sliceDoc(a.from, a.to);
    const between = state.sliceDoc(a.to, b.from);
    let second = state.sliceDoc(b.from, b.to);
    // List items keep the markers of the places they move to, so `1.` stays first and the list
    // does not come to start at 2.
    const upper = direction < 0 ? other : block;
    const lower = direction < 0 ? block : other;
    const markA = markOf(state, upper);
    const markB = markOf(state, lower);
    if (markA && markB && markA.text !== markB.text) {
      second = second.slice(0, markB.from - b.from) + markA.text + second.slice(markB.to - b.from);
      first = first.slice(0, markA.from - a.from) + markB.text + first.slice(markA.to - a.from);
    }
    const offset = (pos: number) => (direction < 0 ? a.from + (pos - b.from) : a.from + second.length + between.length + (pos - a.from));
    view.dispatch({
      changes: { from: a.from, to: b.to, insert: second + between + first },
      selection: EditorSelection.range(offset(range.anchor), offset(range.head)),
      userEvent: "move.line",
      scrollIntoView: true,
    });
    return true;
  };
}

export const moveBlockUp = move(-1);
export const moveBlockDown = move(1);

function selectToEdge(direction: -1 | 1): Command {
  return (view) => {
    const state = view.state;
    const range = state.selection.main;
    const block = blockAt(state, range.head);
    if (!block) return true;
    const lines = linesOf(state, block);
    const edge = direction < 0 ? markerSpanEnd(state, state.doc.lineAt(lines.from).number) : lines.to;
    view.dispatch({ selection: EditorSelection.range(range.anchor, edge), userEvent: "select", scrollIntoView: true });
    return true;
  };
}

export const selectBlockStart = selectToEdge(-1);
export const selectBlockEnd = selectToEdge(1);

/** Take the key and do nothing. */
export const nothing: Command = () => true;
