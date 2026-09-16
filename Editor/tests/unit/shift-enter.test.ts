/*
 * ⇧⏎ — the exits table, the delegation predicate, and the soft break. The exits shared with ⏎ are
 * covered in enter.test.ts; here they are checked once to prove the key reaches them.
 */

import { emptyNestedItem, escapeCodeBlock, shiftEnterExits, softBreakInListItem } from "../../src/keyboard/shift-enter";
import { lineContext } from "../../src/keyboard/context";
import { pressWith, stateFor, FALLTHROUGH, type Case } from "./harness";

const exits = pressWith(shiftEnterExits);
const escape = pressWith(escapeCodeBlock);
const soft = pressWith(softBreakInListItem);

/** `doc` is prefixed with `exits:`, `escape:`, `soft:` or `nested:` (the delegation predicate, "yes"/"no"). */
export const press = (doc: string): string => {
  const which = doc.slice(0, doc.indexOf(":"));
  const rest = doc.slice(doc.indexOf(":") + 1);
  if (which === "escape") return escape(rest);
  if (which === "soft") return soft(rest);
  if (which === "nested") return emptyNestedItem(lineContext(stateFor(rest))) ? "yes" : "no";
  return exits(rest);
};

export const cases: Case[] = [
  // 1. Out of a code block (42)
  { name: "⇧⏎ inside a fence lands on the blank line after it", doc: "escape:```\nco|de\n```\n\nafter", want: "```\ncode\n```\n|\nafter" },
  { name: "…making a line when the next one is not free", doc: "escape:```\nco|de\n```\nafter", want: "```\ncode\n```\n|\nafter" },
  { name: "…and one at the end of the document", doc: "escape:```\nco|de\n```", want: "```\ncode\n```\n|" },
  { name: "⇧⏎ on the opening fence line is still inside the block", doc: "escape:```|\ncode\n```\nx", want: "```\ncode\n```\n|\nx" },
  { name: "⇧⏎ in prose is not this row's", doc: "escape:pro|se", want: FALLTHROUGH },

  // 2. The exits ⏎ has, reached from ⇧⏎
  { name: "an empty `> ` leaves the quote", doc: "exits:> q\n> |\nafter", want: "> q\n\n|\nafter" },
  { name: "an empty top-level `- ` leaves the list", doc: "exits:- one\n- |\nafter", want: "- one\n\n|\nafter" },
  { name: "an empty nested item is delegated, not exited", doc: "exits:- one\n  - |", want: FALLTHROUGH },
  { name: "the delegation predicate says yes to an empty nested item", doc: "nested:- one\n  - |", want: "yes" },
  { name: "…and no to an item with text", doc: "nested:- one|", want: "no" },
  { name: "…and no to prose", doc: "nested:hello|", want: "no" },

  // 3. A soft break lands under the item's text (108)
  { name: "⇧⏎ in a bullet item indents the new line to the text column", doc: "soft:- one|", want: "- one\n  |" },
  { name: "…three columns under `1. `", doc: "soft:1. one|", want: "1. one\n   |" },
  // Two, not six: `contentColumn` reads the marker and not the task box, so the soft break lands
  // under the checkbox rather than the text. Preserved as found; decision 108 says "under the text".
  { name: "…two under `- [ ] ` — the checkbox is not counted (see note)", doc: "soft:- [ ] one|", want: "- [ ] one\n  |" },
  { name: "…and a nested item's column", doc: "soft:- one\n  - two|", want: "- one\n  - two\n    |" },
  { name: "…from a continuation line, still the item's column", doc: "soft:- one\n  more|", want: "- one\n  more\n  |" },
  // The line ⇧⏎ leaves is whitespace only, so to CommonMark it is blank and the tree ends the item
  // before it. It is still the item to the person who pressed the key (144).
  { name: "…and from the whitespace-only line ⇧⏎ itself left (144)", doc: "soft:- one\n  - two\n    |", want: "- one\n  - two\n    \n    |" },
  { name: "⇧⏎ in prose is CodeMirror's plain newline", doc: "soft:hello|", want: FALLTHROUGH },
  { name: "⇧⏎ in a fence inside an item is the code's newline", doc: "soft:- one\n  ```\n  co|de\n  ```", want: FALLTHROUGH },
];
