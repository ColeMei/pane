/*
 * ⌫, as a table.
 *
 * Rows in the order they are tried; the first that applies wins. A row that returns null passes the
 * key on. Nothing below applies to a non-empty selection — that is a plain delete and CodeMirror's.
 * When no row applies the key falls through to CodeMirror's `deleteMarkupBackward` and then to
 * `deleteCharBackward` (see the keymap in `main.ts`), which is what handles `> |text` and a
 * one-character delete.
 *
 * The rules and the decisions behind them:
 *   1. undo a marker break       — a ⏎ that made a marker-only line is undone whole (90, 108)
 *   1b. undo a soft break        — the whitespace-only line ⇧⏎ left goes the same way (144)
 *   2. join back to paragraph    — a paragraph break is deleted, not halved (90)
 *   3. leave or outdent an item  — ⌫ at an item's text start outdents, or drops the marker (108, 109)
 *   4. delete a typed marker     — a marker somebody typed loses one character, not the line (109)
 *   5. off a heading             — ⌫ at a heading's text start makes it a paragraph (151)
 *   6. out of a code block       — ⌫ at the start of an empty block removes it; with code, nothing (151)
 *   7. into a code block         — ⌫ at the start of the line after a block steps into its last line (151)
 *   8. delete a rule             — ⌫ at the start of the line after a rule takes the rule (151)
 */

import type { LineContext } from "./context";
import { NOOP, rows, type KeyEdit } from "./edit";
import { outdentEdit } from "../list-indent";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { fencedBlockAt, fenceOrRuleLine, fencesOf } from "../blocks";

const DELETE = "delete.backward";

/** 1. A line holding only a marker, made by ⏎ under the same block: take the ⏎ back. */
function undoMarkerBreak(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineEnd || !ctx.above) return null;
  const quote = ctx.quoteOnly;
  if (!quote && !ctx.emptyItem) return null;
  const continued = quote ? ctx.above.quoteContinued : ctx.above.listContinued;
  if (!continued) return null;
  const aboveEnd = ctx.line.from - 1;
  return { changes: [{ from: aboveEnd, to: ctx.line.to }], anchor: aboveEnd, userEvent: DELETE };
}

/** 1b. A whitespace-only line ⇧⏎ left in an item: take the ⇧⏎ back, not one invisible space (144). */
function undoSoftBreak(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineEnd || ctx.line.length === 0 || ctx.line.text.trim() !== "") return null;
  if (!ctx.inListItem || ctx.listMarker) return null;
  const aboveEnd = ctx.line.from - 1;
  return { changes: [{ from: aboveEnd, to: ctx.line.to }], anchor: aboveEnd, userEvent: DELETE };
}

/** 2. A caret at the start of a line under a blank one, or on the blank line itself: delete the break. */
function joinBackToParagraph(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineStart || ctx.inCode) return null;
  const { line, above, below } = ctx;

  // Under a blank line: the break is the two newlines before the caret. Line 3 at the earliest,
  // because the deletion starts at the newline before the blank line.
  if (line.number >= 3 && above && above.length === 0) {
    const from = line.from - 2;
    return { changes: [{ from, to: ctx.head }], anchor: from, userEvent: DELETE };
  }

  // On the blank line between two paragraphs: both newlines go.
  if (
    line.length === 0 &&
    line.number >= 2 &&
    line.number < ctx.docLines &&
    above && above.length !== 0 &&
    below && below.length !== 0
  ) {
    const from = line.from - 1;
    return { changes: [{ from, to: line.to + 1 }], anchor: from, userEvent: DELETE };
  }
  return null;
}

/** 3. At the start of an item's text: outdent a nested item, or take the outermost out of the list. */
function unindentListItem(ctx: LineContext): KeyEdit | null {
  const marker = ctx.listMarker;
  if (!marker || !marker.hasText || !ctx.inListItem) return null;
  if (ctx.head !== ctx.line.from + marker.contentColumn) return null;

  if (marker.indent > 0) return outdentEdit(ctx.state, ctx.head);

  // Outermost level: drop the marker, and keep a blank line between it and a paragraph above so
  // the text does not become that paragraph's continuation.
  const blank = ctx.above !== null && !ctx.above.blank;
  return {
    changes: [{ from: ctx.line.from, to: ctx.head, insert: blank ? "\n" : "" }],
    anchor: ctx.line.from + (blank ? 1 : 0),
    userEvent: DELETE,
  };
}

/** 4. A marker somebody typed (row 1 has already claimed the ones a ⏎ made): one character. */
function deleteTypedMarker(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineEnd || !ctx.typedMarkerOnly) return null;
  // An explicit change rather than `deleteCharBackward`, which skips the rendered marker's atomic range.
  return { changes: [{ from: ctx.head - 1, to: ctx.head }], anchor: ctx.head - 1, userEvent: DELETE };
}

/** 5. At a heading's text start: the hashes come off, and the line is a paragraph. */
function removeHeadingMarks(ctx: LineContext): KeyEdit | null {
  const marks = /^[ \t]*#{1,6}[ \t]+/.exec(ctx.line.text);
  if (!marks || ctx.head !== ctx.line.from + marks[0].length) return null;
  let node: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.line.from, 1);
  while (node && !/^ATXHeading/.test(node.name)) node = node.parent;
  if (!node) return null;
  return { changes: [{ from: ctx.line.from, to: ctx.head }], anchor: ctx.line.from, userEvent: DELETE };
}

/** 6. At the start of a block's first line of code: an empty block goes whole; one with code stays. */
function leaveEmptyCodeBlock(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineStart || !ctx.caret.codeBlock || ctx.line.number < 2) return null;
  const block = fencedBlockAt(ctx.state, ctx.head);
  if (!block) return null;
  const doc = ctx.state.doc;
  const { first, last, closed } = fencesOf(ctx.state, block);
  if (first !== ctx.line.number - 1) return null;
  // Nothing in it: the block goes, opening fence, closing fence and the line between.
  if (ctx.line.length === 0 && (closed ? last === ctx.line.number + 1 : last === ctx.line.number)) {
    const to = closed ? doc.line(last).to : ctx.line.to;
    return { changes: [{ from: doc.line(first).from, to }], anchor: doc.line(first).from, userEvent: DELETE };
  }
  // With code in it, there is nowhere to go: the fence above is not a place (151).
  return NOOP;
}

/** 7. At the start of the line after a closed block: step into the block's last line of code. */
function stepIntoCodeBlock(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineStart || ctx.line.number < 2 || ctx.caret.codeBlock) return null;
  const doc = ctx.state.doc;
  const block = fencedBlockAt(ctx.state, doc.line(ctx.line.number - 1).from, 1);
  if (!block) return null;
  const { first, last, closed } = fencesOf(ctx.state, block);
  if (!closed || last !== ctx.line.number - 1) return null;
  // An empty block: rule 6 owns it from the inside, and from here there is nothing to step to.
  if (last - first < 2) return NOOP;
  return { changes: [], anchor: doc.line(last - 1).to, userEvent: "select" };
}

/** 8. At the start of the line after a rule: the rule goes. */
function deleteRuleAbove(ctx: LineContext): KeyEdit | null {
  if (!ctx.atLineStart || ctx.line.number < 2) return null;
  const above = ctx.state.doc.line(ctx.line.number - 1);
  if (!fenceOrRuleLine(ctx.state, above.number) || !/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(above.text)) return null;
  return { changes: [{ from: above.from, to: ctx.line.from }], anchor: above.from, userEvent: DELETE };
}

const table = rows(
  undoMarkerBreak, undoSoftBreak, joinBackToParagraph, unindentListItem, deleteTypedMarker,
  removeHeadingMarks, leaveEmptyCodeBlock, stepIntoCodeBlock, deleteRuleAbove
);

export function backspace(ctx: LineContext): KeyEdit | null {
  return ctx.selectionEmpty ? table(ctx) : null;
}
