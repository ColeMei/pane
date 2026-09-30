/*
 * ↑ and ↓ — CodeMirror's own line move, then a step off any line that is not a place.
 *
 * The break is not a place (146, extending 89): a caret that stops on it for a press sits three
 * pixels under the text above, squashed into an 8px strip (132), and reads as a ⇧⏎ line nobody
 * typed. Nor is a fence line or a rule (151).
 *
 * **The step is by line number and character column, not by moving again.** Repeating CodeMirror's
 * own move looks equivalent and is not: `cursorLineDown` works in pixels, and the lines being
 * stepped over are collapsed to 8px, so whether one move clears one of them or two depends on the
 * line height — which depends on the font. Locally ↓ over two blank lines stopped on the second;
 * on CI, whose fonts are not these, it cleared both and landed in the paragraph below. Measured as
 * a green suite here and a red one there, five pushes running. `placeFor` answers the same question
 * with arithmetic, and a wrapped line's exact goal column is a fair price for an answer that is the
 * same everywhere.
 *
 * ⇧↑ and ⇧↓ take the same step with the selection's head, keeping its anchor (169): the break is no
 * more a place for a selection's end than for a caret. A run of blank lines keeps every line after
 * the first, and a blank line in a fence, as places.
 */

import { cursorLineDown, cursorLineUp, selectLineDown, selectLineUp } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { notAPlace } from "../blocks";
import { placeFor, placeRangeEnd } from "../caret";
import type { Command } from "./edit";

function stepOverBreak(move: Command): Command {
  return (view) => {
    const before = view.state.selection.main;
    const column = before.head - view.state.doc.lineAt(before.head).from;
    if (!move(view)) return false;

    const range = view.state.selection.main;
    if (!range.empty || !notAPlace(view.state, view.state.doc.lineAt(range.head).number)) return true;

    const target = placeFor(view.state, range.head, before.head, column);
    if (target !== range.head) {
      view.dispatch({ selection: EditorSelection.cursor(target), userEvent: "select", scrollIntoView: true });
    }
    return true;
  };
}

/** The same step for ⇧↑ and ⇧↓: the head moves on, the anchor stays (169). */
function extendOverBreak(move: Command): Command {
  return (view) => {
    const before = view.state.selection.main;
    const column = before.head - view.state.doc.lineAt(before.head).from;
    if (!move(view)) return false;

    const range = view.state.selection.main;
    if (!notAPlace(view.state, view.state.doc.lineAt(range.head).number)) return true;

    const target = placeRangeEnd(view.state, placeFor(view.state, range.head, before.head, column), before.head, range.anchor);
    if (target !== range.head) {
      view.dispatch({ selection: EditorSelection.range(range.anchor, target), userEvent: "select", scrollIntoView: true });
    }
    return true;
  };
}

export const arrowUp = stepOverBreak(cursorLineUp);
export const arrowDown = stepOverBreak(cursorLineDown);
export const shiftArrowUp = extendOverBreak(selectLineUp);
export const shiftArrowDown = extendOverBreak(selectLineDown);
