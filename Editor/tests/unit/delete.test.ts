/*
 * ⌦ — a fence or a rule cannot be pulled up into the line above (151), and the paragraph break goes
 * whole (172), and so does the marker of the line under it (197).
 */

import { deleteForward } from "../../src/keyboard/delete";
import { pressWith, FALLTHROUGH, type Case } from "./harness";

const press0 = pressWith(deleteForward);
export const press = (doc: string): string => {
  const got = press0(doc);
  return got === doc ? "noop" : got;
};

export const cases: Case[] = [
  { name: "⌦ at the end of the line above a fence does nothing", doc: "text|\n```\ncode\n```", want: "noop" },
  { name: "⌦ at the end of the last line of code does nothing", doc: "```\ncode|\n```", want: "noop" },
  { name: "⌦ at the end of the line above a rule does nothing", doc: "text|\n---", want: "noop" },
  { name: "⌦ before a paragraph break takes the whole break (172)", doc: "text|\n\nnext", want: "text|next" },
  { name: "⌦ before a break and a rule takes the rule with it (172)", doc: "text|\n\n---\n\nnext", want: "text|\n\nnext" },
  { name: "⌦ before a break and a fence does nothing (172)", doc: "text|\n\n```\ncode\n```", want: "noop" },
  { name: "⌦ before a break and a heading joins its text, not its hashes (172)", doc: "text|\n\n## Head", want: "text|Head" },
  { name: "⌦ at an item's end joins the next item's text, not its marker (197)", doc: "- one|\n- two", want: "- one|two" },
  { name: "…a nested one's too", doc: "- mid item|\n    - low item", want: "- mid item|low item" },
  { name: "…a numbered one's", doc: "   1. low item|\n2. next top", want: "   1. low item|next top" },
  { name: "…and a task's box goes with it", doc: "- [ ] one|\n- [ ] two", want: "- [ ] one|two" },
  { name: "…and a quote line's mark", doc: "> one|\n> two", want: "> one|two" },
  { name: "…and a heading's hashes, under a paragraph", doc: "text|\n## Head", want: "text|Head" },
  { name: "a continuation line is CodeMirror's", doc: "- one|\n  more", want: FALLTHROUGH },
  { name: "⌦ mid-line is CodeMirror's", doc: "te|xt\n```\n```", want: FALLTHROUGH },
];
