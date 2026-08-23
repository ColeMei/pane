/*
 * Ordered lists that count.
 *
 * Pane draws the number the buffer holds rather than rendering one, so a list that says 1, 3, 4
 * after you delete an item says 1, 3, 4 forever — there is no renderer to quietly fix it, and
 * retyping the markers by hand is the only cure. Every editor anyone has used renumbers instead.
 *
 * **This shipped once and was pulled, and the reason is the whole design of this file.** The first
 * version was a transaction filter that appended corrections to any transaction touching a list.
 * Undo is such a transaction: the appended changes were computed against the document the history
 * was reconstructing, so positions valid for one document were applied to another. It went out
 * with a note saying it comes back once undo is in the editor matrix, which it now is.
 *
 * The rule that came out of that: **a filter that writes to the document has to say which
 * transactions it is *for*, not which it is against.** `isEdit` below is that list, and it is an
 * allow-list of user edits — everything else, including undo, redo, a note load and an external
 * reload, falls straight through untouched.
 *
 * Two more things it has to get right, both from decision 81:
 *
 *   - **A run keeps its first number when the author chose it.** `5. 6. 7.` stays at 5. Only the
 *     items *after* the first are ever made to follow.
 *   - **It restarts at 1 when it is only first because the item above it stopped being one.**
 *     Deleting `1. a` from `1. a / 2. b / 3. c` leaves a list starting at 2, which is not a choice
 *     anybody made. Telling those apart needs the document *before* the change, which is why the
 *     start number is decided by mapping back through `tr.changes` rather than by reading the new
 *     document harder.
 *
 * And it reads the tree, like every other command since decision 78 — not because the tree is
 * tidier but because `1. one` inside a fenced code block is a line of code, and a line scan that
 * renumbered it would be corrupting the one thing decision 5 protects.
 */

import { syntaxTree } from "@codemirror/language";
import { EditorState, Transaction, type Extension } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

/** The whole of an ordered item's marker, `1.` or `1)` — which is exactly what `ListMark` covers. */
const MARKER = /^(\d+)[.)]$/;

/**
 * The transactions this extension is *for*: edits a person made.
 *
 * Not "everything that changes the document". Undo and redo change the document; so does opening a
 * note, and so does an external reload arriving from the file watcher. Each of those is the
 * document being *restored* to something, and appending corrections to a restoration is how this
 * broke the first time.
 */
function isEdit(tr: Transaction): boolean {
  // Loading a note and reloading it from disk both carry this, for undo's sake (decision 80). It
  // does a second job here: neither is an edit, and neither should be renumbered.
  if (tr.annotation(Transaction.addToHistory) === false) return false;
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return false;
  return tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move");
}

/** The outermost `OrderedList` at or above this node, or null if it is not in one. */
function outermostList(node: SyntaxNode | null): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let n = node; n; n = n.parent) if (n.name === "OrderedList") found = n;
  return found;
}

/**
 * Every ordered list the change could have disturbed.
 *
 * Both directions matter and neither is enough alone. Walking *up* from the edit catches the
 * ordinary case — an item deleted from the middle of a list, where the list itself extends far
 * beyond the range that changed. Iterating *over* the range catches a list that arrived with the
 * change (a paste) and, more importantly, the list left *behind* one: replacing the middle item of
 * `1. a / 2. b / 3. c` with a paragraph splits it in two, and the second half is a list the edit
 * never touched a character of.
 *
 * The range is widened to whole lines and one line either side for the same reason — a change that
 * ends just before a list's first line is exactly the change that orphaned it.
 */
function listsTouching(tree: Tree, state: EditorState, from: number, to: number): SyntaxNode[] {
  const doc = state.doc;
  const first = doc.line(Math.max(1, doc.lineAt(from).number - 1));
  const last = doc.line(Math.min(doc.lines, doc.lineAt(to).number + 1));

  const found: SyntaxNode[] = [];
  const add = (node: SyntaxNode | null): void => {
    if (!node) return;
    if (found.some((other) => other.from === node.from && other.to === node.to)) return;
    found.push(node);
  };

  for (const pos of [first.from, from, to, last.to]) {
    add(outermostList(tree.resolveInner(pos, -1)));
    add(outermostList(tree.resolveInner(pos, 1)));
  }

  tree.iterate({
    from: first.from,
    to: last.to,
    enter: (node) => {
      if (node.name !== "OrderedList") return true;
      add(outermostList(node.node));
      return false;
    },
  });

  return found;
}

/** The `ListItem` children of a list, in document order. Nested lists live inside these. */
function itemsOf(list: SyntaxNode): SyntaxNode[] {
  const items: SyntaxNode[] = [];
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListItem") items.push(child);
  }
  return items;
}

/**
 * Whether this item is first only because whatever was above it stopped being an item.
 *
 * Answered in the document *before* the change, because that is the only place the difference
 * exists: `5. a` at the head of a run and `5. a` left at the head of a run both look identical
 * afterwards. Map the item's position back through the change, and ask whether it had an item
 * above it then.
 *
 * The bias is `1`, and it is the difference between this working and not. Deleting the first line
 * of a list leaves the second line starting at the offset the deletion began, and mapping that
 * offset back with the default bias lands *before* the restored text — on the item that was just
 * deleted, which was run-first, so the reset never fires. Biased forward it lands after it, on the
 * item that really was second.
 *
 * A position that maps back to something which was not a list item at all — a line just typed —
 * is not a demotion and gets left alone, which is what stops it rewriting `5. ` to `1. ` under
 * the fingers of somebody typing `5. `.
 */
function becameFirst(tr: Transaction, item: SyntaxNode): boolean {
  const before = tr.startState;
  const back = tr.changes.invert(before.doc).mapPos(item.from, 1);
  if (back < 0 || back > before.doc.length) return false;

  let node: SyntaxNode | null = syntaxTree(before).resolveInner(back, 1);
  for (; node; node = node.parent) if (node.name === "ListItem") break;
  if (!node || node.parent?.name !== "OrderedList") return false;

  for (let sibling = node.prevSibling; sibling; sibling = sibling.prevSibling) {
    if (sibling.name === "ListItem") return true;
  }
  return false;
}

/**
 * An item's marker node.
 *
 * Read from the tree rather than off the head of the line, because **`ListItem` starts at the line
 * start, not at the marker** — so an indented item's text begins `"   1. x"` and a regex anchored
 * at the item's own offset matches nothing. The first version of this file did exactly that, and
 * the failure was silent in the way this codebase specialises in: top-level lists renumbered
 * perfectly and nested ones were left alone with no error anywhere.
 */
function markOf(item: SyntaxNode): SyntaxNode | null {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListMark") return child;
  }
  return null;
}

/** Corrections for one list and every list nested inside it. */
function correct(
  tr: Transaction,
  state: EditorState,
  list: SyntaxNode,
  changes: { from: number; to: number; insert: string }[]
): void {
  const items = itemsOf(list);
  if (items.length === 0) return;

  const doc = state.doc;
  const firstMark = markOf(items[0]!);
  const head = firstMark && MARKER.exec(doc.sliceString(firstMark.from, firstMark.to));
  if (!head) return;

  const start = becameFirst(tr, items[0]!) ? 1 : Number(head[1]);

  items.forEach((item, index) => {
    const mark = markOf(item);
    const marker = mark && MARKER.exec(doc.sliceString(mark.from, mark.to));
    // Not an ordered marker after all — a bullet, or a stale tree. Writing digits over text that
    // never had any is the one way this could damage a note, so it declines instead.
    if (mark && marker) {
      const want = String(start + index);
      if (marker[1] !== want) {
        changes.push({ from: mark.from, to: mark.from + marker[1]!.length, insert: want });
      }
    }

    for (let child = item.firstChild; child; child = child.nextSibling) {
      if (child.name === "OrderedList") correct(tr, state, child, changes);
    }
  });
}

/**
 * The extension.
 *
 * The corrections come back as a *second spec on the same transaction*, not as a follow-up
 * dispatch. That is what makes one ⌘Z undo the edit and its renumbering together rather than
 * leaving the list rewritten and the typing reversed.
 */
export function renumberOrderedLists(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !isEdit(tr)) return tr;

    const state = tr.state;
    const tree = syntaxTree(state);
    const changes: { from: number; to: number; insert: string }[] = [];
    const done: number[] = [];

    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      for (const list of listsTouching(tree, state, fromB, toB)) {
        if (done.includes(list.from)) continue;
        done.push(list.from);
        correct(tr, state, list, changes);
      }
    });

    if (changes.length === 0) return tr;
    // `sequential` because these offsets are in the document the transaction produces, not the one
    // it started from.
    return [tr, { changes, sequential: true }];
  });
}
