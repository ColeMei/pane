/*
 * What is revealed — the source shown under the caret — decided once per rebuild.
 *
 * Eight decisions describe when a line or a construct shows its markdown rather than its rendering:
 * 42, 44, 53, 57, 77, 89, 132 and 139. They used to be spread through the decoration walk as
 * conditions on individual constructs, so a change to the rule had to be found in each of them.
 * This is the one place. `decorate.ts` reads the answer and never re-derives it.
 *
 * Pure over the state and two facts about the view — whether it has focus, and whether the caret
 * arrived by typing — which is what makes the eight rules testable in plain node (`tests/unit/`).
 */

import type { EditorState } from "@codemirror/state";

export interface Reveal {
  /** Lines holding a caret: every line-level reveal keys off this set. See `caretLines`. */
  lines: Set<number>;
  /** The selection ranges an inline construct reveals for. See `inlineRevealRanges`. */
  ranges: readonly { from: number; to: number }[];
  /** Does any of `ranges` overlap `from..to`? An inline construct is revealed when one does (57). */
  touches(from: number, to: number): boolean;
  /** Is blank line `n` drawn at full height rather than collapsed? See `blankLineExempt`. */
  blankLineExempt(n: number): boolean;
}

/**
 * Lines holding a **caret** — an empty selection — and nothing else. Every line-level reveal in this
 * file keys off this one set: which markers a line shows, and which of its blank lines, fences and
 * rules stay collapsed.
 *
 * **Nothing is revealed while the editor is not focused.** The caret's line shows its source because
 * that is where you are working; a pane you have clicked away from is not where you are working, and
 * a note left showing `**A research plan**` on one line reads as a rendering bug rather than as a
 * caret. It is also what anyone comparing Pane to the reference sees first, since the reference never
 * shows raw markup at all. Nothing is lost on the way back: focus returns, the line goes raw again,
 * and the caret is still where it was (decision 11).
 *
 * **It used to be two sets, and collapsing them is the point.** `activeLines` was every line a
 * selection *touched*, and decision 77 carved the height-changing reveals out of it onto the caret
 * because ⌘A un-collapsed every blank line, fence and rule at once — measured on a four-block note,
 * the document grew 24px and every paragraph moved down. The markers were left on the old set, which
 * is how ⌘A still turned the whole note back into its source, and how the first ⌘A — which takes the
 * *block*, decision 65, and is therefore usually one line — kept revealing that line's markers and
 * bringing their mismatched selection rectangles back with them. A selection is a thing you have
 * marked, not a place you are standing; there was never a reason for the two sets to differ.
 *
 * A marker can be dropped from a selected line for free, which is what makes this safe: raw or
 * rendered, it occupies the same fixed box (see `rawListMark`), so the item's words do not move.
 * **An inline construct cannot** — revealing `**bold**` is 26px wider than not — which is why
 * `inlineRevealRanges` is a separate, wider rule rather than this one.
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
 * Decision 77 settled the sentence and applied it to half the problem — *"a range selection is not a
 * place you are standing, it is a thing you have marked"* — and keyed the height-changing reveals off
 * the caret for exactly that reason. Everything else kept following whatever a selection *touched*,
 * so ⌘A revealed the source of the entire note: measured on a six-line note, the heading's `#`, the
 * `**`, the backticks, the `*em*`, the quote's `>` and the task's `-` all came back at once, and the
 * document you had just selected was no longer the document you had been reading.
 *
 * **Why this is not simply the caret, which is what the block markers below use.** Revealing an
 * inline construct changes the line's width: measured on `Some **bold** and tail here.`, the word
 * `tail` sits at x=163 with the markers shown and x=137 without them. A caret-only rule would
 * therefore move the text 26px sideways the instant a drag *starting inside a bold run* became
 * non-empty — under the pointer, mid-gesture, which is the cursor instability this file's header is
 * about. A block marker has no such cost: it lives in a fixed box either way (see `rawListMark`), so
 * `numbered` stays at x=69 whether its `1. [ ]` is raw or rendered. Two rules because the two have
 * different costs, which is the same split decision 57 already draws.
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
    lines,
    ranges,
    touches: (from, to) => ranges.some((range) => range.from <= to && range.to >= from),
    blankLineExempt: blankLineExempt(state, lines, arrivedByEdit),
  };
}
