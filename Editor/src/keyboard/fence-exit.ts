/*
 * ↑ and ↓ out of a code block always arrive somewhere — decision 175.
 *
 * A fence line is not a place (151), so ↓ from a block's last line steps over the closing fence to
 * the next place. When the block ended the note there was none, and ↓ did nothing: only ⇧⏎ (147)
 * got out. When the block started the note, nothing got above it at all; and between two adjacent
 * blocks, ↓ went straight into the next one's code. Typora opens a line in each of those places.
 *
 * So does Pane now, in 147's shape — a blank line each side and the caret on an open line between.
 * ↓ and → at the end of a block's last line open one below it when the note ends there or another
 * block follows; ↑ and ← at the start of its first line open one above it when the note starts
 * there or another block precedes. Anywhere else these keys are what they were.
 */

import type { EditorState } from "@codemirror/state";
import { fencedBlockAt, fencesOf, notAPlace } from "../blocks";
import type { Command } from "./edit";

/** The closed block whose code line holds `pos`, with its first and last lines. */
function blockAround(state: EditorState, pos: number) {
  const node = fencedBlockAt(state, pos, 1) ?? fencedBlockAt(state, pos, -1);
  if (!node) return null;
  const { first, last, closed } = fencesOf(state, node);
  if (!closed || last - first < 2) return null;
  const n = state.doc.lineAt(pos).number;
  if (n <= first || n >= last) return null;
  return { first, last, n };
}

/** The next place from line `n` in `direction`, or null at the note's edge. */
function nextPlace(state: EditorState, n: number, direction: 1 | -1): number | null {
  for (let m = n + direction; m >= 1 && m <= state.doc.lines; m += direction) {
    if (!notAPlace(state, m)) return m;
  }
  return null;
}

function codeLine(state: EditorState, n: number): boolean {
  return blockAround(state, state.doc.line(n).from) !== null;
}

function openLine(direction: 1 | -1, horizontal: boolean): Command {
  return (view) => {
    const state = view.state;
    const range = state.selection.main;
    if (!range.empty) return false;
    const block = blockAround(state, range.head);
    if (!block) return false;
    const line = state.doc.lineAt(range.head);
    if (direction > 0 ? block.n !== block.last - 1 : block.n !== block.first + 1) return false;
    if (horizontal && range.head !== (direction > 0 ? line.to : line.from)) return false;
    const fence = state.doc.line(direction > 0 ? block.last : block.first);
    const beyond = nextPlace(state, fence.number, direction);
    if (beyond !== null && !codeLine(state, beyond)) return false;
    // Below: after the closing fence. Above: before the opening fence, or after the block above's
    // closing fence when there is one, so the new line sits between the two.
    let at: number;
    if (direction > 0) at = fence.to;
    else if (beyond === null) at = 0;
    else {
      const above = fencedBlockAt(state, state.doc.line(beyond).from, 1) ?? fencedBlockAt(state, state.doc.line(beyond).from, -1);
      at = above ? state.doc.line(fencesOf(state, above).last).to : fence.from;
    }
    // At the note's start the open line is the first one; everywhere else it follows a blank line.
    const anchor = at === 0 ? 0 : at + 2;
    view.dispatch({ changes: { from: at, insert: "\n\n" }, selection: { anchor }, userEvent: "input", scrollIntoView: true });
    return true;
  };
}

export const openBelow = openLine(1, false);
export const openAbove = openLine(-1, false);
export const openBelowRight = openLine(1, true);
export const openAboveLeft = openLine(-1, true);
