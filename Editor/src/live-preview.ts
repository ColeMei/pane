/*
 * Live preview: rendered markdown everywhere except the line the caret is on.
 *
 * This is the hardest thing in the product and the thing most likely to make it feel broken. The
 * brief is blunt about it — "reconciling raw source with rendered decorations is where these editors
 * break, usually as cursor instability. If it feels janky the entire premise is gone."
 *
 * The contract, from decision 5: the buffer IS the markdown. Everything here is a view-only
 * decoration. Nothing in this file may change a single byte of the document, which is what lets Pane
 * promise a byte-for-byte round trip.
 *
 * WHAT HAPPENS ON THE ACTIVE LINE. Inline constructs go fully raw — the markers reappear and the
 * inline styling drops, matching the one example the design draws ("the raw syntax stays visible on
 * the active line: **byte-for-byte**"). Block constructs — heading size, code block background,
 * blockquote bar — keep their styling and merely reveal their markers. That split is deliberate:
 * bold and italic do not change line height, so revealing them costs nothing, whereas dropping an
 * h1 to body size as the caret enters it would reflow the document under the user's hands. That is
 * exactly the instability the brief warns about.
 */

import { syntaxTree } from "@codemirror/language";
import { type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/**
 * Block constructs are styled with **line** decorations, not marks.
 *
 * A mark wraps an inline span, and margins and padding do not apply to it — so heading sizes and
 * list indents silently did nothing until this was changed. A line decoration puts the class on
 * CodeMirror's `.cm-line` element, which is a block box and takes layout.
 */
const BLOCK_LINE: Record<string, string> = {
  ATXHeading1: "pane-line-h1",
  ATXHeading2: "pane-line-h2",
  ATXHeading3: "pane-line-h3",
  ATXHeading4: "pane-line-h3",
  ATXHeading5: "pane-line-h3",
  ATXHeading6: "pane-line-h3",
  SetextHeading1: "pane-line-h1",
  SetextHeading2: "pane-line-h2",
  FencedCode: "pane-line-code",
  CodeBlock: "pane-line-code",
  Blockquote: "pane-line-quote",
};

const INLINE_STYLE: Record<string, string> = {
  StrongEmphasis: "pane-strong",
  Emphasis: "pane-em",
  Strikethrough: "pane-strike",
  InlineCode: "pane-code",
  Link: "pane-link",
};

/**
 * Marker nodes — the literal syntax characters. Hidden off the active line, revealed on it.
 * `HeaderMark` covers both the leading hashes and Setext underlines; `ListMark` is handled separately
 * because a bullet becomes a glyph rather than simply vanishing.
 */
const MARKER_NODES = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
  "QuoteMark",
  "LinkMark",
  "URL",
  "CodeInfo",
]);

const hide = Decoration.replace({});

/** A rule spans its whole line, so it is drawn on the line box rather than on the three characters. */
const ruleLine = Decoration.line({ class: "pane-rule" });

const syntaxMark = Decoration.mark({ class: "pane-syntax" });

/** A rendered task checkbox standing in for the literal `[ ]` or `[x]` in the buffer. */
class TaskWidget extends WidgetType {
  constructor(
    readonly done: boolean,
    readonly pos: number
  ) {
    super();
  }

  eq(other: TaskWidget) {
    // Position matters: two checkboxes in the same state are otherwise indistinguishable, and
    // CodeMirror would reuse the DOM node and send clicks to the wrong line.
    return other.done === this.done && other.pos === this.pos;
  }

  toDOM() {
    const box = document.createElement("span");
    box.className = `pane-task ${this.done ? "pane-task--done" : "pane-task--todo"}`;
    box.textContent = this.done ? "✓" : "";
    box.dataset.paneTask = String(this.pos);
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.done));
    return box;
  }

  ignoreEvent() {
    // Let the click reach the editor's DOM handler, which edits the buffer rather than a model.
    return false;
  }
}

/** A bullet glyph replacing `-`, `*` or `+`. Nested lists step disc → circle, per design frame 1a. */
class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: BulletWidget) {
    return other.depth === this.depth;
  }

  toDOM() {
    const dot = document.createElement("span");
    dot.className = "pane-list-marker";
    dot.textContent = this.depth > 1 ? "◦" : "•";
    return dot;
  }
}

/** Line numbers touched by any selection range — where raw source shows. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  const doc = view.state.doc;
  for (const range of view.state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

/** Nesting depth of a list item, for choosing the bullet glyph. */
function listDepth(view: EditorView, pos: number): number {
  let depth = 0;
  let node = syntaxTree(view.state).resolveInner(pos, 1);
  while (node.parent) {
    if (node.name === "BulletList" || node.name === "OrderedList") depth++;
    node = node.parent;
  }
  return depth;
}

function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const active = activeLines(view);
  const tree = syntaxTree(view.state);

  // Only the visible ranges. A 3,000-word note must not be fully decorated to draw one screen —
  // that cost lands on every keystroke, and it is where these editors get slow.
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const lineNumber = doc.lineAt(node.from).number;
        const isActive = active.has(lineNumber);

        if (name === "HorizontalRule") {
          // A line decoration, so the rule spans the pane instead of underlining three characters.
          decorations.push(ruleLine.range(doc.lineAt(node.from).from));
          return;
        }

        const blockClass = BLOCK_LINE[name];
        if (blockClass) {
          // Block styling survives the caret. Dropping an h1 to body size as the caret arrives
          // would reflow the document mid-keystroke.
          const deco = Decoration.line({ class: blockClass });
          const last = doc.lineAt(node.to).number;
          for (let n = doc.lineAt(node.from).number; n <= last; n++) {
            decorations.push(deco.range(doc.line(n).from));
          }
          return;
        }

        // List items carry their nesting depth as a class, so indentation comes from the stylesheet
        // rather than from however many spaces happen to be in the buffer. Rendering the raw spaces
        // in a proportional font gives ~4px a level where the design draws 22-26px.
        if (name === "ListItem") {
          const depth = Math.min(listDepth(view, node.from), 4);
          // ONLY the item's own first line. A ListItem's range covers any nested list beneath it, so
          // decorating every line in the range stamps the outer item's depth onto its children too —
          // a third-level line ends up carrying li-1, li-2 and li-3 at once, and which indent wins is
          // then decided by stylesheet order rather than by nesting. A soft-wrapped item is still one
          // .cm-line, so nothing is lost by decorating just the first.
          decorations.push(
            Decoration.line({ class: `pane-line-li pane-line-li-${depth}` }).range(
              doc.lineAt(node.from).from
            )
          );
          return;
        }

        const inlineClass = INLINE_STYLE[name];
        if (inlineClass && !isActive) {
          decorations.push(Decoration.mark({ class: inlineClass }).range(node.from, node.to));
          return;
        }

        if (name === "TaskMarker") {
          if (isActive) return;
          const text = doc.sliceString(node.from, node.to);
          const done = /x/i.test(text);
          decorations.push(
            Decoration.replace({ widget: new TaskWidget(done, node.from) }).range(node.from, node.to)
          );
          return;
        }

        if (name === "ListMark") {
          const text = doc.sliceString(node.from, node.to);
          const ordered = /\d/.test(text);

          // A task item already has a checkbox standing in for its marker. Drawing a bullet as well
          // gives every to-do two markers, which is not what frame 1b shows.
          if (!isActive && /^\s*\[[ xX]\]/.test(doc.sliceString(node.to, Math.min(node.to + 6, doc.length)))) {
            decorations.push(hide.range(node.from, node.to));
            return;
          }

          if (ordered || isActive) {
            decorations.push(syntaxMark.range(node.from, node.to));
          } else {
            decorations.push(
              Decoration.replace({ widget: new BulletWidget(listDepth(view, node.from)) }).range(
                node.from,
                node.to
              )
            );
          }
          return;
        }

        if (MARKER_NODES.has(name)) {
          if (isActive) {
            // Revealed, but muted, so the line reads as text rather than as punctuation.
            decorations.push(syntaxMark.range(node.from, node.to));
          } else if (node.to > node.from) {
            decorations.push(hide.range(node.from, node.to));
          }
        }
      },
    });
  }

  // Sorted on construction rather than fed through a RangeSetBuilder: the tree yields nodes in
  // document order, but an outer mark and an inner replace can share a start offset, and getting
  // their relative side wrong throws. Letting Decoration.set sort is cheap at note scale and cannot
  // be got subtly wrong.
  return Decoration.set(decorations, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Selection is in the list because moving the caret onto a line reveals its source. That is
      // the feature, and it is also why this must stay cheap.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,

    // Hidden markers must not swallow the caret. Without this, arrowing across a hidden `**` leaves
    // the caret in a position the user cannot see, and every subsequent keystroke lands somewhere
    // surprising — the classic live-preview cursor bug.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? RangeSet.empty),
  }
);

/**
 * Clicking a checkbox rewrites the literal `[ ]` / `[x]` in the buffer.
 *
 * Deliberately an edit rather than a toggle on a model: there is no model. The document is the only
 * state, so the checkbox has to change the same characters the user would have changed by typing.
 */
const taskClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    const marker = target?.closest?.("[data-pane-task]") as HTMLElement | null;
    if (!marker) return false;

    const pos = Number(marker.dataset.paneTask);
    if (!Number.isFinite(pos)) return false;

    const current = view.state.doc.sliceString(pos, pos + 3);
    const next = /\[[xX]\]/.test(current) ? "[ ]" : "[x]";
    view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } });

    event.preventDefault();
    return true;
  },
});

/**
 * Tracks whether the document is scrolled past its first heading, so the pane can put the title into
 * the title bar (decision 22). Reported outward through a callback rather than reaching for the DOM
 * from in here.
 */
export function scrollReporter(onScroll: (scrolledPastHeading: boolean) => void): Extension {
  let last = false;
  return EditorView.domEventHandlers({
    scroll(_event, view) {
      const scrolled = view.scrollDOM.scrollTop > 24;
      if (scrolled !== last) {
        last = scrolled;
        onScroll(scrolled);
      }
      return false;
    },
  });
}

/**
 * Live preview, as one extension.
 *
 * A StateField would have been the other option, but the decorations depend on the *viewport*, which
 * a StateField cannot see. Hence a ViewPlugin.
 */
export function livePreview(): Extension {
  return [livePreviewPlugin, taskClickHandler];
}

// Re-exported so the unused-import checker does not hide a genuine mistake if this is refactored.
export type { DecorationSet, StateField };
