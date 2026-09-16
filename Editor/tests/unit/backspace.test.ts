/*
 * ⌫ — one case per row of the table and per position a person can be in. Written from the reports
 * in decisions 90, 108, 109 and 123, which is the order they are grouped in.
 */

import { backspace } from "../../src/keyboard/backspace";
import { pressWith, FALLTHROUGH, type Case } from "./harness";

export const press = pressWith(backspace);

export const cases: Case[] = [
  // 1. Undo a marker break (90 extended to markup by 108)
  { name: "⏎ made an empty bullet: ⌫ takes the ⏎ back", doc: "- one\n- |", want: "- one|" },
  { name: "…and an empty numbered item", doc: "1. one\n2. |", want: "1. one|" },
  { name: "…and an empty task item", doc: "- [ ] one\n- [ ] |", want: "- [ ] one|" },
  { name: "…and a nested empty item under its parent", doc: "1. one\n   - |", want: "1. one|" },
  { name: "…and an empty quote line", doc: "> q\n> |", want: "> q|" },
  { name: "…and a nested empty quote line", doc: ">> q\n>> |", want: ">> q|" },
  { name: "a marker with no space still counts as a break", doc: "- one\n-|", want: "- one|" },

  // 2. Join back to a paragraph (90)
  { name: "caret at the start of the paragraph below a blank line", doc: "a\n\n|b", want: "a|b" },
  { name: "caret on the blank line between two paragraphs", doc: "a\n|\nb", want: "a|b" },
  { name: "caret at the start of a line under a blank one, mid-note", doc: "x\n\na\n\n|b", want: "x\n\na|b" },
  { name: "a blank line inside a fence is content", doc: "```\na\n\n|b\n```", want: FALLTHROUGH },
  { name: "the first line has nothing above it", doc: "|a", want: FALLTHROUGH },
  { name: "the second line under an empty first line", doc: "\n|a", want: FALLTHROUGH },
  { name: "a trailing blank line has nothing below it", doc: "a\n|", want: FALLTHROUGH },
  { name: "a blank line under a blank line still deletes the two newlines before it", doc: "a\n\n|\n\nb", want: "a|\n\nb" },

  // 3. Leave or outdent an item (108, 109)
  { name: "⌫ at a nested item's text start outdents it", doc: "- one\n  - |two", want: "- one\n- |two" },
  { name: "…under an ordered parent, to the parent's indent", doc: "1. one\n   - |two", want: "1. one\n- |two" },
  { name: "…and its children come with it", doc: "- a\n  - |b\n    - c", want: "- a\n- |b\n  - c" },
  { name: "⌫ at a top-level item's text start drops the marker", doc: "- |one", want: "|one" },
  { name: "…and keeps a blank line from a paragraph above", doc: "para\n- |one", want: "para\n\n|one" },
  { name: "…but adds none under a blank line", doc: "\n- |one", want: "\n|one" },
  { name: "…for a task item too", doc: "- [ ] |task", want: "|task" },
  { name: "…for a numbered item", doc: "1. |one", want: "|one" },
  { name: "not at the text start: nothing", doc: "- o|ne", want: FALLTHROUGH },
  { name: "at the marker itself: nothing", doc: "- |", want: "-|" },

  // 4. A typed marker loses one character (109)
  { name: "a typed `- ` under a paragraph loses one character", doc: "para\n- |", want: "para\n-|" },
  { name: "a typed `1. ` under a paragraph loses one character", doc: "para\n1. |", want: "para\n1.|" },
  { name: "a typed `> ` under a paragraph loses one character", doc: "para\n> |", want: "para\n>|" },
  { name: "a typed `- [ ] ` on its own loses one character", doc: "- [ ] |", want: "- [ ]|" },
  { name: "extra spaces after a typed marker go one at a time", doc: "-   |", want: "-  |" },

  // Declined, on purpose
  { name: "the start of a quote's text is CodeMirror's", doc: "> |text", want: FALLTHROUGH },
  { name: "mid-word is a plain delete", doc: "ab|c", want: FALLTHROUGH },
  { name: "end of a prose line is a plain delete", doc: "abc|", want: FALLTHROUGH },
  { name: "start of a prose line under prose is a plain delete", doc: "a\n|b", want: FALLTHROUGH },
];
