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
  // 1b. Undo a soft break (144): the whitespace-only line ⇧⏎ left goes whole, not a space a press
  { name: "⇧⏎ left a whitespace-only line: ⌫ takes the ⇧⏎ back", doc: "- one\n  |", want: "- one|" },
  { name: "…in a nested item", doc: "- one\n  - two\n    |", want: "- one\n  - two|" },
  { name: "…under a numbered item", doc: "1. one\n   |", want: "1. one|" },
  { name: "…and a second one goes back to the first", doc: "- one\n  \n  |", want: "- one\n  |" },
  { name: "a whitespace-only line under prose is not a soft break", doc: "para\n  |", want: FALLTHROUGH },
  { name: "a whitespace-only line short of the item's column is not one either", doc: "1. one\n |", want: FALLTHROUGH },

  // 2. Join back to a paragraph (90)
  { name: "caret at the start of the paragraph below a blank line", doc: "a\n\n|b", want: "a|b" },
  { name: "caret on the blank line between two paragraphs", doc: "a\n|\nb", want: "a|b" },
  { name: "caret at the start of a line under a blank one, mid-note", doc: "x\n\na\n\n|b", want: "x\n\na|b" },
  { name: "a blank line inside a fence is content", doc: "```\na\n\n|b\n```", want: FALLTHROUGH },
  { name: "the first line has nothing above it", doc: "|a", want: FALLTHROUGH },
  { name: "the second line under an empty first line", doc: "\n|a", want: FALLTHROUGH },
  { name: "a trailing blank line has nothing below it", doc: "a\n|", want: FALLTHROUGH },
  { name: "a blank line under a blank line still deletes the two newlines before it", doc: "a\n\n|\n\nb", want: "a|\n\nb" },

  // 3. Join the item above, or leave the list (108, 109, 196)
  { name: "⌫ at an item's text start makes it a paragraph of the item above", doc: "- one\n- |two", want: "- one\n\n  |two" },
  { name: "…at a numbered item's content column", doc: "1. one\n2. |two", want: "1. one\n\n   |two" },
  { name: "…and a task item's box goes with the marker", doc: "- [ ] one\n- [ ] |two", want: "- [ ] one\n\n  |two" },
  { name: "…with no second blank line in a loose list", doc: "- one\n\n- |two", want: "- one\n\n  |two" },
  { name: "…after the item above's own children", doc: "- a\n  - a1\n- |b", want: "- a\n  - a1\n\n  |b" },
  { name: "…and its continuation lines move to the new column", doc: "- a\n  1. |b\n     more", want: "- a\n\n  |b\n  more" },
  { name: "a nested first item becomes a paragraph of its parent", doc: "- one\n  - |two", want: "- one\n\n  |two" },
  { name: "…under an ordered parent, at the parent's content column", doc: "1. one\n   - |two", want: "1. one\n\n   |two" },
  { name: "…and its children come with it, a blank line after the text", doc: "- a\n  - |b\n    - c", want: "- a\n\n  |b\n\n  - c" },
  { name: "…and a blank line before the sibling after it", doc: "- a\n- |b\n- c", want: "- a\n\n  |b\n\n- c" },
  { name: "…which keeps a nested ordered sibling a list", doc: "- top\n  1. |a\n  2. b", want: "- top\n\n  |a\n\n  2. b" },
  { name: "…but none before an outer item after it", doc: "- a\n  - |b\n- c", want: "- a\n\n  |b\n- c" },
  { name: "a list after a paragraph is not the list above it", doc: "- a\n\npara\n\n- |b", want: "- a\n\npara\n\n|b" },
  { name: "⌫ at a top-level first item's text start drops the marker", doc: "- |one", want: "|one" },
  { name: "…and keeps a blank line from a paragraph above", doc: "para\n- |one", want: "para\n\n|one" },
  { name: "…but adds none under a blank line", doc: "\n- |one", want: "\n|one" },
  { name: "…for a task item too", doc: "- [ ] |task", want: "|task" },
  { name: "…for a numbered item", doc: "1. |one", want: "|one" },
  { name: "not at the text start: nothing", doc: "- o|ne", want: FALLTHROUGH },

  // 5–8. The ways off a heading, a code block and a rule, now that their marks never show (151)
  { name: "⌫ at a heading's text start makes it a paragraph", doc: "## |Title", want: "|Title" },
  { name: "…and at the text start of an empty heading", doc: "# |", want: "|" },
  { name: "⌫ inside a heading's text is one character", doc: "# Ti|tle", want: FALLTHROUGH },
  { name: "⌫ at the start of an empty code block removes the block", doc: "a\n```\n|\n```\nb", want: "a\n|\nb" },
  { name: "…with a language too", doc: "```python\n|\n```", want: "|" },
  { name: "⌫ at the start of a block's first line of code, with code, does nothing", doc: "```\n|code\n```", want: "```\n|code\n```" },
  { name: "…and on its second line it is one character", doc: "```\ncode\n|more\n```", want: FALLTHROUGH },
  { name: "⌫ at the start of the line after a block steps into its last line of code", doc: "```\ncode\n```\n|after", want: "```\ncode|\n```\nafter" },
  { name: "…and after a block with nothing inside, nothing", doc: "```\n```\n|after", want: "```\n```\n|after" },
  { name: "⌫ at the start of the line after a rule takes the rule", doc: "a\n\n---\n|b", want: "a\n\n|b" },
  // 161. A finished fence or rule is never edited as text: ⌫ below one steps toward it, never onto it.
  { name: "(161) ⌫ on the empty line ⇧⏎ left under a block goes back into its last line", doc: "x\n\n```\na\n```\n\n|", want: "x\n\n```\na|\n```" },
  { name: "(161) …and with more of the note below", doc: "```\na\n```\n\n|\n\npara", want: "```\na|\n```\n\npara" },
  { name: "(161) ⌫ at a line of text under a block takes the blank line, not the fence", doc: "```\na\n```\n\n|para", want: "```\na\n```\n|para" },
  { name: "(161) ⌫ on an empty line right under a block goes into it", doc: "```\na\n```\n|", want: "```\na|\n```" },
  { name: "(202) ⌫ at text under a blank line under a rule takes the rule, the paragraphs kept apart", doc: "a\n\n---\n\n|b", want: "a\n\n|b" },
  { name: "(202) …with more of the note below", doc: "a\n\n---\n\n|b\n\nc", want: "a\n\n|b\n\nc" },
  { name: "(202) …a `***` rule as well", doc: "a\n\n***\n\n|b", want: "a\n\n|b" },
  { name: "(161) …and on an empty one too, keeping a line under the rule", doc: "a\n\n---\n\n|", want: "a\n\n---\n|" },
  { name: "(161) under an empty block, the blank line goes and nothing else", doc: "```\n\n```\n\n|b", want: "```\n\n```\n|b" },
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
