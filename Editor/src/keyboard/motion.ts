/*
 * Where a motion puts the caret.
 *
 * Every key that moves the caret or extends a selection dispatches it through `place`, and every
 * filter that rebuilds one wraps it with `one`. A transaction reads a bare `SelectionRange` passed
 * as its `selection` as `{anchor, head}`, which drops the side the caret is drawn on and its goal
 * column (187; LAB, 2026-10-17). A keyboard table fails on any bare range passed that way.
 *
 * A caret with no side at a wrap point is drawn at the start of the lower row (CodeMirror draws
 * `assoc || 1`) but measured for ↑ and ↓ from the end of the upper (`assoc || -1`), so ↑ skipped a
 * row; `sideAsDrawn` gives it the side it is drawn on first (188).
 */

import { EditorSelection, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** One range, as a selection a transaction keeps whole. */
export function one(range: SelectionRange): EditorSelection {
  return EditorSelection.create([range]);
}

/**
 * Move the caret to `head`, drawn on `side` of it: -1 at the end of the row above a wrap point, 1
 * at the start of the row below, 0 as CodeMirror would. With `extend`, the anchor stays.
 */
export function place(view: EditorView, head: number, side: -1 | 0 | 1, extend: boolean): void {
  const { anchor } = view.state.selection.main;
  view.dispatch({
    selection: one(extend ? EditorSelection.range(anchor, head, undefined, undefined, side || undefined) : EditorSelection.cursor(head, side)),
    userEvent: "select",
    scrollIntoView: true,
  });
}

/** Give a side-less caret at a wrap point the side it is drawn on, the lower row's start (188). */
export function sideAsDrawn(view: EditorView): void {
  const range = view.state.selection.main;
  if (!range.empty || range.assoc !== 0) return;
  const below = view.coordsAtPos(range.head, 1), above = view.coordsAtPos(range.head, -1);
  if (!below || !above || Math.abs(below.top - above.top) < 1) return;
  view.dispatch({ selection: one(EditorSelection.cursor(range.head, 1, undefined, range.goalColumn)) });
}
