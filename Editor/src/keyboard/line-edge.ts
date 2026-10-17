/*
 * ⌘← and ⌘→, with ⇧ and ⌘⌫: the line's edges are its text's edges — decision 170.
 *
 * CodeMirror finds a wrapped line's boundary by asking for the position at the editor's edge, and a
 * hidden marker has no width there. So on `aa **bold words**`, ⌘→ stopped at `words|**`, inside
 * the construct, and whatever came next extended it; on a link it stopped inside the URL. ⌘←
 * stopped inside `## ` — one character short of the text — so ⌘⌫ deleted the heading's space.
 *
 * The edge is CodeMirror's, then stepped outward past any hidden marker it sits against, and never
 * back into a block's marker span. ⌘← at the text start therefore stays there (the ← rule in
 * `caret.ts` is for ←). At the text start, ⌥⌫ and ⌘⌫ do what ⌫ does: they unwrap a block, join a
 * paragraph to the one above, and leave a fence alone.
 *
 * On a wrapped line the edge is the visual row the caret is drawn on, which the caret's `assoc`
 * says, and the caret keeps the side it lands on. A reveal can rewrap the line under the caret, so
 * the move is measured again once the line has redrawn — decision 187.
 */

import { EditorSelection, type RangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markerSpanEnd } from "../blocks";
import type { Command } from "./edit";

function atomsOf(view: EditorView): RangeSet<any>[] {
  return view.state.facet(EditorView.atomicRanges).map((f) => f(view));
}

/** Step `pos` past every atom it touches in `direction` — out of hidden markers, never into text. */
function pastAtoms(view: EditorView, pos: number, direction: 1 | -1): number {
  const atoms = atomsOf(view);
  for (let moved = true; moved; ) {
    moved = false;
    for (const set of atoms) {
      set.between(pos - 1, pos + 1, (from, to) => {
        if (to <= from) return;
        if (direction === 1 && from <= pos && to > pos) { pos = to; moved = true; }
        if (direction === -1 && to >= pos && from < pos) { pos = from; moved = true; }
      });
    }
  }
  return pos;
}

interface Row { from: number; to: number }

/**
 * The visual rows of document line `n`, in the layout drawn now; each ends where the next starts.
 * A hidden marker has no reliable coordinates, so each row is measured from the visible text after
 * it, and a boundary sits before the marker that opens the row below (187).
 */
function rowsOf(view: EditorView, n: number): Row[] {
  const line = view.state.doc.line(n);
  const rows: Row[] = [];
  for (let from = line.from; ; ) {
    const raw = view.moveToLineBoundary(EditorSelection.cursor(pastAtoms(view, from, 1), 1), true, true).head;
    const to = pastAtoms(view, raw, -1);
    if (raw >= line.to || to <= from) { rows.push({ from, to: line.to }); return rows; }
    rows.push({ from, to });
    from = to;
  }
}

/** The row a caret is drawn on: at a wrap point, the upper row only when it sits before its position. */
function rowAt(rows: Row[], head: number, assoc: number): number {
  const k = rows.findIndex((row) => head < row.to || (head === row.to && assoc < 0));
  return k < 0 ? rows.length - 1 : k;
}

/** A row's edge, as a caret may stand at it. */
function edgeOf(view: EditorView, rows: Row[], k: number, forward: boolean, start: number): number {
  const row = rows[Math.min(k, rows.length - 1)]!;
  if (forward) return Math.max(row.to, start);
  return Math.max(pastAtoms(view, Math.max(row.from, start), -1), start);
}

/** The edge of the visual row the caret at `head` is drawn on, as a caret may stand at it. */
export function lineEdge(view: EditorView, head: number, assoc: number, forward: boolean): number {
  const n = view.state.doc.lineAt(head).number;
  const rows = rowsOf(view, n);
  return edgeOf(view, rows, rowAt(rows, head, assoc), forward, markerSpanEnd(view.state, n));
}

function moveTo(extend: boolean, forward: boolean): Command {
  return (view) => {
    const { anchor, head, assoc } = view.state.selection.main;
    const n = view.state.doc.lineAt(head).number;
    const start = markerSpanEnd(view.state, n);
    const k = rowAt(rowsOf(view, n), head, assoc);
    const side = forward ? -1 : 1;
    // Landing in or out of an inline construct reveals or hides its markers and can rewrap the line,
    // so the edge is of the caret's row by its index, measured again in the layout now drawn (187).
    // An `EditorSelection`, not a bare range, which a transaction reads as `{anchor, head}`: the
    // side would be dropped, and ⌘→'s caret drawn at the start of the row below.
    let at = -1;
    for (let pass = 0; pass < 3; pass++) {
      const target = edgeOf(view, rowsOf(view, n), k, forward, start);
      if (target === at) break;
      at = target;
      view.dispatch({
        selection: EditorSelection.create([extend ? EditorSelection.range(anchor, at, undefined, undefined, side) : EditorSelection.cursor(at, side)]),
        userEvent: "select",
        scrollIntoView: true,
      });
    }
    return true;
  };
}

export const lineStart = moveTo(false, false);
export const lineEnd = moveTo(false, true);
export const selectLineStart = moveTo(true, false);
export const selectLineEnd = moveTo(true, true);

/** ⌘⌫: delete to the line's text start; at it, `backspace`. */
export function deleteToLineStart(backspace: Command): Command {
  return (view) => {
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const to = lineEdge(view, range.head, range.assoc, false);
    if (to >= range.head) return backspace(view);
    view.dispatch({ changes: { from: to, to: range.head }, selection: { anchor: to }, userEvent: "delete.line", scrollIntoView: true });
    return true;
  };
}

/** ⌥⌫ at the text start is ⌫; anywhere else it is CodeMirror's word delete. */
export function deleteWordAtStart(backspace: Command): Command {
  return (view) => {
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const line = view.state.doc.lineAt(range.head);
    return range.head === markerSpanEnd(view.state, line.number) ? backspace(view) : false;
  };
}
