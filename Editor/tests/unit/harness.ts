/*
 * A document with a `|` in it becomes a state with a caret there; a table's edit becomes a document
 * with a `|` in it again. That is the whole harness: cases read as before/after.
 */

import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { lineContext, type KeyEdit, type LineContext } from "../../src/keyboard/context";
import { paneDialect } from "../../src/dialect";

export interface Case {
  name: string;
  /** The document, with `|` where the caret is. */
  doc: string;
  /** The document after the key with `|` where the caret lands, or "fallthrough" when the table declines. */
  want: string;
}

export const FALLTHROUGH = "fallthrough";

export function stateFor(doc: string): EditorState {
  const caret = doc.indexOf("|");
  if (caret < 0) throw new Error(`no caret in ${JSON.stringify(doc)}`);
  const text = doc.slice(0, caret) + doc.slice(caret + 1);
  const state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(caret),
    // The app's parser, rules and all (158): the tables must read what the editor reads.
    extensions: [markdown({ base: markdownLanguage, extensions: paneDialect })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

export function pressWith(table: (ctx: LineContext) => KeyEdit | null) {
  return (doc: string): string => {
    const state = stateFor(doc);
    const edit = table(lineContext(state));
    if (!edit) return FALLTHROUGH;
    const tr = state.update({
      changes: edit.changes,
      selection: edit.anchor === undefined ? undefined : { anchor: edit.anchor },
    });
    const after = tr.state;
    const head = after.selection.main.head;
    const text = after.doc.toString();
    return text.slice(0, head) + "|" + text.slice(head);
  };
}
