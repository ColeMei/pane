/*
 * ⇥ and ⇧⇥ — nesting and un-nesting list items. A `noop` want means the key is consumed with no
 * change (decision 109's rule); `fallthrough` means it is CodeMirror's indent.
 */

import { tab, shiftTab } from "../../src/keyboard/tab";
import { pressWith, FALLTHROUGH, type Case } from "./harness";

const forward = pressWith(tab);
const back = pressWith(shiftTab);

/** `doc` is prefixed with `tab:` or `shift:`. A consumed key leaves the document as it was. */
export const press = (doc: string): string => {
  const which = doc.slice(0, doc.indexOf(":"));
  const rest = doc.slice(doc.indexOf(":") + 1);
  const got = which === "shift" ? back(rest) : forward(rest);
  return got === rest ? "noop" : got;
};

export const cases: Case[] = [
  // ⇥ (108, 109)
  { name: "⇥ nests a bullet under the one above, two columns", doc: "tab:- a\n- |b", want: "- a\n  - |b" },
  { name: "⇥ nests under an ordered item, three columns", doc: "tab:1. a\n2. |b", want: "1. a\n   2. |b" },
  { name: "⇥ nests a task item, two columns", doc: "tab:- [ ] a\n- [ ] |b", want: "- [ ] a\n  - [ ] |b" },
  { name: "⇥ takes the item's continuation line with it", doc: "tab:- a\n- b\n  mo|re", want: "- a\n  - b\n    mo|re" },
  { name: "⇥ takes the item's children with it", doc: "tab:- a\n- |b\n  - c", want: "- a\n  - |b\n    - c" },
  { name: "⇥ on a list's first item does nothing, and is not indentMore", doc: "tab:- |a", want: "noop" },
  { name: "⇥ on a nested first item does nothing", doc: "tab:- a\n  - |b", want: "noop" },
  // The caret stays before the inserted spaces: it maps through the change rather than being placed.
  { name: "⇥ from the marker itself still nests the item", doc: "tab:- a\n|- b", want: "- a\n|  - b" },
  { name: "⇥ in prose is CodeMirror's", doc: "tab:hel|lo", want: FALLTHROUGH },
  { name: "⇥ in a fence is CodeMirror's", doc: "tab:```\nco|de\n```", want: FALLTHROUGH },

  // ⇧⇥ (108)
  { name: "⇧⇥ backs a nested bullet out to its parent's indent", doc: "shift:- a\n  - |b", want: "- a\n- |b" },
  { name: "⇧⇥ under an ordered parent goes back three columns", doc: "shift:1. a\n   - |b", want: "1. a\n- |b" },
  { name: "⇧⇥ carries the children out", doc: "shift:- a\n  - |b\n    - c", want: "- a\n- |b\n  - c" },
  { name: "⇧⇥ on a top-level item does nothing", doc: "shift:- |a", want: "noop" },
  { name: "⇧⇥ in prose is CodeMirror's", doc: "shift:hel|lo", want: FALLTHROUGH },
];
