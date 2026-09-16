/*
 * What a key's table returns, and how it reaches the editor.
 *
 * A table is a function of the line context that returns a `KeyEdit` or null. `keyCommand` turns
 * one into a CodeMirror command; `chain` runs commands in order until one takes the key — which is
 * how a table sits beside a CodeMirror command it delegates to, such as `insertNewlineContinueMarkup`,
 * whose decline can only be learned by running it.
 */

import type { EditorView } from "@codemirror/view";
import type { LineContext } from "./context";

/** A change to dispatch. `anchor` is where the caret lands; left out, it maps through the changes. */
export interface KeyEdit {
  changes: { from: number; to?: number; insert?: string }[];
  anchor?: number;
  userEvent: string;
  scrollIntoView?: boolean;
}

export type Command = (view: EditorView) => boolean;

/** Take the key and change nothing — for a ⇥ that must not reach `indentMore` (decision 109). */
export const NOOP: KeyEdit = { changes: [], userEvent: "noop" };

export function applyEdit(view: EditorView, edit: KeyEdit): void {
  if (edit.changes.length === 0 && edit.anchor === undefined) return;
  view.dispatch({
    changes: edit.changes,
    selection: edit.anchor === undefined ? undefined : { anchor: edit.anchor },
    userEvent: edit.userEvent,
    scrollIntoView: edit.scrollIntoView ?? false,
  });
}

export function chain(...commands: Command[]): Command {
  return (view) => commands.some((run) => run(view));
}

/** Try each row in order; the first edit wins. */
export function rows(...tables: ((ctx: LineContext) => KeyEdit | null)[]) {
  return (ctx: LineContext): KeyEdit | null => {
    for (const table of tables) {
      const edit = table(ctx);
      if (edit) return edit;
    }
    return null;
  };
}
