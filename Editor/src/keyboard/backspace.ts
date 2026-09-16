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
 *   2. join back to paragraph    — a paragraph break is deleted, not halved (90)
 *   3. leave or outdent an item  — ⌫ at an item's text start outdents, or drops the marker (108, 109)
 *   4. delete a typed marker     — a marker somebody typed loses one character, not the line (109)
 */

import type { LineContext } from "./context";
import { rows, type KeyEdit } from "./edit";
import { outdentEdit } from "../list-indent";

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

const table = rows(undoMarkerBreak, joinBackToParagraph, unindentListItem, deleteTypedMarker);

export function backspace(ctx: LineContext): KeyEdit | null {
  return ctx.selectionEmpty ? table(ctx) : null;
}
