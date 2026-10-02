/*
 * ⇥ and ⇧⇥, as tables.
 *
 * In a list item, ⇥ nests the item under the sibling above it and ⇧⇥ backs it out a level — the
 * whole item, continuation lines and children included — and when neither applies the key is
 * *consumed*: ⇥ on a list's first item does nothing, because handing it on to CodeMirror's
 * `indentMore` writes four spaces, and four spaces under a blank line is an indented code block to
 * every markdown tool (decision 109).
 *
 * Outside a list the same four spaces were the fault (179): CodeMirror's `indentMore` indents the
 * whole line, the spaces before a heading's hashes or a quote's `>` are never drawn (151), and two
 * presses made any heading, quote or paragraph an indented code block. So outside a list and code,
 * ⇥ is consumed. In code it indents at the caret, to the next two-column stop, as a code editor
 * does; with a selection there it is still CodeMirror's, which indents the lines.
 *
 *   ⇥  nests to the sibling's content column: 2 under `- `, 3 under `1. ` (108)
 *   ⇧⇥ backs out to the parent's indent, children coming with it (108)
 *   ⇥  writes nothing in a heading, a quote or a paragraph; in code, spaces at the caret (179)
 */

import { indentEdit, outdentEdit } from "../list-indent";
import type { LineContext } from "./context";
import { NOOP, type KeyEdit } from "./edit";

const inItem = (ctx: LineContext): boolean => ctx.caret.itemContentColumn !== null;

export function tab(ctx: LineContext): KeyEdit | null {
  if (inItem(ctx)) return indentEdit(ctx.state, ctx.head) ?? NOOP;
  if (!ctx.inCode) return NOOP;
  if (!ctx.selectionEmpty) return null;
  const spaces = 2 - ((ctx.head - ctx.line.from) % 2);
  return { changes: [{ from: ctx.head, insert: " ".repeat(spaces) }], anchor: ctx.head + spaces, userEvent: "input.indent" };
}

export function shiftTab(ctx: LineContext): KeyEdit | null {
  if (!inItem(ctx)) return null;
  return outdentEdit(ctx.state, ctx.head) ?? NOOP;
}
