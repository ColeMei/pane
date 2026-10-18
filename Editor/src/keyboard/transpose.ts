/*
 * ⌃T — decision 190.
 *
 * macOS swaps the letters either side of the caret and moves past them; at a line's end it swaps
 * the two before it. CodeMirror's own ⌃T swapped across a line break and through a construct's
 * markers, writing `*b*old` for `**bold`. Typora never touches a marker or a line's edge. Neither
 * does this: where either letter is part of a marker, hidden or shown, or a block's marker span, or
 * the caret is at a line's start, ⌃T does nothing.
 */

import type { Command } from "./edit";
import { isMarkerChar } from "./hidden";

export const transpose: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty) return true;
  const line = view.state.doc.lineAt(range.head);
  if (range.head === line.from) return true;
  // Mid-line, the letters either side; at the line's end, the two before it.
  const a = range.head === line.to ? range.head - 2 : range.head - 1;
  const b = a + 1;
  if (a < line.from) return true;
  if (isMarkerChar(view, a) || isMarkerChar(view, b)) return true;
  const doc = view.state.doc;
  const swapped = doc.sliceString(b, b + 1) + doc.sliceString(a, a + 1);
  view.dispatch({ changes: { from: a, to: b + 1, insert: swapped }, selection: { anchor: b + 1 }, userEvent: "input.transpose", scrollIntoView: true });
  return true;
};
