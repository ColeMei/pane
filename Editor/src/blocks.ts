/*
 * What a selection actually covers, in markdown's terms rather than the editor's.
 *
 * The formatting commands used to treat a selection as a flat range of characters and each line as
 * an independent thing to prefix. Both are wrong in the same way, and it showed up as soon as a
 * selection crossed a paragraph:
 *
 *   - Bold over two paragraphs wrapped the whole range once, giving `**rest` … `rest**` — which no
 *     markdown parser reads as emphasis, because emphasis cannot span a blank line. The text simply
 *     stopped rendering and nothing said why.
 *   - A list over the same range prefixed *every* line, blank ones included, so the blank lines
 *     between paragraphs became empty numbered items. And a paragraph broken with ⇧⏎ became two
 *     items rather than one, restarting the numbering.
 *
 * Both fixes need the same thing: the **blocks** a selection touches. We already parse the document
 * — live preview, ⌘A and the format bar's pressed state all read the tree — so this is the commands
 * finally reading it too, rather than counting lines.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export interface Block {
  /** Document offsets of the whole block, including any soft-wrapped continuation lines. */
  from: number;
  to: number;
  name: string;
}

/**
 * Markdown's leaf blocks — the things that hold text rather than other blocks — plus `ListItem`.
 *
 * `ListItem` is here *and* preferred over the `Paragraph` inside it: a bullet's paragraph is its
 * text without the marker, while a task item has no paragraph at all, so taking the innermost node
 * would treat the two kinds of list differently. One rule for both.
 */
const BLOCK_NODES = new Set([
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
  "ListItem",
  "Blockquote",
]);

/**
 * The block containing `pos`, or null when it sits in nothing — a blank line between two blocks.
 *
 * `side` is the bias, and it is not a detail. A caret wants -1, so that having just typed the last
 * character of a construct still counts as being inside it. A *line start* wants +1: at that offset
 * the node ending to the left is the previous block, so resolving left from the start of every line
 * reported the paragraph above it — which made `blocksIn` return one block for a whole multi-block
 * selection, and every command silently do nothing.
 */
export function blockAt(state: EditorState, pos: number, side: -1 | 1 = -1): Block | null {
  let node = syntaxTree(state).resolveInner(pos, side);
  while (node.parent && !BLOCK_NODES.has(node.name)) node = node.parent;
  if (!BLOCK_NODES.has(node.name)) return null;

  // A list item's own range, not the paragraph inside it — see BLOCK_NODES.
  if (node.parent?.name === "ListItem") node = node.parent;

  // A list item that contains a nested list ends where that list begins.
  //
  // Its tree range covers everything under it, so without this the outer item's "continuation
  // lines" are the whole nested list — and once nested items are blocks in their own right
  // (see `blocksIn`), the two overlap and one press produces two conflicting edits for the same
  // line. An item's *own* content is what it can carry a marker for.
  const to = node.name === "ListItem" ? endOfOwnContent(state, node) : node.to;
  return { from: node.from, to, name: node.name };
}

/** Where a list item's own lines stop and its first nested list starts. */
function endOfOwnContent(state: EditorState, item: SyntaxNode): number {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name !== "BulletList" && child.name !== "OrderedList") continue;
    // The end of the line *before* the nested list, so the item keeps every line that is its own.
    const line = state.doc.lineAt(child.from);
    return line.number > 1 ? state.doc.line(line.number - 1).to : item.from;
  }
  return item.to;
}

/**
 * Every block a range touches, in document order, each appearing once.
 *
 * Blank lines belong to no block and are simply absent from the result, which is the whole point:
 * a command that iterates these cannot put a list marker on one.
 *
 * Resolved per line rather than by iterating the tree, because a line is the unit the caller cares
 * about and `resolveInner` at a line's start is the one lookup that is right for every construct —
 * a list line's innermost node there is its marker, and no amount of walking *up* from a tree
 * iteration reaches the item that actually starts on it.
 */
export function blocksIn(state: EditorState, from: number, to: number): Block[] {
  const doc = state.doc;
  const blocks: Block[] = [];

  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    if (line.text.trim() === "") continue;

    // Resolved at the line's first real character, not at its start.
    //
    // **`ListItem` starts at the line start for a top-level item and at the marker for a nested
    // one** — decision 85 recorded that trap in the renumbering filter and it is the same one here.
    // At `line.from` on a nested item the innermost node is still the *outer* item, so a caret in
    // `   1. a` converted `2. A` instead, and a selection of two nested items converted their
    // parents. Past the indent, the innermost node is the nested item's own marker.
    const block = blockAt(state, line.from + /^[ \t]*/.exec(line.text)![0].length, 1);
    if (!block) continue;
    if (blocks.some((b) => b.from === block.from && b.to === block.to)) continue;
    blocks.push(block);
  }

  return blocks;
}

/** The lines a block spans — one for most, more when a paragraph was broken with ⇧⏎. */
export function linesOf(state: EditorState, block: Block): { from: number; to: number; text: string }[] {
  const doc = state.doc;
  const lines = [];
  const last = doc.lineAt(Math.min(block.to, doc.length)).number;
  for (let n = doc.lineAt(block.from).number; n <= last; n++) {
    const line = doc.line(n);
    lines.push({ from: line.from, to: line.to, text: line.text });
  }
  return lines;
}
