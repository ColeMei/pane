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
  return { from: node.from, to: node.to, name: node.name };
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

    const block = blockAt(state, line.from, 1);
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
