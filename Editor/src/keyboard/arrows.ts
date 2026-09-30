/*
 * ↑ and ↓ — CodeMirror's own line move, then a step off any line that is not a place.
 *
 * The break is not a place (146, extending 89): a caret that stops on it for a press sits three
 * pixels under the text above, squashed into an 8px strip (132), and reads as a ⇧⏎ line nobody
 * typed. Nor is a fence line or a rule (151).
 *
 * **The step is by line number and character column, not by moving again.** Repeating CodeMirror's
 * own move looks equivalent and is not: `cursorLineDown` works in pixels, and the lines being
 * stepped over are collapsed to 8px, so whether one move clears one of them or two depends on the
 * line height — which depends on the font. Locally ↓ over two blank lines stopped on the second;
 * on CI, whose fonts are not these, it cleared both and landed in the paragraph below. Measured as
 * a green suite here and a red one there, five pushes running. `placeFor` answers the same question
 * with arithmetic, and a wrapped line's exact goal column is a fair price for an answer that is the
 * same everywhere.
 *
 * ⇧↑ and ⇧↓ take the same step with the selection's head, keeping its anchor (169): the break is no
 * more a place for a selection's end than for a caret. A run of blank lines keeps every line after
 * the first, and a blank line in a fence, as places.
 */

import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markerSpanEnd, notAPlace } from "../blocks";
import { placeFor, placeRangeEnd } from "../caret";
import type { Command } from "./edit";

/** Hidden ranges — replaced markers and widgets — overlapping `from..to`, as offsets into it. */
function hiddenIn(view: EditorView, from: number, to: number): { from: number; to: number }[] {
  const hidden: { from: number; to: number }[] = [];
  for (const set of view.state.facet(EditorView.atomicRanges).map((f) => f(view))) {
    set.between(from, to, (a, b, value) => {
      if (value.point && b > a) hidden.push({ from: Math.max(a, from), to: Math.min(b, to) });
    });
  }
  return hidden;
}

/** How many drawn characters precede `pos` on its line: the hidden markers do not count (173). */
function drawnColumn(view: EditorView, pos: number): number {
  const line = view.state.doc.lineAt(pos);
  const skipped = hiddenIn(view, line.from, pos).reduce((n, r) => n + (r.to - r.from), 0);
  return pos - line.from - skipped;
}

/** The offset on line `n` after `column` drawn characters, never before its text starts. */
function atDrawnColumn(view: EditorView, n: number, column: number): number {
  const line = view.state.doc.line(n);
  const hidden = hiddenIn(view, line.from, line.to).sort((a, b) => a.from - b.from);
  let pos = line.from;
  let left = column;
  for (const range of hidden) {
    if (range.from - pos >= left) break;
    left -= Math.max(0, range.from - pos);
    pos = Math.max(pos, range.to);
  }
  return Math.max(markerSpanEnd(view.state, n), Math.min(pos + left, line.to));
}

/** Where a vertical step that stopped on a line that is not a place goes on to (146, 173). */
function beyond(view: EditorView, head: number, from: number, column: number): number {
  const n = view.state.doc.lineAt(placeFor(view.state, head, from, 0)).number;
  return atDrawnColumn(view, n, column);
}

function stepOverBreak(move: Command): Command {
  return (view) => {
    const before = view.state.selection.main;
    const column = drawnColumn(view, before.head);
    if (!move(view)) return false;

    const range = view.state.selection.main;
    if (!range.empty || !notAPlace(view.state, view.state.doc.lineAt(range.head).number)) return true;

    const target = beyond(view, range.head, before.head, column);
    if (target !== range.head) {
      view.dispatch({ selection: EditorSelection.cursor(target), userEvent: "select", scrollIntoView: true });
    }
    return true;
  };
}

/** The same step for ⇧↑ and ⇧↓: the head moves on, the anchor stays (169). With nowhere to go,
 * it goes to its own line's edge, as ⇧↓ on a note's last line does. */
function extendOverBreak(move: Command, direction: 1 | -1): Command {
  return (view) => {
    const before = view.state.selection.main;
    const column = drawnColumn(view, before.head);
    if (!move(view)) return false;

    const range = view.state.selection.main;
    if (!notAPlace(view.state, view.state.doc.lineAt(range.head).number)) return true;

    let target = placeRangeEnd(view.state, beyond(view, range.head, before.head, column), before.head, range.anchor);
    const own = view.state.doc.lineAt(before.head);
    if (target >= own.from && target <= own.to) target = direction > 0 ? own.to : markerSpanEnd(view.state, own.number);
    if (target !== range.head) {
      view.dispatch({ selection: EditorSelection.range(range.anchor, target), userEvent: "select", scrollIntoView: true });
    }
    return true;
  };
}

export const arrowUp = stepOverBreak(cursorLineUp);
export const arrowDown = stepOverBreak(cursorLineDown);
export const shiftArrowUp = extendOverBreak(selectLineUp, -1);
export const shiftArrowDown = extendOverBreak(selectLineDown, 1);
