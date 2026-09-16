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
import { buildDecorations } from "./decorate";
import { lineTextStart, paragraphBreakLine } from "./blocks";
import { arrivedByEditAfter, revealPolicy } from "./reveal";
import type { SyntaxNode } from "@lezer/common";
import {
  type EditorState,
  type Extension,
  RangeSet,
  StateField,
  Transaction,
} from "@codemirror/state";
import { type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/** Whether the caret got where it is by typing — see `arrivedByEditAfter`. Module state: one editor. */
let caretArrivedByEdit = false;

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, revealPolicy(view.state, view.hasFocus, caretArrivedByEdit));
    }

    update(update: ViewUpdate) {
      // Before the rebuild below, because it decides what that rebuild draws — see the note on
      // `caretArrivedByEdit`. A doc change sets it; a bare selection change clears it; anything else
      // leaves it alone, because anything else has not moved the caret.
      // A note arriving from Swift is a document change and is emphatically not an edit — it carries
      // `addToHistory: false` for undo's sake (decision 80), and the same annotation answers this.
      // Without it, opening a note whose remembered caret offset happens to sit on a blank line
      // (decision 11 restores the exact offset) came up with that line already open, which is the
      // reported bug arriving by the one route that never touches the mouse.
      const restored = update.transactions.some(
        (tr) => tr.annotation(Transaction.addToHistory) === false
      );
      caretArrivedByEdit = arrivedByEditAfter(
        { restored, docChanged: update.docChanged, selectionSet: update.selectionSet },
        caretArrivedByEdit
      );

      // Selection is in the list because moving the caret onto a line reveals its source. That is
      // the feature, and it is also why this must stay cheap.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        // Focus is in the list because losing it renders the whole document — see `caretLines`.
        // Without this the raw line simply stayed raw, because nothing else about the state changed.
        update.focusChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view, revealPolicy(update.state, update.view.hasFocus, caretArrivedByEdit));
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
/**
 * A click on the paragraph break lands on the neighbour the pointer is nearer to.
 *
 * The break is a real `\n` in the file, drawn as an 8px strip, and a strip of empty space between
 * two blocks reads as the gap, not as a place: a caret there is one you did not ask for, in a gap
 * you were aiming past (89). Which line is a break is `paragraphBreakLine`'s to say, and ↑/↓ step
 * over the same lines (`stepOverBreak`), so the caret never rests on one however it travels (146).
 * The upper half of the strip goes to the end of the line above, the lower half to the start of
 * the text below, which is what the reference does with a click in a margin.
 *
 * Two guards. `posAtCoords` is asked for a *precise* hit, so a click in the empty space below the
 * note returns null and falls through to CodeMirror — otherwise a note ending in a blank line
 * would swallow the most ordinary click there is. And an unfocused editor always lets the click
 * through, because handling it would leave the pane unfocusable by clicking in the wrong spot.
 */
const blankLineClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!view.hasFocus) return false;

    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    if (!paragraphBreakLine(view.state, line.number)) return false;

    // `lineBlockAt` is document-relative; `documentTop` puts it in the event's coordinates.
    const block = view.lineBlockAt(line.from);
    const above = event.clientY < view.documentTop + block.top + block.height / 2;
    const target = above ? doc.line(line.number - 1).to : lineTextStart(view.state, line.number + 1);
    view.dispatch({ selection: { anchor: target }, userEvent: "select.pointer", scrollIntoView: true });
    event.preventDefault();
    return true;
  },
});

/**
 * The target a ⌘-click at this position should open, or null — decision 138.
 *
 * **The rule is: what opens is exactly what renders as `.pane-link`.** Not a second opinion about
 * what a link is, because two implementations of one question is decision 100's fault, and the
 * question was already answered a release ago by decision 121's guard a few hundred lines up. So
 * this walks the same tree and honours the same three exclusions:
 *
 * - a `URL` inside an `Image` is **literal text**, not a link — Pane does not interpret images, so
 *   `![alt](url)` renders every character of itself and nothing there is clickable;
 * - everything else that got the accent — `[label](target)`, `<https://x>`, a bare `https://`,
 *   `www.` or address, and the target half of a `[ref]: target` definition — opens.
 *
 * A **reference** link (`[text][ref]`, or the shortcut `[ref]`) has no `URL` child at all: its
 * target is a `[ref]: target` line elsewhere in the note. The first draft declined those, and the
 * sweep in `commands.test.js` failed on exactly that — which was the right answer, because a
 * reference link is painted with the accent and a thing that looks like a link and does nothing is
 * what issues #1 and #2 were both about. So the definition is looked up instead.
 *
 * What it returns is the raw text of the node. Whether that text may be *opened* is
 * `LinkTarget.resolve`'s question, in PaneKit, where it can be tested.
 */
export function linkTargetAt(state: EditorState, pos: number): string | null {
  const text = (from: number, to: number) => state.doc.sliceString(from, to);

  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    // Checked before `Link`, and before the `URL` branch, because an image is the one construct
    // whose URL is on screen as itself and is deliberately not a link.
    if (node.name === "Image") return null;

    if (node.name === "URL") {
      if (node.parent?.name === "Image") return null;
      return text(node.from, node.to);
    }

    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? text(url.from, url.to) : referenceTarget(state, node);
    }
  }
  return null;
}

/**
 * A label, as CommonMark compares two of them: case-folded, with runs of whitespace collapsed.
 *
 * `[Ref]` and `[ref]` are the same reference, and the spec says so — matching on the literal would
 * work for every label anybody types by hand and fail on the one that was pasted.
 */
function labelKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The text of a link's first bracket group — `ref` from `[ref]` and from `[ref][]`. */
function firstBracketText(state: EditorState, link: SyntaxNode): string {
  const [open, close] = link.getChildren("LinkMark");
  if (!open || !close) return "";
  return state.doc.sliceString(open.to, close.from);
}

/**
 * The target of a reference link, looked up in the note's own definitions.
 *
 * Three spellings reach here and they differ only in where the label is: `[text][ref]` carries a
 * `LinkLabel` child, `[ref][]` carries an empty one, and the shortcut `[ref]` carries none at all.
 * All three fall back to the first bracket group, which is the label in the two cases where the
 * explicit one is missing or empty.
 *
 * A definition that does not exist returns null and the click does nothing — correct, because
 * there is no target in the note to open. The lookup is a whole-tree walk, which is fine for
 * something that runs once per ⌘-click and never on a keystroke.
 */
function referenceTarget(state: EditorState, link: SyntaxNode): string | null {
  const label = link.getChild("LinkLabel");
  const explicit = label ? state.doc.sliceString(label.from + 1, label.to - 1) : "";
  const key = labelKey(explicit || firstBracketText(state, link));
  if (!key) return null;

  let found: string | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (found !== null || node.name !== "LinkReference") return;
      const name = node.node.getChild("LinkLabel");
      const url = node.node.getChild("URL");
      if (!name || !url) return;
      if (labelKey(state.doc.sliceString(name.from + 1, name.to - 1)) === key) {
        found = state.doc.sliceString(url.from, url.to);
      }
    },
  });
  return found;
}

/**
 * ⌘-click follows a link; a plain click still places the caret.
 *
 * The gesture is the reference's, measured rather than assumed: Raycast Notes opens the browser on
 * ⌘-click, does nothing on hover, and shows a link popover on a *plain* click — the third of those
 * is deliberately not copied, because its Edit link / Unlink actions only mean something in an
 * editor whose links are nodes with an href. Pane's link is text (decision 5), so there is nothing
 * to unlink, and a popover would be new chrome against decision 22 besides.
 *
 * No hover affordance, for the same reason it was not worth building: the page receives no
 * `mousemove` in Pane's real configuration (decision 120) and Swift's `setPointer` carries no
 * modifier state, so lighting a link under a held ⌘ would mean extending that channel. The
 * reference does nothing on hover either.
 *
 * A click, unlike a move, *is* delivered (decision 107) — measured again for this on the shipping
 * debug build, where a ⌘-click on all three link forms moved the caret and did nothing else.
 */
const linkClickHandler = (open: (target: string) => void) =>
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!event.metaKey || event.button !== 0) return false;

      // Precise, like the blank-line handler above: a ⌘-click in the empty space below the note
      // must not resolve to the nearest link on the last line.
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      const target = linkTargetAt(view.state, pos);
      if (target === null) return false;

      // Only once a target is in hand, so a ⌘-click on ordinary prose keeps whatever CodeMirror
      // would have done with it.
      event.preventDefault();
      open(target);
      return true;
    },
  });

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
 * How much taller the caret's line is than the collapsed blank line it would otherwise be.
 *
 * The caret's blank line is exempt from the collapse above, so that typing the first character moves
 * nothing. That exemption is a *rendering* choice and the window must not follow it: without this,
 * arrowing across the blank lines of a short note grows and shrinks the pane by 12px each time,
 * because every height decision goes through the content height the web layer reports (decision 40).
 * The pane would pulse for the whole length of a note.
 *
 * So the height that goes to Swift is reported as though the caret's line were still collapsed.
 * Content below the caret still opens and closes inside the pane, which is what the exemption is
 * for; the window simply does not chase it. The cost is that while the caret sits on a blank line
 * the note is 12px taller than the pane admits, so a note filling the pane exactly can put its last
 * line under the fade until the caret moves — much cheaper than a window that breathes.
 *
 * Lives here rather than in the reporter because the rule that creates the slack is the rule that
 * has to measure it; splitting them is how the two come to disagree.
 */
export function caretBlankLineSlack(view: EditorView): number {
  const range = view.state.selection.main;
  if (!range.empty) return 0;

  const line = view.state.doc.lineAt(range.head);
  if (line.length !== 0) return 0;

  // A blank line inside a code block is never collapsed, so it has no slack to give back.
  let node = syntaxTree(view.state).resolveInner(line.from, 1);
  while (node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return 0;
    node = node.parent;
  }

  const collapsed = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--blank-line-height")
  );
  if (!Number.isFinite(collapsed)) return 0;

  const slack = view.lineBlockAt(line.from).height - collapsed;
  return slack > 0 ? slack : 0;
}

/**
 * `data-ranged` on the editor while every selection range has something in it.
 *
 * A native macOS text view draws no insertion point while text is selected — the selection *is* where
 * you are, and a caret beside it is a second answer to the same question. `drawSelection` draws one
 * per range head whether the range is empty or not and offers no option, so ⌘A left an amber bar
 * parked at the end of the note under a highlight covering the whole of it. The reference draws none;
 * measured in the probe, ours is `display: block` at y=202..220 with the document selected.
 *
 * `every`, not `some`: a mixed multi-range selection keeps the carets belonging to its empty ranges,
 * which is what AppKit does too. Pane has no multi-cursor UI today, so in practice this reads "the
 * selection is not collapsed" — written for the general case because the narrow one is free.
 *
 * An attribute rather than a class on the content, because the cursor layer is a sibling of
 * `.cm-content` under `.cm-scroller`: the only ancestor both share is `.cm-editor`, which is what
 * `editorAttributes` sets.
 */
const rangedSelectionAttribute = EditorView.editorAttributes.of((view) => {
  const ranges = view.state.selection.ranges;
  return ranges.every((range) => !range.empty) ? { "data-ranged": "" } : null;
});

/**
 * Live preview, as one extension.
 *
 * A StateField would have been the other option, but the decorations depend on the *viewport*, which
 * a StateField cannot see. Hence a ViewPlugin.
 */
export function livePreview(openLink: (target: string) => void): Extension {
  return [
    livePreviewPlugin,
    rangedSelectionAttribute,
    blankLineClickHandler,
    taskClickHandler,
    linkClickHandler(openLink),
  ];
}

// Re-exported so the unused-import checker does not hide a genuine mistake if this is refactored.
export type { DecorationSet, StateField };
