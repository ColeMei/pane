/*
 * A construct's markers are not a stop and not a character — decision 177.
 *
 * While the caret is in `**bold words**` its markers are drawn, and each is an atom (57, 168). So
 * each edge had two caret positions, outside the marker and between it and the text; word motion
 * took `**` and `](` for words; ⇧→ selected a bare `**`; and ⌦, ⌫ and typing over a selection took
 * one marker and left its partner on screen as literal asterisks. Typora never stops between a
 * marker and its text, and no key there takes half a pair.
 *
 * Two rules, in this file:
 *   1. **A seam is not a stop.** →, ←, ⌥→ and ⌥←, with or without ⇧, that land between a marker
 *      and its text, or between two markers, take one more step the same way. So → from before
 *      `**bold` lands after its first letter, and ⌥→ from inside its last word lands after it.
 *   2. **A delete keeps pairs.** A deletion that takes one marker of a construct and not the other
 *      keeps both; ⌫ and ⌦ against a marker reach past it to the text. What a delete leaves is
 *      never broken: a construct emptied of text goes whole, a space it would now start or end
 *      with goes too (`** words**` is not bold, as 171 found), and two of the same kind that a
 *      deletion brings together become one. Every way text is deleted goes through rule 2 as a
 *      filter, so typing over a selection, ⌘X and ⌘⌫ keep pairs as the keys do.
 *
 * The bytes a delete takes are ones the person asked to remove; nothing here writes one (158).
 */

import { ChangeSet, EditorSelection, EditorState, type Extension, type SelectionRange, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markerSpanEnd } from "../blocks";
import type { Command } from "./edit";
import { isSeam, spansIn, type Span } from "./spans";

interface Region {
  from: number;
  to: number;
}

const overlaps = (r: Region, from: number, to: number): boolean => from < r.to && to > r.from && r.to > r.from;

/** `range` with `holes` taken out of it, in order. */
function subtract(range: Region, holes: Region[]): Region[] {
  let pieces: Region[] = [range];
  for (const hole of holes) {
    pieces = pieces.flatMap((p) => {
      if (hole.to <= p.from || hole.from >= p.to) return [p];
      return [{ from: p.from, to: hole.from }, { from: hole.to, to: p.to }].filter((q) => q.to > q.from);
    });
  }
  return pieces;
}

/** Sorted, with overlapping and touching regions joined. */
function merged(regions: Region[]): Region[] {
  const out: Region[] = [];
  for (const r of [...regions].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

const markers = (s: Span): [Region, Region] => [{ from: s.from, to: s.textFrom }, { from: s.textTo, to: s.to }];

/**
 * What deleting `from..to` (and inserting `insert` in its place) takes once rule 2 has had its say,
 * or null when that is exactly `from..to`. `insertAt` is where the insert lands.
 */
export function keptDeletion(state: EditorState, from: number, to: number, insert: string):
  { deletions: Region[]; insertAt: number } | null {
  const doc = state.doc;
  const spans = spansIn(state, from, to).filter((s) => !(from <= s.from && to >= s.to));
  const cut = spans.filter((s) => markers(s).some((m) => overlaps(m, from, to)));
  const pieces = subtract({ from, to }, cut.flatMap(markers));
  if (pieces.length === 0 && insert !== "") return null;

  const deleted = (pos: number) => pieces.some((p) => pos >= p.from && pos < p.to);
  const extra: Region[] = [];
  if (insert === "") {
    for (const s of spans) {
      if (!pieces.some((p) => overlaps({ from: s.textFrom, to: s.textTo }, p.from, p.to))) continue;
      let first = s.textFrom;
      while (first < s.textTo && deleted(first)) first++;
      let last = s.textTo;
      while (last > first && deleted(last - 1)) last--;
      if (first >= last) { extra.push({ from: s.from, to: s.to }); continue; }
      const space = (pos: number) => /\s/.test(doc.sliceString(pos, pos + 1));
      if (!space(s.textFrom)) { let p = first; while (p < last && space(p)) p++; if (p > first) extra.push({ from: first, to: p }); }
      if (!space(s.textTo - 1)) { let p = last; while (p > first && space(p - 1)) p--; if (p < last) extra.push({ from: p, to: last }); }
    }
  }

  // Two of the same kind brought together by the deletion become one: `**a**` + `**b**` → `**ab**`.
  let deletions = merged([...pieces, ...extra]);
  const gone = (r: Region) => r.to <= r.from || deletions.some((d) => r.from >= d.from && r.to <= d.to);
  for (const a of cut) {
    for (const b of cut) {
      if (a === b || a.to > b.from) continue;
      const [, close] = markers(a);
      const [open] = markers(b);
      if (gone(close) || gone(open) || !gone({ from: a.to, to: b.from })) continue;
      if (doc.sliceString(close.from, close.to) !== doc.sliceString(open.from, open.to)) continue;
      deletions = merged([...deletions, close, open]);
    }
  }

  const insertAt = pieces[0]?.from ?? from;
  if (deletions.length === 1 && deletions[0]!.from === from && deletions[0]!.to === to) return null;
  return { deletions, insertAt };
}

/** The changes for a plan, with the insert at its place. */
function changesOf(plan: { deletions: Region[]; insertAt: number }, insert: string) {
  const changes: { from: number; to?: number; insert?: string }[] = plan.deletions.map((d) => ({ from: d.from, to: d.to }));
  if (insert) changes.push({ from: plan.insertAt, insert });
  return changes;
}

/** Rule 2 as a filter, for every deletion a person makes: the keys, typing over a selection, ⌘X. */
export function keepPairs(): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged) return tr;
    if (!tr.isUserEvent("input.type") && !tr.isUserEvent("input.paste") && !tr.isUserEvent("delete")) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
    if (changes.length !== 1) return tr;
    const { from, to, insert } = changes[0]!;
    if (from === to) return tr;
    // Only a deletion made at the caret or of the selection: an input rule rewriting text elsewhere
    // is its own business.
    const before = tr.startState.selection.main;
    const ofSelection = from === before.from && to === before.to;
    const atCaret = before.empty && (from === before.head || to === before.head);
    if (!ofSelection && !atCaret) return tr;
    const plan = keptDeletion(tr.startState, from, to, insert);
    if (!plan) return tr;
    const set = ChangeSet.of(changesOf(plan, insert), tr.startState.doc.length);
    const anchor = insert ? set.mapPos(plan.insertAt, 1) : set.mapPos(ofSelection ? before.from : before.head, -1);
    return {
      changes: set,
      selection: EditorSelection.cursor(anchor),
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: true,
    };
  });
}

/** One step from `start`, and on past any seam (rule 1). */
function step(view: EditorView, start: SelectionRange, forward: boolean, group: boolean): number {
  const move = (r: SelectionRange) => (group ? view.moveByGroup(r, forward) : view.moveByChar(r, forward));
  let next = move(start);
  for (let i = 0; i < 16 && next.head !== start.head && isSeam(view.state, next.head); i++) {
    const after = move(next);
    if (after.head === next.head) break;
    next = after;
  }
  return next.head;
}

/** →, ←, ⌥→ and ⌥←, and with `extend`, their ⇧ forms. A caret with a selection collapses as before. */
export function moveOverSeams(forward: boolean, group: boolean, extend: boolean): Command {
  return (view) => {
    const range = view.state.selection.main;
    if (!range.empty && !extend) return false;
    const head = step(view, EditorSelection.cursor(range.head), forward, group);
    if (head === range.head) return false;
    view.dispatch({
      selection: extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head, forward ? -1 : 1),
      userEvent: "select",
      scrollIntoView: true,
    });
    return true;
  };
}

/**
 * ⌫ and ⌦, and ⌥⌫ and ⌥⌦, where the step meets a marker: the delete reaches past it to the text.
 * Where only markers lie between the caret and the line's text edge, the key is what it is at that
 * edge (`atEdge`), so ⌫ just inside `**` at a paragraph's start joins the paragraph above, as ⌫ at
 * its text start does.
 */
export function deleteOverMarks(forward: boolean, group: boolean, atEdge: Command): Command {
  return (view) => {
    const state = view.state;
    const range = state.selection.main;
    if (!range.empty) return false;
    const line = state.doc.lineAt(range.head);
    const edge = forward ? line.to : markerSpanEnd(state, line.number);
    const between = (t: number): Region => (forward ? { from: range.head, to: t } : { from: t, to: range.head });
    const meetsMarker = (r: Region) => spansIn(state, r.from, r.to).some((s) => markers(s).some((m) => overlaps(m, r.from, r.to)));

    let target = step(view, EditorSelection.cursor(range.head), forward, group);
    if (target === range.head || !meetsMarker(between(target))) return false;
    for (let i = 0; i < 4; i++) {
      const reached = forward ? target >= edge : target <= edge;
      const { from, to } = between(reached ? edge : target);
      const plan = keptDeletion(state, from, to, "") ?? { deletions: [{ from, to }], insertAt: from };
      if (plan.deletions.length > 0) {
        const set = ChangeSet.of(changesOf(plan, ""), state.doc.length);
        view.dispatch({
          changes: set,
          selection: EditorSelection.cursor(set.mapPos(range.head, -1)),
          userEvent: forward ? "delete.forward" : "delete.backward",
          scrollIntoView: true,
        });
        return true;
      }
      if (reached) {
        view.dispatch({ selection: { anchor: edge }, userEvent: "select" });
        atEdge(view);
        return true;
      }
      const next = step(view, EditorSelection.cursor(target), forward, group);
      if (next === target) return true;
      target = next;
    }
    return true;
  };
}
