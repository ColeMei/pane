/*
 * What a click, a double-click and a triple-click select (206).
 *
 * CodeMirror's own style, with two changes. A double- or triple-click acts on where the series'
 * first click landed: that click put the caret in a styled word, its reveal moved the text, and
 * the next click at the same point found another word or a marker. And a triple-click takes the
 * line's text, not its break, as the reference does; the break's end lies on the blank line below,
 * which is no place (169), so the selection reached into the next paragraph and typing joined it.
 */

import { EditorSelection, EditorState, findClusterBreak, SelectionRange } from "@codemirror/state";
import { EditorView, type MouseSelectionStyle } from "@codemirror/view";

/** CodeMirror's `groupAt`, which it does not export: the run of one character category at `pos`. */
function groupAt(state: EditorState, pos: number, bias: -1 | 1): SelectionRange {
  const categorize = state.charCategorizer(pos);
  const line = state.doc.lineAt(pos);
  const at = pos - line.from;
  if (line.length === 0) return EditorSelection.cursor(pos);
  if (at === 0) bias = 1;
  else if (at === line.length) bias = -1;
  let from = at;
  let to = at;
  if (bias < 0) from = findClusterBreak(line.text, at, false);
  else to = findClusterBreak(line.text, at);
  const cat = categorize(line.text.slice(from, to));
  while (from > 0) {
    const prev = findClusterBreak(line.text, from, false);
    if (categorize(line.text.slice(prev, from)) !== cat) break;
    from = prev;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to);
    if (categorize(line.text.slice(to, next)) !== cat) break;
    to = next;
  }
  return EditorSelection.range(from + line.from, to + line.from);
}

function rangeFor(state: EditorState, pos: number, assoc: -1 | 1, count: number): SelectionRange {
  if (count === 1) return EditorSelection.cursor(pos, assoc);
  if (count === 2) return groupAt(state, pos, assoc);
  const line = state.doc.lineAt(pos);
  return EditorSelection.range(line.from, line.to);
}

type Hit = { pos: number; assoc: -1 | 1 };

/** Where the last single click landed, in the document it landed in. */
let first: { hit: Hit; doc: EditorState["doc"] } | null = null;

function hitAt(view: EditorView, event: MouseEvent): Hit {
  const hit = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
  return { pos: hit.pos, assoc: hit.assoc };
}

function pointerSelection(view: EditorView, down: MouseEvent): MouseSelectionStyle {
  const count = Math.min(Math.max(down.detail, 1), 3);
  let start = hitAt(view, down);
  if (count === 1) first = { hit: { ...start }, doc: view.state.doc };
  else if (first && first.doc === view.state.doc) start = { ...first.hit };
  let startSel = view.state.selection;

  return {
    update(update) {
      if (!update.docChanged) return;
      start.pos = update.changes.mapPos(start.pos);
      startSel = startSel.map(update.changes);
    },
    get(event, extend) {
      // Until the pointer moves, it is still on the word the series started on.
      const still = event.clientX === down.clientX && event.clientY === down.clientY;
      const cur = still ? start : hitAt(view, event);
      let range = rangeFor(view.state, cur.pos, cur.assoc, count);
      if (start.pos !== cur.pos && !extend) {
        const startRange = rangeFor(view.state, start.pos, start.assoc, count);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }
      if (extend) return startSel.replaceRange(startSel.main.extend(range.from, range.to));
      return EditorSelection.create([range]);
    },
  };
}

export const pointerSelect = EditorView.mouseSelectionStyle.of((view, event) =>
  event.button === 0 ? pointerSelection(view, event) : null
);
