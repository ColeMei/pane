/*
 * The line under the caret, described once.
 *
 * Every keyboard rule in Pane used to re-derive "what line am I on" by itself — the same regex
 * written four times, the tree resolved with two different biases, and decisions 109, 123 and 135
 * are each a place where two of those derivations disagreed. `lineContext` computes the answer once
 * per keystroke, and a key's rules (`backspace.ts`, `enter.ts`, `shift-enter.ts`) are tables over it
 * that return an edit or nothing. No `EditorView` in here: a rule is a function of the state, which
 * is what makes it testable in plain node (`tests/unit/`).
 *
 * The fields are deliberately the *exact* predicates the old commands used, named. Three of them
 * describe "a line that is only a marker" and they are not the same test (a quote prefix allowed or
 * not, a space after the marker required or not), and the tree is read with both biases — `+1` at a
 * line's marker (decision 78) and `-1` at the caret — because the two answer different questions at
 * a line start. Keeping every one is what keeps the migration behaviour-preserving. Collapse them
 * only with the markdown suite red first (decision 84).
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { contentColumn, softBreakOwner } from "../list-indent";
import { applyEdit, type Command, type KeyEdit } from "./edit";

export interface NeighbourLine {
  text: string;
  length: number;
  blank: boolean;
  /** Starts with a list marker and a space, quote prefixes allowed — a list this line continues. */
  listContinued: boolean;
  /** Starts with `>` — a quote this line continues. */
  quoteContinued: boolean;
}

/** A leading list marker, as `unindentListItem` matched it: no quote prefix, a space after the marker. */
export interface ListMarker {
  indent: number;
  /** The marker and the whitespace after it, plus the task box and its whitespace when present. */
  span: number;
  /** Column the item's text starts at: `indent + span`. */
  contentColumn: number;
  /** Something follows the marker on this line. */
  hasText: boolean;
}

export interface LineContext {
  state: EditorState;
  head: number;
  selectionEmpty: boolean;
  selection: { from: number; to: number };
  line: { number: number; from: number; to: number; text: string; length: number };
  docLines: number;
  docLength: number;
  atLineStart: boolean;
  atLineEnd: boolean;
  /** The text before the caret on its line. */
  before: string;

  /** Length of the leading whitespace. */
  indent: number;
  /** Nothing on the line but quote marks (and whitespace). */
  quoteOnly: boolean;
  /** The run of quote marks on a quote-only line, whitespace included, as typed — `">> "`. */
  quoteMarks: string;
  /** `EMPTY_LIST_ITEM`: a marker with nothing after it; quote prefixes allowed, the space optional. */
  emptyItem: boolean;
  /** A list marker with a space (and optional task box with a space), or a run of quote marks, and nothing else. */
  typedMarkerOnly: boolean;
  /** The leading list marker, when the line starts with one. */
  listMarker: ListMarker | null;
  /** The line starts with a quote mark. */
  startsQuote: boolean;
  /** The line is an opening fence — ``` or ~~~ with at most an info string — and this is the fence string. */
  fenceOpening: string | null;

  /** Inside a fenced or indented code block, resolved with a +1 bias at the caret. */
  inCode: boolean;
  /** The tree agrees the marker starts a `ListItem`, resolved at the marker with a +1 bias. */
  inListItem: boolean;
  /** …and that item sits inside another item. */
  nestedItem: boolean;
  /** The fenced block this line opens has no closing fence yet (resolved at the line start, +1). */
  fenceUnclosed: boolean;

  /** Resolved with a -1 bias at the caret: the node the caret is *after*. */
  caret: {
    inListItem: boolean;
    inBlockquote: boolean;
    /** The enclosing fenced or indented code block, and where it ends. */
    codeBlock: { to: number } | null;
    /** Inside any block where ⏎ must stay one newline: a list, a quote, code, a table, an HTML block. */
    notProse: boolean;
    /** The content column of the list item the caret is in, continuation lines included; null outside one. */
    itemContentColumn: number | null;
  };

  above: NeighbourLine | null;
  below: NeighbourLine | null;
}

const QUOTE_ONLY = /^(\s*)((?:>[ \t]*)+)$/;
export const EMPTY_LIST_ITEM =
  /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]*(?:\[[ xX]\][ \t]*)?$/;
const TYPED_MARKER_ONLY = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|(?:>[ \t]*)+)$/;
const LIST_MARKER = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;
const LIST_CONTINUED = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]/;
const QUOTE_CONTINUED = /^[ \t]*>/;
export const FENCE_OPENING = /^[ \t]*(`{3,}|~{3,})[^`~]*$/;
const NOT_PROSE = new Set(["ListItem", "Blockquote", "FencedCode", "CodeBlock", "Table", "HTMLBlock"]);

function neighbour(state: EditorState, number: number): NeighbourLine | null {
  if (number < 1 || number > state.doc.lines) return null;
  const line = state.doc.line(number);
  return {
    text: line.text,
    length: line.length,
    blank: line.text.trim() === "",
    listContinued: LIST_CONTINUED.test(line.text),
    quoteContinued: QUOTE_CONTINUED.test(line.text),
  };
}

function enclosing(state: EditorState, pos: number, name: string, bias: -1 | 1): SyntaxNode | null {
  let node = syntaxTree(state).resolveInner(pos, bias);
  while (node.parent && node.name !== name) node = node.parent;
  return node.name === name ? node : null;
}

function ancestorNamed(state: EditorState, pos: number, names: Set<string>, bias: -1 | 1): SyntaxNode | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, bias); node; node = node.parent) {
    if (names.has(node.name)) return node;
  }
  return null;
}

const CODE = new Set(["FencedCode", "CodeBlock"]);

export function lineContext(state: EditorState): LineContext {
  const range = state.selection.main;
  const head = range.head;
  const line = state.doc.lineAt(head);
  const indent = /^[ \t]*/.exec(line.text)![0].length;

  const markerMatch = LIST_MARKER.exec(line.text);
  let listMarker: ListMarker | null = null;
  if (markerMatch) {
    const span = markerMatch[2]!.length;
    listMarker = { indent, span, contentColumn: indent + span, hasText: line.text.length > indent + span };
  }

  const quoteMatch = QUOTE_ONLY.exec(line.text);
  const fenceMatch = FENCE_OPENING.exec(line.text);

  // The tree ends an item before the whitespace-only line ⇧⏎ leaves; the line is still the item's (144).
  const item = enclosing(state, line.from + indent, "ListItem", 1) ?? softBreakOwner(state, line.number);
  let nestedItem = false;
  for (let node = item?.parent ?? null; node; node = node.parent) {
    if (node.name === "ListItem") { nestedItem = true; break; }
  }

  let fenceUnclosed = false;
  if (fenceMatch) {
    const block = enclosing(state, line.from, "FencedCode", 1);
    if (block) {
      let marks = 0;
      for (let child = block.firstChild; child; child = child.nextSibling) {
        if (child.name === "CodeMark") marks += 1;
      }
      fenceUnclosed = marks <= 1;
    }
  }

  const codeBlock = ancestorNamed(state, head, CODE, -1);

  return {
    state,
    head,
    selectionEmpty: range.empty,
    selection: { from: range.from, to: range.to },
    line: { number: line.number, from: line.from, to: line.to, text: line.text, length: line.length },
    docLines: state.doc.lines,
    docLength: state.doc.length,
    atLineStart: head === line.from,
    atLineEnd: head === line.to,
    before: line.text.slice(0, head - line.from),
    indent,
    quoteOnly: quoteMatch !== null,
    quoteMarks: quoteMatch ? quoteMatch[2]! : "",
    emptyItem: EMPTY_LIST_ITEM.test(line.text),
    typedMarkerOnly: TYPED_MARKER_ONLY.test(line.text) && line.text.trim() !== "",
    listMarker,
    startsQuote: QUOTE_CONTINUED.test(line.text),
    fenceOpening: fenceMatch ? fenceMatch[1]! : null,
    inCode: ancestorNamed(state, head, CODE, 1) !== null,
    inListItem: item !== null,
    nestedItem,
    fenceUnclosed,
    caret: {
      inListItem: enclosing(state, head, "ListItem", -1) !== null || softBreakOwner(state, line.number) !== null,
      inBlockquote: enclosing(state, head, "Blockquote", -1) !== null,
      codeBlock: codeBlock ? { to: codeBlock.to } : null,
      notProse: ancestorNamed(state, head, NOT_PROSE, -1) !== null,
      itemContentColumn: contentColumn(state, head),
    },
    above: neighbour(state, line.number - 1),
    below: neighbour(state, line.number + 1),
  };
}

/** Turn a key's table into a CodeMirror command. Declines (returns false) when the table has no row. */
export function keyCommand(table: (ctx: LineContext) => KeyEdit | null): Command {
  return (view) => {
    const edit = table(lineContext(view.state));
    if (!edit) return false;
    applyEdit(view, edit);
    return true;
  };
}

/** Run `command` only when `when` holds for the line; a named, testable delegation to a CodeMirror command. */
export function delegateWhen(when: (ctx: LineContext) => boolean, command: Command): Command {
  return (view) => (when(lineContext(view.state)) ? command(view) : false);
}
