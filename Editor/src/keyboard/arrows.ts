/*
 * ↑ and ↓ — CodeMirror's own line moves, stepping over every line that is not a place.
 *
 * The break is not a place (146, extending 89): a caret that stops on it for a press sits three
 * pixels under the text above, squashed into an 8px strip (132), and reads as a ⇧⏎ line nobody
 * typed. Nor is a fence line or a rule (151). So a plain vertical move that lands a lone caret on
 * one moves again the same way until it reaches a place, keeping the column it was aiming for —
 * which is why this is a key and not only the caret filter: the goal column is the view's, in
 * pixels, and only a further move honours it. A shift-extended move is a different key and is not
 * touched; a run of blank lines keeps every line after the first, and a blank line in a fence, as
 * places.
 */

import { cursorLineDown, cursorLineUp } from "@codemirror/commands";
import { notAPlace } from "../blocks";
import type { Command } from "./edit";

function stepOverBreak(move: Command): Command {
  return (view) => {
    if (!move(view)) return false;
    for (let steps = 0; steps < 8; steps++) {
      const range = view.state.selection.main;
      if (!range.empty || !notAPlace(view.state, view.state.doc.lineAt(range.head).number)) break;
      const before = range.head;
      move(view);
      if (view.state.selection.main.head === before) break;
    }
    return true;
  };
}

export const arrowUp = stepOverBreak(cursorLineUp);
export const arrowDown = stepOverBreak(cursorLineDown);
