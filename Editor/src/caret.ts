/*
 * Where the caret may rest — decision 151.
 *
 * Block markers are never shown as source (151, narrowing 57): a list draws its bullet or number,
 * a quote its bar, a heading its size, a fence its block, whether or not the caret is on the line.
 * Two things follow, and this file is both. A **marker span** — the indent, quote marks, list
 * marker and heading hashes at the head of a line — is not somewhere the caret can stand: nothing
 * there is drawn as characters, so a caret inside it would be typing into text nobody can see.
 * And a line that is **not a place** — the paragraph break (146), a fence line, a rule — is
 * stepped over in the direction the caret was travelling, keeping its column when it has one.
 *
 * One transaction filter rather than a rule per key: arrow keys, ⌥-arrows, Home, a click the
 * editor placed itself, an undo, the offset a note was opened at (11) — every way a caret can
 * arrive somewhere goes through here, and the answer is the same for all of them. The click on
 * the gap between two paragraphs keeps its own handler in `live-preview.ts`, because it knows
 * which half of the strip was clicked and this does not.
 */

import { type Annotation, type AnnotationType, EditorSelection, EditorState, type Extension, type SelectionRange, Transaction, type TransactionSpec } from "@codemirror/state";
import { fencedBlockAt, fencesOf, markerSpanEnd, notAPlace } from "./blocks";

/** The nearest place line from `n` in `direction` (exclusive), or null when there is none. */
function placeLineFrom(state: EditorState, n: number, direction: 1 | -1): number | null {
  for (let m = n + direction; m >= 1 && m <= state.doc.lines; m += direction) {
    if (!notAPlace(state, m)) return m;
  }
  return null;
}

/**
 * Where a caret asked to be at `head` actually rests, given where it came from. `column`, when
 * given, is a character column to keep on the line it lands on (the unit tables use it; the view
 * keeps its own goal in pixels and finishes vertical moves itself).
 */
export function placeFor(state: EditorState, head: number, from: number, column: number | undefined): number {
  const doc = state.doc;
  const line = doc.lineAt(head);

  if (notAPlace(state, line.number)) {
    // The direction of travel, and the other way when there is nothing that way — a caret that
    // could not go on comes back to the place it left, landing as though it had gone backwards.
    let direction: 1 | -1 = head >= from ? 1 : -1;
    let n = placeLineFrom(state, line.number, direction);
    if (n === null) {
      direction = direction === 1 ? -1 : 1;
      n = placeLineFrom(state, line.number, direction);
    }
    if (n === null) return head;
    const target = doc.line(n);
    const start = markerSpanEnd(state, n);
    if (column !== undefined) return Math.max(start, Math.min(target.from + column, target.to));
    return direction === 1 ? start : target.to;
  }

  const start = markerSpanEnd(state, line.number);
  if (head >= start) return head;
  // Inside the span. Leaving the text start leftward goes to the line above; anything else
  // lands at the text start.
  if (from === start && head < from) {
    const n = placeLineFrom(state, line.number, -1);
    return n === null ? start : doc.line(n).to;
  }
  return start;
}

/**
 * Where one end of a selection rests — decision 169. Where a caret would, by `placeFor`, with one
 * rule of its own: a code block is held whole or from inside it. An end on a fence line, or on a
 * code line while the other end is outside the block, goes to the block's far side, so typing over
 * a selection never deletes one fence and leaves the other.
 */
export function placeRangeEnd(state: EditorState, end: number, from: number, other: number, moving = true): number {
  const doc = state.doc;
  // A selection that starts in a block's code stays in it, as Typora's does.
  const home = codeInside(state, other);
  if (home && (end < home.from || end > home.to)) return end < home.from ? home.from : home.to;
  const block = fencedBlockAt(state, end, 1) ?? fencedBlockAt(state, end, -1);
  if (block) {
    const { first, last, closed } = fencesOf(state, block);
    const n = doc.lineAt(end).number;
    const firstCode = first + 1;
    const lastCode = closed ? last - 1 : last;
    const within = n >= first && n <= last;
    if (within && lastCode >= firstCode) {
      const inside = { from: doc.line(firstCode).from, to: doc.line(lastCode).to };
      if (other >= inside.from && other <= inside.to) {
        if (n === first) return inside.from;
        if (closed && n === last) return inside.to;
        return end;
      }
      if (n === first || (closed && n === last) || other < doc.line(first).from || other > doc.line(last).to) {
        if (other < doc.line(first).from) {
          const after = closed ? last + 1 : last;
          return after <= doc.lines ? placeFor(state, doc.line(Math.min(after, doc.lines)).from, doc.line(first).from, undefined) : doc.length;
        }
        return first > 1 ? placeFor(state, doc.line(first - 1).to, doc.line(first).from, undefined) : 0;
      }
    }
  }
  // The end that stays put is not stepped off a break or a rule: what was selected stays selected.
  if (!moving && notAPlace(state, doc.lineAt(end).number)) return end;
  return placeFor(state, end, from, undefined);
}

/** The code lines of the fenced block `pos` is on, when `pos` is on one of them rather than a fence. */
function codeInside(state: EditorState, pos: number): { from: number; to: number } | null {
  const block = fencedBlockAt(state, pos, 1) ?? fencedBlockAt(state, pos, -1);
  if (!block) return null;
  const { first, last, closed } = fencesOf(state, block);
  const lastCode = closed ? last - 1 : last;
  const n = state.doc.lineAt(pos).number;
  if (n <= first || n > lastCode) return null;
  return { from: state.doc.line(first + 1).from, to: state.doc.line(lastCode).to };
}

export function caretPlaces(): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    const sel = tr.newSelection;
    if (sel.ranges.length !== 1) return tr;
    if (!tr.selection && !tr.docChanged) return tr;
    // A person's own edit is never second-guessed: typing `---` under a line makes a setext
    // underline of the line the caret is on, and moving the caret off it would scatter the rest of
    // what they type. The keyboard rules put the caret where they mean to; this is for arrivals.
    if (tr.docChanged && (tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
    if (!sel.main.empty) return placeRange(tr);
    const state = tr.state;
    const head = sel.main.head;
    const line = state.doc.lineAt(head);
    // A vertical move carries a goal column in pixels, which only the view can honour: ↑ and ↓
    // finish the step themselves (`keyboard/arrows.ts`).
    if (sel.main.goalColumn !== undefined && notAPlace(state, line.number)) return tr;
    // Clamped: a note arriving from Swift replaces the whole document, and the old caret can sit
    // past the end of the changeset it is mapped through.
    const from = tr.changes.mapPos(Math.min(tr.startState.selection.main.head, tr.changes.length));
    const target = placeFor(state, head, from, undefined);
    if (target === head) return tr;
    // The transaction again with its selection replaced — not `[tr, { selection }]`, whose second
    // spec CodeMirror would read against the *old* document and map through the first's changes.
    const annotations: Annotation<unknown>[] = [];
    const kinds: AnnotationType<any>[] = [Transaction.userEvent, Transaction.addToHistory, Transaction.time, Transaction.remote];
    for (const kind of kinds) {
      const value = tr.annotation(kind);
      if (value !== undefined) annotations.push(kind.of(value));
    }
    return {
      changes: tr.changes,
      selection: EditorSelection.cursor(target, undefined, undefined, sel.main.goalColumn),
      effects: tr.effects,
      annotations,
      scrollIntoView: tr.scrollIntoView,
    };
  });
}

/** The transaction again with its selection's ends at places (169); `caretPlaces` for a range. */
function placeRange(tr: Transaction): Transaction | TransactionSpec {
  const state = tr.state;
  const range = tr.newSelection.main;
  // ⌘A's whole note is the one range that keeps every byte, markers and all.
  if (range.from === 0 && range.to === state.doc.length) return tr;
  // A vertical extension carries a goal column; ⇧↑ and ⇧↓ finish their own step (`arrows.ts`).
  if (range.goalColumn !== undefined && notAPlace(state, state.doc.lineAt(range.head).number)) return tr;
  const before = tr.startState.selection.main;
  const mapped = (pos: number) => tr.changes.mapPos(Math.min(pos, tr.changes.length));
  const head = placeRangeEnd(state, range.head, mapped(before.head), range.anchor);
  const anchor = placeRangeEnd(state, range.anchor, mapped(before.anchor), head, false);
  if (head === range.head && anchor === range.anchor) return tr;
  return rebuilt(tr, anchor === head ? EditorSelection.cursor(head) : EditorSelection.range(anchor, head, range.goalColumn));
}

/** `tr` with its selection replaced, keeping its changes, effects and the annotations that matter. */
function rebuilt(tr: Transaction, selection: EditorSelection | SelectionRange): TransactionSpec {
  const annotations: Annotation<unknown>[] = [];
  const kinds: AnnotationType<any>[] = [Transaction.userEvent, Transaction.addToHistory, Transaction.time, Transaction.remote];
  for (const kind of kinds) {
    const value = tr.annotation(kind);
    if (value !== undefined) annotations.push(kind.of(value));
  }
  return { changes: tr.changes, selection, effects: tr.effects, annotations, scrollIntoView: tr.scrollIntoView };
}
