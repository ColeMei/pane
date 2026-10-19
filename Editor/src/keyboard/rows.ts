/*
 * The visual rows of a wrapped line, in the layout drawn now — decision 187.
 *
 * A caret at a wrap point is one offset with two places to be drawn: the end of the row above or
 * the start of the row below, and its `assoc` says which. So a row is identified by its index
 * within the line, and the row a caret is on by its side as well as its offset.
 */

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { pastHidden } from "./hidden";

export interface Row {
  from: number;
  to: number;
}

/**
 * The visual rows of document line `n`, in the layout drawn now; each ends where the next starts.
 * A hidden marker has no reliable coordinates, so each row is measured from the visible text after
 * it, and a boundary sits before the marker that opens the row below (187). Markers that end the
 * line are the last row's, not a row of their own (200).
 */
export function rowsOf(view: EditorView, n: number): Row[] {
  const line = view.state.doc.line(n);
  const rows: Row[] = [];
  for (let from = line.from; ; ) {
    const raw = view.moveToLineBoundary(EditorSelection.cursor(pastHidden(view, from, 1), 1), true, true).head;
    const to = pastHidden(view, raw, -1);
    // Only hidden markers past the boundary: the line ends there, not a row of nothing (200).
    if (raw >= line.to || to <= from || pastHidden(view, to, 1) >= line.to) { rows.push({ from, to: line.to }); return rows; }
    rows.push({ from, to });
    from = to;
  }
}

/** The row a caret is drawn on: at a wrap point, the upper row only when it sits before its position. */
export function rowAt(rows: Row[], head: number, assoc: number): number {
  const k = rows.findIndex((row) => head < row.to || (head === row.to && assoc < 0));
  return k < 0 ? rows.length - 1 : k;
}
