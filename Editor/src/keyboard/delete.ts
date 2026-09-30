/*
 * ⌦ — two rows: a line that is not a place cannot be pulled up into the line above it, and the
 * paragraph break goes whole.
 *
 * Forward-deleting the newline before a fence line or a rule would join the fence's backticks onto
 * the end of the text — visible nowhere, since block markers never show (151) — and unbound the
 * block. So at a line end whose next line is a fence or a rule, ⌦ does nothing.
 *
 * Over a paragraph break, ⌦ deleted one of its two newlines: the gap closed and nothing joined, and
 * above a rule, `text` / `---` became a setext heading. Now the break goes whole and the next block's
 * text joins the line, as ⌫ joins from below. A rule below the break goes with it, and a code block
 * stays where it is (172). ⌥⌦ and ⌘⌦ at a line's end do the same.
 */

import type { LineContext } from "./context";
import { NOOP, rows, type KeyEdit } from "./edit";
import { fencedBlockAt, fenceOrRuleLine, markerSpanEnd, paragraphBreakLine, ruleLine } from "../blocks";

const DELETE = "delete.forward";

function guardFenceOrRule(ctx: LineContext): KeyEdit | null {
  return fenceOrRuleLine(ctx.state, ctx.line.number + 1) ? NOOP : null;
}

function joinAcrossBreak(ctx: LineContext): KeyEdit | null {
  const state = ctx.state;
  const n = ctx.line.number;
  if (ctx.inCode || n + 2 > ctx.docLines || !paragraphBreakLine(state, n + 1)) return null;
  const next = state.doc.line(n + 2);
  if (fencedBlockAt(state, next.from, 1)) return NOOP;
  const to = ruleLine(state, next.number) ? next.to : markerSpanEnd(state, next.number);
  return { changes: [{ from: ctx.line.to, to }], anchor: ctx.line.to, userEvent: DELETE };
}

const table = rows(guardFenceOrRule, joinAcrossBreak);

export function deleteForward(ctx: LineContext): KeyEdit | null {
  if (!ctx.selectionEmpty || !ctx.atLineEnd || ctx.line.number >= ctx.docLines) return null;
  return table(ctx);
}
