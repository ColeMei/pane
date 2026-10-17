/*
 * Where a motion puts the caret.
 *
 * Every key that moves the caret or extends a selection dispatches it through `place`, and every
 * filter that rebuilds one wraps it with `one`. A transaction reads a bare `SelectionRange` passed
 * as its `selection` as `{anchor, head}`, which drops the side the caret is drawn on and its goal
 * column (187; LAB, 2026-10-17). A keyboard table fails on any bare range passed that way.
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
