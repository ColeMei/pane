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
 * with arithmetic, for an answer that is the same everywhere.
 *
 * The column is a column within the row: counted on the caret's row, laid on the target line's row
 * nearest the move, and taken whenever the move crossed such a line, stopping on it or clearing it
 * in one pixel move. The step keeps the goal x CodeMirror's move aimed for. So a round trip comes
 * back where it started (200).
 *
 * Both start from the row the caret is drawn on, at a wrap point too (188).
 *
 * ⇧↑ and ⇧↓ take the same step with the selection's head, keeping its anchor (169): the break is no
 * more a place for a selection's end than for a caret. A run of blank lines keeps every line after
 * the first, and a blank line in a fence, as places.
 */

import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from "@codemirror/commands";
import type { SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markerSpanEnd, notAPlace } from "../blocks";
import { placeFor, placeRangeEnd } from "../caret";
import type { Command } from "./edit";
import { hiddenIn } from "./hidden";
import { place, sideAsDrawn } from "./motion";
import { rowAt, rowsOf } from "./rows";

/** How many drawn characters precede the caret on the row it is drawn on: hidden markers do not count (173, 200). */
function drawnColumn(view: EditorView, pos: number, assoc: number): number {
  const rows = rowsOf(view, view.state.doc.lineAt(pos).number);
  const row = rows[rowAt(rows, pos, assoc)]!;
  const skipped = hiddenIn(view, row.from, pos).reduce((n, r) => n + (r.to - r.from), 0);
  return pos - row.from - skipped;
}

/**
 * What the last vertical move aimed for, while the selection it left stands: the drawn column, so a
 * step clamped at a short line's end still aims for the column it came from, and where the run of
 * moves started, so a step back onto that row lands there, whatever was revealed on the way (200).
 * CodeMirror's pixel goal does both for its own moves.
 */
interface Goal { column: number; origin: number; originAssoc: number }
const aimed = new WeakMap<EditorView, { doc: unknown; anchor: number; head: number; goal: Goal }>();

function goalFor(view: EditorView, before: SelectionRange): Goal {
  const kept = aimed.get(view);
  if (kept && kept.doc === view.state.doc && kept.anchor === before.anchor && kept.head === before.head) return kept.goal;
  return { column: drawnColumn(view, before.head, before.assoc), origin: before.head, originAssoc: before.assoc };
}

function aim(view: EditorView, goal: Goal): void {
  const range = view.state.selection.main;
  aimed.set(view, { doc: view.state.doc, anchor: range.anchor, head: range.head, goal });
}

/**
 * The place the goal's column drawn characters into line `n`'s row nearest the move, its last going
 * up and its first going down, never before its text starts; or where the run of moves started,
 * when that is on this row. The side keeps a caret at a wrap point on
 * that row (200).
 */
function atDrawnColumn(view: EditorView, n: number, goal: Goal, direction: 1 | -1): { pos: number; side: -1 | 0 } {
  const line = view.state.doc.line(n);
  const rows = rowsOf(view, n);
  const k = direction > 0 ? 0 : rows.length - 1;
  const row = rows[k]!;
  if (goal.origin >= line.from && goal.origin <= line.to && rowAt(rows, goal.origin, goal.originAssoc) === k) {
    return { pos: goal.origin, side: goal.originAssoc < 0 && goal.origin === row.to && row.to < line.to ? -1 : 0 };
  }
  const column = goal.column;
  const hidden = hiddenIn(view, row.from, row.to).sort((a, b) => a.from - b.from);
  let pos = row.from;
  let left = column;
  for (const range of hidden) {
    if (range.from - pos >= left) break;
    left -= Math.max(0, range.from - pos);
    pos = Math.max(pos, range.to);
  }
  pos = Math.max(markerSpanEnd(view.state, n), Math.min(pos + left, row.to));
  return { pos, side: pos === row.to && row.to < line.to ? -1 : 0 };
}

/** Where a vertical step that stopped on a line that is not a place goes on to (146, 173). */
function beyond(view: EditorView, head: number, from: number, goal: Goal, direction: 1 | -1) {
  const n = view.state.doc.lineAt(placeFor(view.state, head, from, 0)).number;
  return atDrawnColumn(view, n, goal, direction);
}

/**
 * Where a vertical move from `from` that landed at `head` goes, when it crossed a line that is not
 * a place: stopped on one, or cleared one in a single pixel move (200). Null when it crossed none.
 */
function overBreak(view: EditorView, head: number, from: number, goal: Goal, direction: 1 | -1) {
  const doc = view.state.doc;
  const a = doc.lineAt(from).number, b = doc.lineAt(head).number;
  if (notAPlace(view.state, b)) return beyond(view, head, from, goal, direction);
  for (let n = Math.min(a, b) + 1; n < Math.max(a, b); n++) {
    if (notAPlace(view.state, n)) return atDrawnColumn(view, b, goal, direction);
  }
  return null;
}

/**
 * The move is predicted with `moveVertically`, which dispatches nothing, and the step measured in the
 * layout drawn before it: a move that landed inside a construct first would reveal its markers, and
 * the column would count them (200). With no break crossed, CodeMirror's own command moves.
 */
function stepOverBreak(move: Command, direction: 1 | -1): Command {
  return (view) => {
    sideAsDrawn(view);
    const before = view.state.selection.main;
    if (!before.empty) return move(view);
    const goal = goalFor(view, before);
    const moved = view.moveVertically(before, direction > 0);
    const target = overBreak(view, moved.head, before.head, goal, direction);
    if (!target) {
      if (!move(view)) return false;
    } else {
      place(view, target.pos, target.side, false, undefined, moved.goalColumn);
    }
    aim(view, goal);
    return true;
  };
}

/** The same step for ⇧↑ and ⇧↓: the head moves on, the anchor stays (169). With nowhere to go,
 * it goes to its own line's edge, as ⇧↓ on a note's last line does. */
function extendOverBreak(move: Command, direction: 1 | -1): Command {
  return (view) => {
    sideAsDrawn(view);
    const before = view.state.selection.main;
    const goal = goalFor(view, before);
    const moved = view.moveVertically(before, direction > 0);
    const over = overBreak(view, moved.head, before.head, goal, direction);
    if (!over) {
      if (!move(view)) return false;
      aim(view, goal);
      return true;
    }

    let target = placeRangeEnd(view.state, over.pos, before.head, before.anchor);
    const own = view.state.doc.lineAt(before.head);
    if (target >= own.from && target <= own.to) target = direction > 0 ? own.to : markerSpanEnd(view.state, own.number);
    place(view, target, target === over.pos ? over.side : 0, true, before.anchor, moved.goalColumn);
    aim(view, goal);
    return true;
  };
}

export const arrowUp = stepOverBreak(cursorLineUp, -1);
export const arrowDown = stepOverBreak(cursorLineDown, 1);
export const shiftArrowUp = extendOverBreak(selectLineUp, -1);
export const shiftArrowDown = extendOverBreak(selectLineDown, 1);
