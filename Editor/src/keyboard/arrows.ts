/*
 * ↑ and ↓ — CodeMirror's own line moves, stepping over the paragraph break.
 *
 * The break is not a place (146, extending 89): a caret that stops on it for a press sits three
 * pixels under the text above, squashed into an 8px strip (132), and reads as a ⇧⏎ line nobody
 * typed. So a plain vertical move that lands a lone caret on one moves once more the same way. A
 * shift-extended move is a different key and is not touched; a run of blank lines keeps every line
 * after the first, and a blank line in a fence, as places.
 */

import { cursorLineDown, cursorLineUp } from "@codemirror/commands";
import { paragraphBreakLine } from "../blocks";
import type { Command } from "./edit";

function stepOverBreak(move: Command): Command {
  return (view) => {
    if (!move(view)) return false;
    const range = view.state.selection.main;
    if (range.empty && paragraphBreakLine(view.state, view.state.doc.lineAt(range.head).number)) move(view);
    return true;
  };
}

export const arrowUp = stepOverBreak(cursorLineUp);
export const arrowDown = stepOverBreak(cursorLineDown);
