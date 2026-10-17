/*
 * Which markers are hidden at or around a position: one home for a question that ⌘← and ⌘→, ↑
 * and ↓, and the arrow and word moves each used to ask in their own words.
 *
 * Two answers, kept apart because they are different questions:
 *   - **Hidden ranges** are what is drawn as nothing, read off the editor's atomic ranges: a
 *     replaced marker or a widget (57, 168). A row's edge steps past them (170, 187), and a column
 *     counts without them (173).
 *   - **Seams** are read off the syntax, whether or not the markers are drawn: a position between
 *     a construct's marker and its text, or between two of its markers. Not a stop (177).
 */

import type { EditorState, RangeSet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { spansIn } from "./spans";

export interface Region {
  from: number;
  to: number;
}

function atomsOf(view: EditorView): RangeSet<any>[] {
  return view.state.facet(EditorView.atomicRanges).map((f) => f(view));
}

/** Step `pos` past every atom it touches in `direction` — out of hidden markers, never into text. */
export function pastHidden(view: EditorView, pos: number, direction: 1 | -1): number {
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

/** Hidden ranges — replaced markers and widgets — overlapping `from..to`, as offsets into it. */
export function hiddenIn(view: EditorView, from: number, to: number): Region[] {
  const hidden: Region[] = [];
  for (const set of atomsOf(view)) {
    set.between(from, to, (a, b, value) => {
      if (value.point && b > a) hidden.push({ from: Math.max(a, from), to: Math.min(b, to) });
    });
  }
  return hidden;
}

/** Is `pos` between a construct's marker and its text, or inside a marker — not a place to stop (177)? */
export function isSeam(state: EditorState, pos: number): boolean {
  return spansIn(state, pos, pos).some((s) => pos > s.from && pos < s.to && (pos <= s.textFrom || pos >= s.textTo));
}
