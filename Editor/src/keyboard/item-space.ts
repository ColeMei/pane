/*
 * A delete never leaves a space at the text start of an item with a block nested under it (203).
 *
 * `1. mid item` with ⌥⌦ before `mid` left `1.  item`: the second space moves the item's content
 * column one to the right, past its children's indent, and CommonMark takes them out of the item.
 * Nothing on screen says so until the renumbering writes the child's new number. So a delete that
 * starts at the text start of an item with a block nested under it takes the spaces it would leave
 * there. Everywhere else a space there changes nothing, and it stays, as in any text editor.
 */

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Transaction, type Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { lineTextStart, markerSpanEnd } from "../blocks";
import { one } from "./motion";

const LIST_LINE = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]/;

export function noSpaceAtItemStart(): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged || !tr.isUserEvent("delete")) return tr;
    const changes: { from: number; to: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
    if (changes.length !== 1) return tr;
    const { from, to, insert } = changes[0]!;
    if (insert || from === to) return tr;
    const state = tr.startState;
    const line = state.doc.lineAt(from);
    if (to > line.to || !LIST_LINE.test(line.text)) return tr;
    // The tree knows the marker, and the delete starts where the item's text does.
    const start = lineTextStart(state, line.number);
    if (from !== start || markerSpanEnd(state, line.number) !== start) return tr;
    if (!nestsBelow(state, line.to, start)) return tr;
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

/** The item whose text starts at `start` holds a block that starts below its first line. */
function nestsBelow(state: EditorState, lineEnd: number, start: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(start, -1); n; n = n.parent) {
    if (n.name !== "ListItem") continue;
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.from > lineEnd) return true;
    return false;
  }
  return false;
}
