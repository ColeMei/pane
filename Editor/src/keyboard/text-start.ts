/*
 * A delete never leaves a space at a text start where it does harm (203).
 *
 * `1. mid item` with ⌥⌦ before `mid` left `1.  item`: the second space moves the item's content
 * column past its children's indent, and CommonMark takes them out of the item. And after a
 * heading's hashes, a quote's `>` or a bullet, every space is hidden with the marker (`decorate.ts`),
 * so the caret cannot rest before it and the next letter lands after it: `##  Qwords`. In both, a
 * delete that starts at the text start takes the spaces it would leave there. A number's, a task
 * box's and a paragraph's spaces are drawn, and stay, as in any text editor; code's are code.
 */

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { markerSpanEnd } from "../blocks";
import { one } from "./motion";

export function noSpaceAtTextStart(): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged || !tr.isUserEvent("delete")) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
    if (changes.length !== 1) return tr;
    const { from, to, insert } = changes[0]!;
    if (insert || from === to) return tr;
    const state = tr.startState;
    const line = state.doc.lineAt(from);
    if (to > line.to || from !== markerSpanEnd(state, line.number)) return tr;
    const mark = lastMark(state, line.from, from);
    if (!mark || !(hidesSpaces(state, mark) || nestsBelow(mark, line.to))) return tr;
    const spaces = /^[ \t]+/.exec(state.doc.sliceString(to, line.to))?.[0].length ?? 0;
    if (!spaces || to + spaces === line.to) return tr;
    return {
      changes: { from, to: to + spaces },
      selection: one(EditorSelection.cursor(from)),
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: true,
    };
  });
}

/** The block mark nearest before the text start, if the line has one. */
function lastMark(state: EditorState, lineFrom: number, start: number): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    from: lineFrom,
    to: start,
    enter(node) {
      if (["HeaderMark", "QuoteMark", "ListMark", "TaskMarker"].includes(node.name) && node.to <= start)
        if (!found || node.from > found.from) found = node.node;
    },
  });
  return found;
}

/** A heading's hashes, a quote's `>` and a bullet hide every space after them (`decorate.ts`). */
function hidesSpaces(state: EditorState, mark: SyntaxNode): boolean {
  if (mark.name === "HeaderMark" || mark.name === "QuoteMark") return true;
  return mark.name === "ListMark" && !/\d/.test(state.doc.sliceString(mark.from, mark.to));
}

/** The item this mark starts holds a block that starts below its first line. */
function nestsBelow(mark: SyntaxNode, lineEnd: number): boolean {
  for (let n: SyntaxNode | null = mark; n; n = n.parent) {
    if (n.name !== "ListItem") continue;
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.from > lineEnd) return true;
    return false;
  }
  return false;
}
