/*
 * ⌦ — one row: a line that is not a place cannot be pulled up into the line above it.
 *
 * Forward-deleting the newline before a fence line or a rule would join the fence's backticks onto
 * the end of the text — visible nowhere, since block markers never show (151) — and unbound the
 * block. So at a line end whose next line is a fence or a rule, ⌦ does nothing. The paragraph
 * break stays deletable: pulling a blank line up is how you close a gap.
 */

import type { LineContext } from "./context";
import { NOOP, type KeyEdit } from "./edit";
import { fenceOrRuleLine } from "../blocks";

export function deleteForward(ctx: LineContext): KeyEdit | null {
  if (!ctx.selectionEmpty || !ctx.atLineEnd || ctx.line.number >= ctx.docLines) return null;
  return fenceOrRuleLine(ctx.state, ctx.line.number + 1) ? NOOP : null;
}
