/*
 * The paragraph break — the empty line ⏎ writes under a line of text — is not a place the caret can
 * stand (decision 146, extending 89). `break` means the line is one; `place` means the caret may
 * rest there. The caret in `doc` marks the line being asked about.
 */

import { paragraphBreakLine } from "../../src/blocks";
import { stateFor, type Case } from "./harness";

export const press = (doc: string): string => {
  const state = stateFor(doc);
  const n = state.doc.lineAt(state.selection.main.head).number;
  return paragraphBreakLine(state, n) ? "break" : "place";
};

export const cases: Case[] = [
  { name: "the empty line between two paragraphs", doc: "alpha\n|\nbravo", want: "break" },
  { name: "the empty line ⏎ just wrote, with the caret's open line below it (the report)", doc: "line 1\n|\n", want: "break" },
  { name: "under a list item", doc: "- one\n|\n- two", want: "break" },
  { name: "under a heading", doc: "# h\n|\ntext", want: "break" },
  { name: "under a whitespace-only line ⇧⏎ left", doc: "- one\n  \n|\n", want: "break" },
  { name: "a trailing blank line is where click-under-the-note lands", doc: "alpha\n|", want: "place" },
  { name: "the second of a run of blank lines is deliberate space", doc: "alpha\n\n|\nbravo", want: "place" },
  { name: "the first line of the note", doc: "|\nalpha", want: "place" },
  { name: "a blank line inside a fence is content", doc: "```\na\n|\nb\n```", want: "place" },
  { name: "a line with text is a place", doc: "alpha\n|bravo", want: "place" },
  { name: "a whitespace-only line is not a break", doc: "alpha\n | \nbravo", want: "place" },
];
