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

/** The edge of the (visual) line holding `head`, as a caret may stand at it. */
export function lineEdge(view: EditorView, head: number, forward: boolean): number {
  const state = view.state;
  const line = state.doc.lineAt(head);
  const start = markerSpanEnd(state, line.number);
  const edge = view.moveToLineBoundary(EditorSelection.cursor(head, forward ? -1 : 1), forward, true).head;
  if (forward) return Math.max(pastAtoms(view, edge, 1), start);
  return Math.max(pastAtoms(view, Math.max(edge, start), -1), start);
}

function moveTo(extend: boolean, forward: boolean): Command {
  return (view) => {
    const range = view.state.selection.main;
    const head = lineEdge(view, range.head, forward);
    view.dispatch({
      selection: extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head, forward ? -1 : 1),
      userEvent: "select",
      scrollIntoView: true,
    });
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
    const to = lineEdge(view, range.head, false);
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
