/*
 * ⇥ and ⇧⇥, as tables.
 *
 * In a list item, ⇥ nests the item under the sibling above it and ⇧⇥ backs it out a level — the
 * whole item, continuation lines and children included — and when neither applies the key is
 * *consumed*: ⇥ on a list's first item does nothing, because handing it on to CodeMirror's
 * `indentMore` writes four spaces, and four spaces under a blank line is an indented code block to
 * every markdown tool (decision 109). Outside a list the key is CodeMirror's.
 *
 *   ⇥  nests to the sibling's content column: 2 under `- `, 3 under `1. ` (108)
 *   ⇧⇥ backs out to the parent's indent, children coming with it (108)
 */

import { indentEdit, outdentEdit } from "../list-indent";
import type { LineContext } from "./context";
import { NOOP, type KeyEdit } from "./edit";

const inItem = (ctx: LineContext): boolean => ctx.caret.itemContentColumn !== null;

export function tab(ctx: LineContext): KeyEdit | null {
  if (!inItem(ctx)) return null;
  return indentEdit(ctx.state, ctx.head) ?? NOOP;
}

export function shiftTab(ctx: LineContext): KeyEdit | null {
  if (!inItem(ctx)) return null;
  return outdentEdit(ctx.state, ctx.head) ?? NOOP;
}
