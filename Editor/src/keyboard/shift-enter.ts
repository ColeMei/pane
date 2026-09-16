/*
 * ⇧⏎, as a table — a newline that does not carry the markup forward.
 *
 * Order: get out of a code block, else leave an empty marker line (the same rows ⏎ uses, plus
 * CodeMirror outdenting an empty nested item), else a soft break that lines up under an item's text,
 * else CodeMirror's plain newline.
 *
 * The rules and the decisions behind them:
 *   1. ⇧⏎ inside a fence lands on the line after the closing fence, making one if needed (42)
 *   2. an empty marker line exits its block on ⇧⏎ exactly as on ⏎ (43)
 *   3. ⇧⏎ inside an item writes a soft break at the item's content column (108)
 */

import type { LineContext } from "./context";
import { delegateWhen, keyCommand } from "./context";
import { chain, rows, type KeyEdit } from "./edit";
import { continueMarkup, exitEmptyBlockquote, exitListToParagraph } from "./enter";

const INPUT = "input";

/** 1. Out of a fenced or indented code block, to the line below it. */
export function escapeCodeBlock(ctx: LineContext): KeyEdit | null {
  const block = ctx.caret.codeBlock;
  if (!block) return null;
  const doc = ctx.state.doc;
  const closing = doc.lineAt(Math.min(block.to, ctx.docLength));

  // Already the last line of the document: there is nowhere to go, so make somewhere.
  if (closing.number === ctx.docLines) {
    return { changes: [{ from: ctx.docLength, insert: "\n" }], anchor: ctx.docLength + 1, userEvent: INPUT, scrollIntoView: true };
  }
  // Land on the line below if it is free, and only add one when it is not.
  const next = doc.line(closing.number + 1);
  if (next.text.trim() === "") {
    return { changes: [], anchor: next.from, userEvent: "select", scrollIntoView: true };
  }
  return { changes: [{ from: closing.to, insert: "\n" }], anchor: closing.to + 1, userEvent: INPUT, scrollIntoView: true };
}

/** 2b. An empty *nested* item is CodeMirror's to outdent — the same command ⏎ uses. */
export const emptyNestedItem = (ctx: LineContext): boolean =>
  ctx.selectionEmpty && ctx.emptyItem && ctx.caret.inListItem;

/** 3. A soft break inside an item lands under the item's text, not at the margin. */
export function softBreakInListItem(ctx: LineContext): KeyEdit | null {
  if (!ctx.selectionEmpty || !ctx.caret.inListItem || ctx.caret.codeBlock) return null;
  const column = ctx.caret.itemContentColumn;
  if (column === null || column === 0) return null;
  const insert = `\n${" ".repeat(column)}`;
  return { changes: [{ from: ctx.head, to: ctx.head, insert }], anchor: ctx.head + insert.length, userEvent: INPUT, scrollIntoView: true };
}

export const shiftEnterExits = rows(escapeCodeBlock, exitEmptyBlockquote, exitListToParagraph);

export const shiftEnterKey = chain(
  keyCommand(shiftEnterExits),
  delegateWhen(emptyNestedItem, continueMarkup),
  keyCommand(softBreakInListItem)
);
