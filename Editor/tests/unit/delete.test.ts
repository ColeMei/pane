/*
 * ⌦ — a fence or a rule cannot be pulled up into the line above (151).
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
  { name: "⌦ before a paragraph break is CodeMirror's", doc: "text|\n\nnext", want: FALLTHROUGH },
  { name: "⌦ mid-line is CodeMirror's", doc: "te|xt\n```\n```", want: FALLTHROUGH },
];
