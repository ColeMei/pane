/*
 * The format bar — design frame 2b.
 *
 * Every button is a text edit. There is no rich-text model to toggle: wrapping a selection in `**`
 * inserts two pairs of asterisks into the document, exactly as typing them would. That is decision 5
 * holding at the UI layer — the buffer is the markdown, all the way up.
 *
 * The bar replaces the footer row rather than stacking below it (the pane's CSS does that), and its
 * active state is a pressed fill, never the accent.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

interface Button {
  label: string;
  title: string;
  className?: string;
  /** Wraps the selection, e.g. "**" for bold. */
  wrap?: string;
  /** Prefixes each selected line, e.g. "> " for a quote. */
  linePrefix?: string;
  /** Anything the two simple shapes above can't express. */
  custom?: (view: EditorView) => void;
  svg?: string;
  /**
   * Lezer node names that mean this button is on. Without these the pressed fill in `pane.css` has
   * nothing to key off and can never render — which is exactly what the design audit found.
   */
  active?: string[];
}

const SEPARATOR: unique symbol = Symbol("separator");

const BUTTONS: (Button | typeof SEPARATOR)[] = [
  {
    label: "B",
    title: "Bold ⌘B",
    className: "format-bar__bold",
    wrap: "**",
    active: ["StrongEmphasis"],
  },
  { label: "I", title: "Italic ⌘I", className: "format-bar__italic", wrap: "*", active: ["Emphasis"] },
  {
    label: "S",
    title: "Strikethrough",
    className: "format-bar__strike",
    wrap: "~~",
    active: ["Strikethrough"],
  },
  SEPARATOR,
  {
    label: "</>",
    title: "Inline code",
    className: "format-bar__code",
    wrap: "`",
    active: ["InlineCode"],
  },
  {
    label: "",
    title: "Link",
    custom: applyLink,
    active: ["Link"],
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M5.8 8.2a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-1 1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8.2 5.8a2.6 2.6 0 0 0-3.7 0L2.6 7.7a2.6 2.6 0 0 0 3.7 3.7l1-1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  },
  {
    label: "",
    title: "Quote",
    linePrefix: "> ",
    active: ["Blockquote"],
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M3 2.5v9M6 3.5h6M6 7h6M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  SEPARATOR,
  // Numbered before bulleted, matching the reference bar. Reads as an ordering of increasing
  // looseness — numbered, bulleted, then tasks — rather than the arbitrary pair it was.
  {
    label: "",
    title: "Numbered list",
    linePrefix: "1. ",
    active: ["OrderedList"],
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M2 2.5h1.5M2.4 6.8h1M2 11h1.5M5.5 3H12M5.5 7H12M5.5 11H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  {
    label: "",
    title: "Bulleted list",
    linePrefix: "- ",
    active: ["BulletList"],
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M2 3h1M2 7h1M2 11h1M5.5 3H12M5.5 7H12M5.5 11H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  {
    label: "",
    title: "Task list",
    linePrefix: "- [ ] ",
    active: ["Task"],
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 3.8l1 1 1.6-1.8M8 3.8h4M8 10h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  },
];

/**
 * `[label](url)`, which is one of the two things frame 2b draws that had no implementation.
 *
 * With a selection, the selected text becomes the label and the caret lands in the empty target,
 * because the text is the part you already have and the URL is the part you are about to paste.
 * Without one, both halves are empty and the caret goes in the label.
 */
function applyLink(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  view.dispatch({
    changes: { from, to, insert: `[${selected}]()` },
    selection: {
      anchor: selected.length === 0 ? from + 1 : from + selected.length + 3,
    },
  });
  view.focus();
}

/**
 * Which formatting the caret is currently inside.
 *
 * Read from the syntax tree rather than from the raw text, so it agrees with what the live preview
 * is rendering — the two would drift immediately if one parsed and the other pattern-matched.
 */
function activeMarks(state: EditorState): Set<string> {
  const names = new Set<string>();

  // Bias to the left so that having just typed the closing `**` still counts as bold: the caret sits
  // after the construct, and resolving right would land outside it.
  //
  // A cursor rather than a node chain — `TreeCursor.parent()` walks up in place, which avoids naming
  // the node type and the casts that came with it.
  const cursor = syntaxTree(state).cursorAt(state.selection.main.head, -1);
  do {
    names.add(cursor.name);
  } while (cursor.parent());

  return names;
}

/** Wraps or unwraps the selection. Toggling off is what makes the buttons feel like buttons. */
function applyWrap(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const len = marker.length;

  const already =
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= len * 2;

  if (already) {
    const inner = selected.slice(len, selected.length - len);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return;
  }

  view.dispatch({
    changes: { from, to, insert: marker + selected + marker },
    // Keep the text selected, not the markers, so a second click undoes the first.
    selection: { anchor: from + len, head: from + len + selected.length },
  });
  view.focus();
}

function applyLinePrefix(view: EditorView, prefix: string): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;

  const lines = [];
  for (let n = first; n <= last; n++) lines.push(doc.line(n));

  // If every line already carries it, this is a toggle off.
  const allPrefixed = lines.every((line) => line.text.startsWith(prefix));

  const changes = view.state.changes(
    lines.map((line) =>
      allPrefixed
        ? { from: line.from, to: line.from + prefix.length, insert: "" }
        : { from: line.from, to: line.from, insert: prefix }
    )
  );

  // `assoc: 1` — map the caret to *after* an insertion at its own position.
  //
  // Without it, clicking a list button on an empty line left the caret at the start of the line,
  // before the marker that had just been inserted, so the next keystroke landed in front of the
  // bullet. CodeMirror's default association for a cursor sitting exactly on an insertion point is
  // "stay put", which is right for a text edit and wrong for a button that means "start a list here".
  view.dispatch({ changes, selection: view.state.selection.map(changes, 1) });
  view.focus();
}

/**
 * Sets, changes or clears the heading level of the caret's line.
 *
 * Not `applyLinePrefix("# ")`: that toggles one exact string, so going from H1 to H2 produced
 * `# ## ` rather than a heading. Any existing marker is stripped first, and asking for the level a
 * line already has clears it — which is what a pressed button should do when you press it again.
 */
function setHeading(view: EditorView, level: number): void {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const changes = [];

  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    const existing = /^(#{1,6})\s+/.exec(line.text);
    const already = existing?.[1]?.length === level;
    const insert = already ? "" : "#".repeat(level) + " ";
    changes.push({ from: line.from, to: line.from + (existing?.[0]?.length ?? 0), insert });
  }

  const set = view.state.changes(changes);
  view.dispatch({ changes: set, selection: view.state.selection.map(set, 1) });
  view.focus();
}

export { setHeading };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The heading level at the caret, or null when the line is not a heading. */
function currentHeadingLevel(view: EditorView): number | null {
  const marks = activeMarks(view.state);
  for (const level of [1, 2, 3, 4, 5, 6]) {
    if (marks.has(`ATXHeading${level}`)) return level;
  }
  return null;
}

export function mountFormatBar(
  root: HTMLElement,
  view: EditorView,
  onClose: () => void,
  onHeadingMenu: (buttonRect: Rect, currentLevel: number | null) => void
): { refresh: () => void } {
  root.innerHTML = "";

  /** Every button that declares an active state, so `refresh` is a walk rather than a re-query. */
  const stateful: { element: HTMLButtonElement; names: string[] }[] = [];

  // The heading control is a dropdown, as the design draws it: H1, H2 and H3 with their shortcuts.
  // A single "H" button could only ever mean H1, which makes the other two levels undiscoverable.
  const heading = document.createElement("button");
  heading.className = "format-bar__heading";
  heading.title = "Heading";
  heading.setAttribute("aria-haspopup", "true");
  heading.innerHTML = `H<svg class="format-bar__chevron" width="7" height="5" viewBox="0 0 7 5" aria-hidden="true"><path d="M0.5 1.2 3.5 4 6.5 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  root.appendChild(heading);
  stateful.push({
    element: heading,
    names: ["ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6"],
  });

  // The menu itself is native, opened by Swift.
  //
  // It was a DOM popup, and a DOM popup cannot go where this one needs to go: the format bar sits at
  // the bottom of the pane, so the list has to hang *below* it — past the window's own edge. Anything
  // rendered in the web view is clipped to the window, so opening upward over the note was the only
  // option and it covered the text you were about to format.
  //
  // An NSMenu also brings its dismissal rules with it, which is the other half of the problem: it
  // closes on an outside click, on Escape, when the app deactivates, and when the pane is dismissed —
  // all of it handled by AppKit rather than by a pile of listeners here that would each have to be
  // remembered.
  heading.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const rect = heading.getBoundingClientRect();
    onHeadingMenu(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      currentHeadingLevel(view)
    );
  });

  for (const item of BUTTONS) {
    if (item === SEPARATOR) {
      const rule = document.createElement("span");
      rule.className = "format-bar__separator";
      root.appendChild(rule);
      continue;
    }

    const button = document.createElement("button");
    if (item.className) button.className = item.className;
    button.title = item.title;
    button.setAttribute("aria-label", item.title);
    if (item.svg) button.innerHTML = item.svg;
    else button.textContent = item.label;

    button.addEventListener("mousedown", (event) => {
      // mousedown, not click, and prevented: the editor must never lose the selection the button is
      // about to act on.
      event.preventDefault();
      if (item.custom) item.custom(view);
      else if (item.wrap) applyWrap(view, item.wrap);
      else if (item.linePrefix) applyLinePrefix(view, item.linePrefix);
    });

    if (item.active) stateful.push({ element: button, names: item.active });
    root.appendChild(button);
  }

  const spacer = document.createElement("span");
  spacer.className = "format-bar__spacer";
  root.appendChild(spacer);

  const rule = document.createElement("span");
  rule.className = "format-bar__separator";
  root.appendChild(rule);

  const close = document.createElement("button");
  close.className = "format-bar__close";
  close.title = "Close ⌥⌘,";
  close.setAttribute("aria-label", "Close formatting bar");
  // A filled disc rather than a bare glyph — it reads as "dismiss this bar" rather than as one more
  // formatting button that happens to look like an ✕.
  close.innerHTML = `<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.25" fill="currentColor" opacity="0.16"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  close.addEventListener("mousedown", (event) => {
    event.preventDefault();
    onClose();
    view.focus();
  });
  root.appendChild(close);

  return {
    refresh() {
      // Skipped while the bar is hidden: this runs on every selection change, and parsing the tree
      // to style something nobody is looking at is exactly the kind of cost that shows up as a
      // stutter while typing.
      if (!root.offsetParent) return;
      const marks = activeMarks(view.state);
      for (const { element, names } of stateful) {
        element.setAttribute("aria-pressed", String(names.some((n) => marks.has(n))));
      }
    },
  };
}
