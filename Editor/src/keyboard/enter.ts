/*
 * ⏎, as a table — with one CodeMirror command in the middle of it.
 *
 * Order: leave an empty quote level, close an open fence, leave an empty top-level item, then
 * CodeMirror's `insertNewlineContinueMarkup` carries a list or quote forward, and what it declines
 * — prose — starts a new paragraph. The CodeMirror link stays a link because its decline depends on
 * things only it computes; the rows either side of it are pure.
 *
 * The rules and the decisions behind them:
 *   1. an empty marker line exits its block, a quote one level at a time, keeping the typed style (43)
 *   2. ⏎ at an opening fence writes the closing one (108)
 *   3. leaving a list leaves one blank line, adding one only when there is not one already (108)
 *   4. `nonTightLists: false` — CodeMirror's own Enter would make the list loose instead of exiting it
 *   5. ⏎ starts a paragraph, `\n\n`, and one `\n` when the line being left is already blank (63)
 */

import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import type { LineContext } from "./context";
import { keyCommand } from "./context";
import { chain, rows, type KeyEdit } from "./edit";

const INPUT = "input";

/** Built once; ⇧⏎ delegates to the same command, so the two keys cannot drift apart. */
export const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Replace a marker-only line with nothing, leaving one blank line to the block below (108). */
export function leaveBlock(ctx: LineContext): KeyEdit {
  const insert = ctx.below && ctx.below.blank ? "" : "\n";
  return {
    changes: [{ from: ctx.line.from, to: ctx.line.to, insert }],
    anchor: ctx.line.from + 1,
    userEvent: INPUT,
    scrollIntoView: true,
  };
}

/** 1. A line of nothing but `>`s inside a quote: one level comes off, or the last one leaves the block. */
export function exitEmptyBlockquote(ctx: LineContext): KeyEdit | null {
  if (!ctx.selectionEmpty || !ctx.quoteOnly || !ctx.caret.inBlockquote) return null;
  const marks = ctx.quoteMarks;
  const outer = marks.slice(0, marks.lastIndexOf(">")).replace(/[ \t]+$/, "");
  if (!outer) return leaveBlock(ctx);
  const next = `${ctx.line.text.slice(0, ctx.indent)}${outer} `;
  return {
    changes: [{ from: ctx.line.from, to: ctx.line.to, insert: next }],
    anchor: ctx.line.from + next.length,
    userEvent: INPUT,
  };
}

/** 2. ⏎ at the end of an opening fence with no closing one: write it, caret on the line between. */
export function closeOpenFence(ctx: LineContext): KeyEdit | null {
  if (!ctx.selectionEmpty || !ctx.atLineEnd || !ctx.fenceOpening || !ctx.fenceUnclosed) return null;
  return {
    changes: [{ from: ctx.line.to, insert: `\n\n${ctx.fenceOpening}` }],
    anchor: ctx.line.to + 1,
    userEvent: INPUT,
    scrollIntoView: true,
  };
}

/** 3. An empty top-level item leaves the list. A nested one is CodeMirror's: it outdents a level. */
export function exitListToParagraph(ctx: LineContext): KeyEdit | null {
  if (!ctx.selectionEmpty || !ctx.emptyItem || ctx.startsQuote) return null;
  if (!ctx.inListItem || ctx.nestedItem) return null;
  return leaveBlock(ctx);
}

/** 5. In prose, ⏎ is a paragraph break. Declines inside any block where a newline must stay one. */
export function newParagraph(ctx: LineContext): KeyEdit | null {
  if (ctx.caret.notProse) return null;
  const insert = ctx.before.trim() === "" ? "\n" : "\n\n";
  return {
    changes: [{ from: ctx.selection.from, to: ctx.selection.to, insert }],
    anchor: ctx.selection.from + insert.length,
    userEvent: INPUT,
    scrollIntoView: true,
  };
}

export const enterExits = rows(exitEmptyBlockquote, closeOpenFence, exitListToParagraph);

export const enterKey = chain(keyCommand(enterExits), continueMarkup, keyCommand(newParagraph));
