/*
 * The line under the caret, described once.
 *
 * Every keyboard rule in Pane used to re-derive "what line am I on" by itself — the same regex
 * written four times, the tree resolved with two different biases, and decisions 109, 123 and 135
 * are each a place where two of those derivations disagreed. `lineContext` computes the answer once
 * per keystroke, and a key's rules (`backspace.ts` and its siblings) are tables over it that return
 * an edit or nothing. No `EditorView` in here: a rule is a function of the state, which is what makes
 * it testable in plain node (`tests/unit/`).
 *
 * The fields are deliberately the *exact* predicates the old commands used, named. Three of them
 * describe "a line that is only a marker" and they are not the same test (a quote prefix allowed or
 * not, a space after the marker required or not); keeping all three is what keeps the migration
 * behaviour-preserving. Collapse them only with the markdown suite red first (decision 84).
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

/** A change the adapter can dispatch. `anchor` is where the caret lands; left out, it maps through the changes. */
export interface KeyEdit {
  changes: { from: number; to?: number; insert?: string }[];
  anchor?: number;
  userEvent: string;
  scrollIntoView?: boolean;
}

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
  line: { number: number; from: number; to: number; text: string; length: number };
  docLines: number;
  atLineStart: boolean;
  atLineEnd: boolean;

  /** Length of the leading whitespace. */
  indent: number;
  /** Nothing on the line but quote marks (and whitespace). */
  quoteOnly: boolean;
  /** `EMPTY_LIST_ITEM`: a marker with nothing after it; quote prefixes allowed, the space optional. */
  emptyItem: boolean;
  /** A list marker with a space (and optional task box with a space), or a run of quote marks, and nothing else. */
  typedMarkerOnly: boolean;
  /** The leading list marker, when the line starts with one. */
  listMarker: ListMarker | null;

  /** Inside a fenced or indented code block (resolved with a +1 bias, as `joinBackToParagraph` did). */
  inCode: boolean;
  /** The tree agrees the marker starts a `ListItem` (resolved at the marker with a +1 bias — decision 78). */
  inListItem: boolean;

  above: NeighbourLine | null;
  below: NeighbourLine | null;
}

const QUOTE_ONLY = /^[ \t]*(?:>[ \t]*)+$/;
export const EMPTY_LIST_ITEM =
  /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]*(?:\[[ xX]\][ \t]*)?$/;
const TYPED_MARKER_ONLY = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|(?:>[ \t]*)+)$/;
const LIST_MARKER = /^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;
const LIST_CONTINUED = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]/;
const QUOTE_CONTINUED = /^[ \t]*>/;

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

function enclosing(state: EditorState, pos: number, name: string): SyntaxNode | null {
  let node = syntaxTree(state).resolveInner(pos, 1);
  while (node.parent && node.name !== name) node = node.parent;
  return node.name === name ? node : null;
}

export function lineContext(state: EditorState): LineContext {
  const range = state.selection.main;
  const head = range.head;
  const line = state.doc.lineAt(head);
  const indent = /^[ \t]*/.exec(line.text)![0].length;

  const markerMatch = LIST_MARKER.exec(line.text);
  let listMarker: ListMarker | null = null;
  if (markerMatch) {
    const span = markerMatch[2]!.length;
    listMarker = {
      indent,
      span,
      contentColumn: indent + span,
      hasText: line.text.length > indent + span,
    };
  }

  let inCode = false;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(head, 1); node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") { inCode = true; break; }
  }

  return {
    state,
    head,
    selectionEmpty: range.empty,
    line: { number: line.number, from: line.from, to: line.to, text: line.text, length: line.length },
    docLines: state.doc.lines,
    atLineStart: head === line.from,
    atLineEnd: head === line.to,
    indent,
    quoteOnly: QUOTE_ONLY.test(line.text),
    emptyItem: EMPTY_LIST_ITEM.test(line.text),
    typedMarkerOnly: TYPED_MARKER_ONLY.test(line.text) && line.text.trim() !== "",
    listMarker,
    inCode,
    inListItem: enclosing(state, line.from + indent, "ListItem") !== null,
    above: neighbour(state, line.number - 1),
    below: neighbour(state, line.number + 1),
  };
}

export function applyEdit(view: EditorView, edit: KeyEdit): void {
  view.dispatch({
    changes: edit.changes,
    selection: edit.anchor === undefined ? undefined : { anchor: edit.anchor },
    userEvent: edit.userEvent,
    scrollIntoView: edit.scrollIntoView ?? false,
  });
}

/** Turn a key's table into a CodeMirror command. Declines (returns false) when the table has no row. */
export function keyCommand(table: (ctx: LineContext) => KeyEdit | null) {
  return (view: EditorView): boolean => {
    const edit = table(lineContext(view.state));
    if (!edit) return false;
    applyEdit(view, edit);
    return true;
  };
}
