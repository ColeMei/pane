/*
 * What is revealed — the source shown under the selection — decided once per rebuild.
 *
 * Seven decisions describe when a construct shows its markdown rather than its rendering: 44, 53,
 * 57, 77, 89, 132 and 139. They used to be spread through the decoration walk as conditions on
 * individual constructs, so a change to the rule had to be found in each of them. This is the one
 * place. `decorate.ts` reads the answer and never re-derives it.
 *
 * **Only inline constructs reveal (151).** A block's markers are drawn and never written out, so
 * nothing here keys off "the caret is on this line" any more; what survives of the caret is the
 * blank line it stands on. Where the caret may *stand* is a different question, and `caret.ts`
 * answers it.
 *
 * Pure over the state and two facts about the view — whether it has focus, and whether the caret
 * arrived by typing — which is what makes the rules testable in plain node (`tests/unit/`).
 */

import type { EditorState } from "@codemirror/state";

export interface Reveal {
  /** The selection ranges an inline construct reveals for. See `inlineRevealRanges`. */
  ranges: readonly { from: number; to: number }[];
  /** Does any of `ranges` overlap `from..to`? An inline construct is revealed when one does (57). */
  touches(from: number, to: number): boolean;
  /** Is blank line `n` drawn at full height rather than collapsed? See `blankLineExempt`. */
  blankLineExempt(n: number): boolean;
}

/**
 * Lines holding a **caret** — an empty selection — and nothing else. Since 151 this decides one
 * thing, the blank line the caret stands on; it used to decide which markers a line showed too, and
 * the markers no longer have a raw form to show.
 *
 * **Nothing is revealed while the editor is not focused** (53). A pane you have clicked away from
 * is not where you are working, and a note left showing `**A research plan**` on one line reads as
 * a rendering bug rather than as a caret. Nothing is lost on the way back: focus returns, the line
 * goes raw again, and the caret is still where it was (11).
 *
 * **A selection is a thing you have marked, not a place you are standing** (77), so a range never
 * counts as a caret line and ⌘A opens no blank line.
 */
function caretLines(state: EditorState, hasFocus: boolean): Set<number> {
  const lines = new Set<number>();
  if (!hasFocus) return lines;
  for (const range of state.selection.ranges) {
    if (range.empty) lines.add(state.doc.lineAt(range.head).number);
  }
  return lines;
}

/**
 * The selection ranges an **inline** construct reveals for: the ones confined to a single line.
 *
 * A selection that spans lines reveals nothing at all: ⌘A used to turn the whole note back into its
 * source, and the document you had just selected was no longer the document you had been reading
 * (139).
 *
 * **Why a range and not simply the caret.** Revealing an inline construct changes the line's width —
 * `**bold**` is 26px wider shown than hidden, measured in 139 — so a caret-only rule would move the
 * text sideways the instant a drag *starting inside a bold run* became non-empty, under the pointer,
 * mid-gesture. And why only a *single-line* range: that same width, paid on every line at once, is
 * what ⌘A used to cost (77, 139).
 */
function inlineRevealRanges(state: EditorState, hasFocus: boolean): readonly { from: number; to: number }[] {
  if (!hasFocus) return [];
  const doc = state.doc;
  return state.selection.ranges.filter(
    (range) => doc.lineAt(range.from).number === doc.lineAt(range.to).number
  );
}

/**
 * The caret's blank line is drawn at full height (decision 44), but only when the caret arrived
 * there by typing (89) — or when it is the note's last line (132).
 * **The last line is exempt however the caret got there** (decision 132). Decision 89
 * narrowed 44 to editing arrivals so that arrowing past a blank separator would not shove
 * the paragraph below it up and down — a real complaint about a gap *between two blocks*.
 * The final line of a note has nothing below it, so opening it moves nothing, and it is
 * exactly where the caret sits when you resummon a note you left at the end. Without this,
 * whether the caret looked right on resummon depended on whether the last thing you did
 * before dismissing happened to be typing: the buffer survives a dismissal, so
 * `caretArrivedByEdit` survived with it (`main.ts`, `resetHistory`).
 */
function blankLineExempt(state: EditorState, lines: Set<number>, arrivedByEdit: boolean): (n: number) => boolean {
  const lastLine = state.doc.lines;
  return (n) => state.doc.line(n).length === 0 && lines.has(n) && (arrivedByEdit || n === lastLine);
}

/**
 * Whether the caret got where it is by **typing** rather than by being moved there.
 *
 * Decision 44 exempts the caret's blank line from the collapse so that pressing ⏎ in prose lands
 * the caret at full height and the first keystroke moves nothing. That argument is entirely about
 * *arriving by editing*. Applied to arriving by clicking or arrowing it buys nothing and costs the
 * thing it was written to prevent: click the blank line between two paragraphs and it grows 8px to
 * 20px under the pointer, so the note appears to gain a line you did not ask for. Reported exactly
 * that way, on the grounds that ⏎ and ⇧⏎ are how you ask for space.
 *
 * So the exemption keys off this instead. Set by any document change and cleared by a selection
 * change that is not one — never cleared by a rebuild for some other reason (a viewport scroll, a
 * tree finishing), because those do not move the caret and must not change what it is standing on.
 *
 * Module state rather than a StateField because it describes the *last update*, not the document,
 * and there is exactly one editor in this app.
 */
export function arrivedByEditAfter(
  update: { restored: boolean; docChanged: boolean; selectionSet: boolean },
  previous: boolean
): boolean {
  // A note arriving from Swift is a document change and is emphatically not an edit — it carries
  // `addToHistory: false` for undo's sake (decision 80), and the same annotation answers this.
  if (update.restored) return false;
  if (update.docChanged) return true;
  if (update.selectionSet) return false;
  return previous;
}

export function revealPolicy(state: EditorState, hasFocus: boolean, arrivedByEdit: boolean): Reveal {
  const lines = caretLines(state, hasFocus);
  const ranges = inlineRevealRanges(state, hasFocus);
  return {
    ranges,
    touches: (from, to) => ranges.some((range) => range.from <= to && range.to >= from),
    blankLineExempt: blankLineExempt(state, lines, arrivedByEdit),
  };
}
