/*
 * ⏎ and ⇧⏎ inside an inline construct — decision 171.
 *
 * Splitting `**bold words**` at the caret used to leave `**bo` on one line and `ld words**` on the
 * next, both drawn with literal asterisks. Now the construct is closed at the caret and opened again
 * after the break, as Typora does: `**bo**` / `**ld words**`. Every construct around the caret is
 * closed, innermost first, and reopened outermost first. A link's label reopens with its target.
 *
 * At a construct's inner edge nothing is split: the caret steps outside it first, so ⏎ after the
 * last letter leaves the construct whole above, and ⏎ before the first moves it down whole. The
 * space at a split between words goes, because `** words**` is not bold. The markers are bytes
 * nobody typed; Cole chose them over broken markdown on 2026-09-30.
 */

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { EditorView } from "@codemirror/view";
import { TEXT_CONSTRUCTS } from "../decorate";
import type { Command } from "./edit";

export interface Span {
  from: number;
  to: number;
  /** Where the construct's text starts and ends, inside its markers. */
  textFrom: number;
  textTo: number;
}

const MARKS: Record<string, string> = {
  StrongEmphasis: "EmphasisMark",
  Emphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

function spanOf(node: SyntaxNode): Span | null {
  if (node.name === "Link") {
    const [open, close] = node.getChildren("LinkMark");
    if (!open || !close) return null;
    return { from: node.from, to: node.to, textFrom: open.to, textTo: close.from };
  }
  const mark = MARKS[node.name];
  if (!mark) return null;
  const marks = node.getChildren(mark);
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (!open || !close || marks.length < 2) return null;
  return { from: node.from, to: node.to, textFrom: open.to, textTo: close.from };
}

function inCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
  }
  return false;
}

/** Every construct whose text holds `pos`, edges included, outermost first. */
export function spansAt(state: EditorState, pos: number): Span[] {
  const found = new Map<string, Span>();
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      const span = spanOf(node);
      if (span && pos >= span.textFrom && pos <= span.textTo) found.set(`${span.from}:${span.to}`, span);
    }
  }
  const line = state.doc.lineAt(pos);
  for (const construct of TEXT_CONSTRUCTS) {
    construct.pattern.lastIndex = 0;
    for (let match; (match = construct.pattern.exec(line.text)) !== null; ) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const span = { from, to, textFrom: from + construct.open, textTo: to - construct.close };
      if (pos >= span.textFrom && pos <= span.textTo) found.set(`${from}:${to}`, span);
    }
  }
  return [...found.values()].sort((a, b) => a.from - b.from || b.to - a.to);
}

/** Is `pos` inside code — inline or a block — where a `==` is two equals signs (61)? */
function inAnyCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock") return true;
  }
  return false;
}

/** Every construct that overlaps or touches `from..to`, outermost first (177). */
export function spansIn(state: EditorState, from: number, to: number): Span[] {
  const found = new Map<string, Span>();
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const span = spanOf(ref.node);
      if (span) found.set(`${span.from}:${span.to}`, span);
    },
  });
  const doc = state.doc;
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    for (const construct of TEXT_CONSTRUCTS) {
      construct.pattern.lastIndex = 0;
      for (let match; (match = construct.pattern.exec(line.text)) !== null; ) {
        const start = line.from + match.index;
        const end = start + match[0].length;
        if (end < from || start > to || inAnyCode(state, start + 1)) continue;
        found.set(`${start}:${end}`, { from: start, to: end, textFrom: start + construct.open, textTo: end - construct.close });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.from - b.from || b.to - a.to);
}

/** Is `pos` between a construct's marker and its text, or inside a marker — not a place to stop (177)? */
export function isSeam(state: EditorState, pos: number): boolean {
  return spansIn(state, pos, pos).some((s) => pos > s.from && pos < s.to && (pos <= s.textFrom || pos >= s.textTo));
}

interface Plan {
  /** The range the closers and openers replace: the caret, widened over the spaces at a split. */
  from: number;
  to: number;
  close: string;
  open: string;
}

function planAt(state: EditorState, pos: number): Plan | null {
  if (inCode(state, pos)) return null;
  let spans = spansAt(state, pos);
  if (spans.length === 0) return null;
  let at = pos;
  // At an inner edge, step outside rather than split nothing off.
  for (let stepped = true; stepped && spans.length; ) {
    stepped = false;
    const inner = spans[spans.length - 1]!;
    if (at === inner.textFrom) { at = inner.from; spans = spans.slice(0, -1); stepped = true; }
    else if (at === inner.textTo) { at = inner.to; spans = spans.slice(0, -1); stepped = true; }
  }
  if (spans.length === 0) return { from: at, to: at, close: "", open: "" };
  const doc = state.doc;
  const inner = spans[spans.length - 1]!;
  let from = at;
  let to = at;
  while (from > inner.textFrom && /\s/.test(doc.sliceString(from - 1, from))) from--;
  while (to < inner.textTo && /\s/.test(doc.sliceString(to, to + 1))) to++;
  const closers = spans.map((s) => doc.sliceString(s.textTo, s.to)).reverse().join("");
  const openers = spans.map((s) => doc.sliceString(s.from, s.textFrom)).join("");
  return { from, to, close: closers, open: openers };
}

/**
 * `next` — the ⏎ or ⇧⏎ command — run with the constructs at the caret closed around it (171). The
 * break goes in first and the markers after, as one joinable change, so one ⌘Z takes it all back.
 */
export function splitSpans(next: Command, fallback: string): Command {
  return (view: EditorView) => {
    const range = view.state.selection.main;
    if (!range.empty) return next(view);
    const plan = planAt(view.state, range.head);
    if (!plan) return next(view);
    const inner = plan.close === "";
    // At an inner edge the caret steps outside; before the construct, it goes back in afterwards.
    const reenter = inner && plan.from < range.head ? view.state.sliceDoc(plan.from, range.head) : "";
    const at = inner ? plan.from : range.head;
    if (at !== range.head) view.dispatch({ selection: { anchor: at }, userEvent: "select" });
    if (!next(view)) {
      view.dispatch({ changes: { from: at, insert: fallback }, selection: { anchor: at + fallback.length }, userEvent: "input" });
    }
    let head = view.state.selection.main.head;
    if (!inner) {
      const spaces = plan.to - range.head;
      const lead = view.state.sliceDoc(head, head + spaces).trim() === "" ? spaces : 0;
      view.dispatch({
        changes: [
          { from: plan.from, to: range.head, insert: plan.close },
          { from: head, to: head + lead, insert: plan.open },
        ],
        selection: { anchor: head + plan.close.length - (range.head - plan.from) + plan.open.length },
        userEvent: "input.type",
      });
      return true;
    }
    if (reenter && view.state.sliceDoc(head, head + reenter.length) === reenter) {
      head += reenter.length;
      view.dispatch({ selection: { anchor: head }, userEvent: "select" });
    }
    return true;
  };
}
