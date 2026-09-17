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

import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { LineContext } from "./context";
import { delegateWhen, FENCE_OPENING, keyCommand } from "./context";
import { chain, rows, type KeyEdit } from "./edit";
import { fencesOf } from "../blocks";
import { continueMarkup, exitEmptyBlockquote, exitListToParagraph } from "./enter";

const INPUT = "input";

/**
 * 1. Out of a fenced or indented code block, onto a new empty line with a blank line between it
 * and the block — and a blank line between it and whatever follows.
 *
 * Always a new line, never the blank one that happened to be there (147): landing on an existing
 * blank line was a bare caret move, so decision 89 kept the line collapsed and the caret sat
 * squashed under the fence with the text then appearing 12px lower; and that line was the break
 * before the next paragraph, so what was typed there merged into it. An unclosed fence — one
 * whose closing line was typed on, `\`\`\`a` — is closed first with the opener's own fence string.
 */
export function escapeCodeBlock(ctx: LineContext): KeyEdit | null {
  if (!ctx.caret.codeBlock) return null;
  const doc = ctx.state.doc;
  let block: SyntaxNode | null = syntaxTree(ctx.state).resolveInner(ctx.head, -1);
  while (block && block.name !== "FencedCode" && block.name !== "CodeBlock") block = block.parent;
  if (!block) return null;

  const first = doc.lineAt(block.from);
  // An indented block has no fences and needs none; a fenced one is asked (`fencesOf`, not
  // `node.to`, which runs past the closing fence).
  const closed = block.name === "CodeBlock" || fencesOf(ctx.state, block).closed;
  // An unclosed block runs to the end of the note and has swallowed whatever was below the caret;
  // the closing fence goes under the caret's own line, and what follows is prose again.
  const last = closed ? doc.lineAt(Math.min(block.to, ctx.docLength)) : doc.line(ctx.line.number);

  const fence = closed ? "" : `\n${FENCE_OPENING.exec(first.text)?.[1] ?? "\`\`\`"}`;
  const below = last.number < ctx.docLines ? doc.line(last.number + 1) : null;
  const separator = below && below.text.trim() !== "" ? "\n" : "";
  const insert = `${fence}\n\n${separator}`;
  return { changes: [{ from: last.to, insert }], anchor: last.to + fence.length + 2, userEvent: INPUT, scrollIntoView: true };
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
