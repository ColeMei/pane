/*
 * ⏎ — the two pure tables either side of CodeMirror's `insertNewlineContinueMarkup`. What that
 * command does with a non-empty item is the markdown suite's to check; here, "fallthrough" from the
 * exits table means the key reaches it, and `newParagraph` is asserted on its own.
 */

import { enterExits, newParagraph } from "../../src/keyboard/enter";
import { pressWith, FALLTHROUGH, type Case } from "./harness";

const exits = pressWith(enterExits);
const paragraph = pressWith(newParagraph);

/** `doc` is prefixed with `exits:` or `para:` to pick the table. */
export const press = (doc: string): string => {
  const [which, rest] = [doc.slice(0, doc.indexOf(":")), doc.slice(doc.indexOf(":") + 1)];
  return which === "para" ? paragraph(rest) : exits(rest);
};

export const cases: Case[] = [
  // 1. An empty quote level comes off (43)
  { name: "empty `> ` line inside a quote leaves it, keeping one blank line", doc: "exits:> q\n> |\nafter", want: "> q\n\n|\nafter" },
  { name: "…adding no blank line when one is there already", doc: "exits:> q\n> |\n\nafter", want: "> q\n\n|\nafter" },
  { name: "`>> ` comes off one level, keeping the typed style", doc: "exits:>> q\n>> |", want: ">> q\n> |" },
  { name: "`>>>` with no spaces still comes off one level", doc: "exits:>>> q\n>>>|", want: ">>> q\n>> |" },
  { name: "a `> ` typed under a paragraph is a quote to the parser, and leaves it", doc: "exits:para\n> |", want: "para\n\n|" },

  // 2. An opening fence closes itself (108)
  { name: "⏎ at an open ``` writes the closing fence", doc: "exits:```|", want: "```\n|\n```" },
  { name: "…with an info string", doc: "exits:```js|", want: "```js\n|\n```" },
  { name: "…and ~~~", doc: "exits:~~~|", want: "~~~\n|\n~~~" },
  { name: "a fence that is already closed is left alone", doc: "exits:```|\ncode\n```", want: FALLTHROUGH },
  { name: "not at the fence line's end: nothing", doc: "exits:``|`", want: FALLTHROUGH },

  // 3. An empty top-level item leaves the list (108)
  { name: "empty `- ` at the top level leaves the list with one blank line", doc: "exits:- one\n- |\nafter", want: "- one\n\n|\nafter" },
  { name: "…and adds none under a blank line", doc: "exits:- one\n- |\n\nafter", want: "- one\n\n|\nafter" },
  { name: "empty `1. ` leaves the list", doc: "exits:1. one\n2. |", want: "1. one\n\n|" },
  { name: "empty `- [ ] ` leaves the list", doc: "exits:- [ ] one\n- [ ] |", want: "- [ ] one\n\n|" },
  { name: "an empty nested item is CodeMirror's to outdent", doc: "exits:- one\n  - |", want: FALLTHROUGH },
  { name: "an item with text is CodeMirror's to continue", doc: "exits:- one|", want: FALLTHROUGH },
  { name: "a quoted list item is not this row's", doc: "exits:> - one\n> - |", want: FALLTHROUGH },

  // 5. A paragraph break (63)
  { name: "⏎ at the end of prose writes a paragraph break", doc: "para:hello|", want: "hello\n\n|" },
  { name: "⏎ in the middle of prose splits it into two paragraphs", doc: "para:hel|lo", want: "hel\n\n|lo" },
  { name: "⏎ on a blank line writes one newline, not a stack", doc: "para:a\n\n|", want: "a\n\n\n|" },
  { name: "⏎ with only spaces before the caret writes one newline", doc: "para:a\n  |b", want: "a\n  \n|b" },
  { name: "⏎ inside a list item is not prose", doc: "para:- one|", want: FALLTHROUGH },
  { name: "⏎ inside a quote is not prose", doc: "para:> q|", want: FALLTHROUGH },
  { name: "⏎ inside a fence is not prose", doc: "para:```\ncode|\n```", want: FALLTHROUGH },
  { name: "⏎ in a heading is prose", doc: "para:# Title|", want: "# Title\n\n|" },
];
