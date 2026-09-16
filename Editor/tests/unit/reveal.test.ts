/*
 * The reveal policy — which lines show their source, which inline ranges reveal, which blank lines
 * open — as eight decisions' worth of before/after cases. `doc` carries a `|` caret or a `[…]` range;
 * the prefix says whether the editor has focus and how the caret arrived.
 */

import { EditorState, EditorSelection } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { arrivedByEditAfter, revealPolicy } from "../../src/reveal";
import type { Case } from "./harness";

function stateWithSelection(doc: string): EditorState {
  const caret = doc.indexOf("|");
  const open = doc.indexOf("[");
  const close = doc.indexOf("]");
  let text: string;
  let selection;
  if (caret >= 0) {
    text = doc.slice(0, caret) + doc.slice(caret + 1);
    selection = EditorSelection.cursor(caret);
  } else {
    text = doc.slice(0, open) + doc.slice(open + 1, close) + doc.slice(close + 1);
    selection = EditorSelection.range(open, close - 1);
  }
  return EditorState.create({ doc: text, selection, extensions: [markdown({ base: markdownLanguage })] });
}

/**
 * `focus,edit:` / `blur,move:` then the document. Returns `lines:<n,…> ranges:<a-b,…> exempt:<n,…>`.
 * `after:` runs `arrivedByEditAfter` on flags `restored`, `doc`, `sel`, `prev` and returns yes/no.
 */
export const press = (spec: string): string => {
  const colon = spec.indexOf(":");
  const flags = spec.slice(0, colon).split(",");
  const rest = spec.slice(colon + 1);
  if (flags[0] === "after") {
    const f = new Set(rest.split(","));
    return arrivedByEditAfter(
      { restored: f.has("restored"), docChanged: f.has("doc"), selectionSet: f.has("sel") },
      f.has("prev")
    ) ? "yes" : "no";
  }
  const state = stateWithSelection(rest);
  const reveal = revealPolicy(state, flags.includes("focus"), flags.includes("edit"));
  const exempt = [];
  for (let n = 1; n <= state.doc.lines; n++) if (reveal.blankLineExempt(n)) exempt.push(n);
  return [
    `lines:${[...reveal.lines].join(",")}`,
    `ranges:${reveal.ranges.map((r) => `${r.from}-${r.to}`).join(",")}`,
    `exempt:${exempt.join(",")}`,
  ].join(" ");
};

export const cases: Case[] = [
  // 53: nothing is revealed without focus
  { name: "a caret in a focused editor reveals its line", doc: "focus,move:one\ntw|o", want: "lines:2 ranges:6-6 exempt:" },
  { name: "the same caret unfocused reveals nothing", doc: "blur,move:one\ntw|o", want: "lines: ranges: exempt:" },

  // 57 / 139: an inline construct follows a single-line range; a block marker follows the caret
  { name: "a range inside one line reveals for inline constructs but is no caret line", doc: "focus,move:so[me bo]ld", want: "lines: ranges:2-7 exempt:" },
  { name: "a range across lines (⌘A) reveals nothing at all", doc: "focus,move:o[ne\ntw]o", want: "lines: ranges: exempt:" },
  { name: "a range across lines unfocused reveals nothing either", doc: "blur,move:o[ne\ntw]o", want: "lines: ranges: exempt:" },

  // 44 / 89 / 132: the caret's blank line
  { name: "a blank line the caret typed its way onto opens", doc: "focus,edit:a\n|\nb", want: "lines:2 ranges:2-2 exempt:2" },
  { name: "a blank line the caret was moved onto stays collapsed", doc: "focus,move:a\n|\nb", want: "lines:2 ranges:2-2 exempt:" },
  { name: "the note's last line opens however the caret got there", doc: "focus,move:a\n|", want: "lines:2 ranges:2-2 exempt:2" },
  { name: "the last line unfocused does not open", doc: "blur,move:a\n|", want: "lines: ranges: exempt:" },
  { name: "a line that is not the caret's is never exempt", doc: "focus,edit:|a\n\nb", want: "lines:1 ranges:0-0 exempt:" },

  // how the caret arrived (89, 80, 132)
  { name: "a document change means the caret arrived by editing", doc: "after:doc", want: "yes" },
  { name: "a note restored from Swift is not an edit, whatever else it is", doc: "after:restored,doc", want: "no" },
  { name: "a bare selection change means it was moved", doc: "after:sel,prev", want: "no" },
  { name: "a rebuild that moves nothing keeps the last answer", doc: "after:prev", want: "yes" },
  { name: "…in both directions", doc: "after:", want: "no" },
];
