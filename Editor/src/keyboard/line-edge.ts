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

import type { EditorView } from "@codemirror/view";
import { markerSpanEnd } from "../blocks";
import type { Command } from "./edit";
import { pastHidden } from "./hidden";
import { growFrom, place } from "./motion";
import { type Row, rowAt, rowsOf } from "./rows";

/** A row's edge, as a caret may stand at it. */
function edgeOf(view: EditorView, rows: Row[], k: number, forward: boolean, start: number): number {
  const row = rows[Math.min(k, rows.length - 1)]!;
  if (forward) return Math.max(row.to, start);
  return Math.max(pastHidden(view, Math.max(row.from, start), -1), start);
}

/** The edge of the visual row the caret at `head` is drawn on, as a caret may stand at it. */
export function lineEdge(view: EditorView, head: number, assoc: number, forward: boolean): number {
  const n = view.state.doc.lineAt(head).number;
  const rows = rowsOf(view, n);
  return edgeOf(view, rows, rowAt(rows, head, assoc), forward, markerSpanEnd(view.state, n));
}

function moveTo(extend: boolean, forward: boolean): Command {
  return (view) => {
    // Extending, a selection grows from its edge on this side and keeps the far one (192).
    const main = view.state.selection.main;
    const { base: head, anchor, assoc } = extend ? growFrom(view, forward) : { base: main.head, anchor: main.anchor, assoc: main.assoc };
    const n = view.state.doc.lineAt(head).number;
    const start = markerSpanEnd(view.state, n);
    const k = rowAt(rowsOf(view, n), head, assoc);
    const side = forward ? -1 : 1;
    // Landing in or out of an inline construct reveals or hides its markers and can rewrap the line,
    // so the edge is of the caret's row by its index, measured again in the layout now drawn (187).
    // The caret keeps its side (`place`): dropped, ⌘→'s caret would be drawn at the start of the row below.
    let at = -1;
    for (let pass = 0; pass < 3; pass++) {
      const target = edgeOf(view, rowsOf(view, n), k, forward, start);
      if (target === at) break;
      at = target;
      place(view, at, side, extend, extend ? anchor : undefined);
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

/**
 * ⌃A and ⌃E (with ⇧, to extend): the edges of the whole line, not its row, as macOS's
 * paragraph moves are; outside an inline construct and after a block's marker, as ⌘← and ⌘→ are
 * (170). A second press stays (189).
 */
export function lineTextEdge(extend: boolean, forward: boolean): Command {
  return (view) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    place(view, forward ? line.to : markerSpanEnd(view.state, line.number), forward ? -1 : 1, extend);
    return true;
  };
}

/** ⌃K: delete to the line's end, the pairs kept by the delete filter (177); at the end, ⌦ (172, 189). */
export function killToLineEnd(deleteKey: Command): Command {
  return (view) => {
    const range = view.state.selection.main;
    if (!range.empty) return false;
    const line = view.state.doc.lineAt(range.head);
    if (range.head >= line.to) return deleteKey(view);
    view.dispatch({ changes: { from: range.head, to: line.to }, userEvent: "delete.forward", scrollIntoView: true });
    return true;
  };
}
