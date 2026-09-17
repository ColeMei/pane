/*
 * Where the caret may rest — decision 151. `place:` asks `placeFor` where a caret asked to be at
 * `|` lands, coming from `^` (or from `|` itself when there is no `^`); the answer is the document
 * with `|` where it rests. `span:` asks where line's marker span ends: the document with `|` there.
 */

import { EditorSelection } from "@codemirror/state";
import { placeFor } from "../../src/caret";
import { markerSpanEnd, notAPlace } from "../../src/blocks";
import { stateFor, type Case } from "./harness";

const mark = (text: string, at: number) => text.slice(0, at) + "|" + text.slice(at);

export const press = (doc: string): string => {
  const which = doc.slice(0, doc.indexOf(":"));
  let rest = doc.slice(doc.indexOf(":") + 1);
  const fromIndex = rest.indexOf("^");
  if (fromIndex >= 0) rest = rest.slice(0, fromIndex) + rest.slice(fromIndex + 1);
  const state = stateFor(rest);
  const head = state.selection.main.head;
  let from = head;
  if (fromIndex >= 0) from = fromIndex > rest.indexOf("|") ? fromIndex - 1 : fromIndex;
  const text = state.doc.toString();
  if (which === "span") return mark(text, markerSpanEnd(state, state.doc.lineAt(head).number));
  if (which === "place?") return notAPlace(state, state.doc.lineAt(head).number) ? "no" : "yes";
  const goal = which === "column" ? from - state.doc.lineAt(from).from : undefined;
  return mark(text, placeFor(state, head, from, goal));
};

export const cases: Case[] = [
  // Marker spans
  { name: "a bullet's span ends at its text", doc: "span:- |item", want: "- |item" },
  { name: "…a numbered item's", doc: "span:|1. item", want: "1. |item" },
  { name: "…a task's, past the box", doc: "span:- [ ] |item", want: "- [ ] |item" },
  { name: "…a quoted nested task's, all of it", doc: "span:> - |a\n>   - [x] b", want: "> - |a\n>   - [x] b" },
  { name: "…a heading's hashes", doc: "span:## |Title", want: "## |Title" },
  { name: "a marker the tree does not know is text", doc: "span:para\n|2. lazy", want: "para\n|2. lazy" },
  { name: "a paragraph's span is its indent", doc: "span:|text", want: "|text" },

  // Places
  { name: "a fence line is not a place", doc: "place?:|```\ncode\n```", want: "no" },
  { name: "…nor the closing one", doc: "place?:```\ncode\n|```", want: "no" },
  { name: "a line of code is", doc: "place?:```\n|code\n```", want: "yes" },
  { name: "a rule is not a place", doc: "place?:a\n\n|---\n\nb", want: "no" },
  { name: "the paragraph break is not (146)", doc: "place?:a\n|\nb", want: "no" },

  // Where a caret lands
  { name: "a caret asked to sit before a marker rests at the text", doc: "place:|- item", want: "- |item" },
  { name: "…inside a numbered marker too", doc: "place:1|. item", want: "1. |item" },
  { name: "leaving the text start leftward goes to the line above", doc: "place:above\n-| ^item", want: "above|\n- item" },
  { name: "a caret asked onto the opening fence going down lands on the first line of code", doc: "place:^a\n|```\ncode\n```", want: "a\n```\n|code\n```" },
  { name: "…going up, on the line above", doc: "place:a\n|```\n^code\n```", want: "a|\n```\ncode\n```" },
  { name: "…onto the closing fence going down, on the line below", doc: "place:```\n^code\n|```\nafter", want: "```\ncode\n```\n|after" },
  { name: "…and with nothing below, back on the code", doc: "place:```\n^code\n|```", want: "```\ncode|\n```" },
  { name: "a vertical move keeps its column across the break", doc: "column:ab^c\n|\nxyz", want: "abc\n\nxy|z" },
  { name: "…and past a marker span", doc: "column:a^bc\n|- item", want: "abc\n- |item" },
  { name: "a rule going down lands past it", doc: "place:^a\n\n|---\n\nb", want: "a\n\n---\n\n|b" },
  { name: "a setext underline is not a place either", doc: "place?:Title\n|=====", want: "no" },
  { name: "a place stays where it is", doc: "place:te|xt", want: "te|xt" },
];
