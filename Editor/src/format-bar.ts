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

import { EditorView } from "@codemirror/view";

interface Button {
  label: string;
  title: string;
  className?: string;
  /** Wraps the selection, e.g. "**" for bold. */
  wrap?: string;
  /** Prefixes each selected line, e.g. "> " for a quote. */
  linePrefix?: string;
  svg?: string;
}

const SEPARATOR: unique symbol = Symbol("separator");

const BUTTONS: (Button | typeof SEPARATOR)[] = [
  { label: "B", title: "Bold ⌘B", className: "format-bar__bold", wrap: "**" },
  { label: "I", title: "Italic ⌘I", className: "format-bar__italic", wrap: "*" },
  { label: "S", title: "Strikethrough", className: "format-bar__strike", wrap: "~~" },
  SEPARATOR,
  { label: "</>", title: "Inline code", className: "format-bar__code", wrap: "`" },
  {
    label: "",
    title: "Quote",
    linePrefix: "> ",
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M3 2.5v9M6 3.5h6M6 7h6M6 10.5h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  SEPARATOR,
  {
    label: "",
    title: "Bulleted list",
    linePrefix: "- ",
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M2 3h1M2 7h1M2 11h1M5.5 3H12M5.5 7H12M5.5 11H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  {
    label: "",
    title: "Numbered list",
    linePrefix: "1. ",
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><path d="M2 2.5h1.5M2.4 6.8h1M2 11h1.5M5.5 3H12M5.5 7H12M5.5 11H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  },
  {
    label: "",
    title: "Task list",
    linePrefix: "- [ ] ",
    svg: `<svg width="13" height="13" viewBox="0 0 14 14"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 3.8l1 1 1.6-1.8M8 3.8h4M8 10h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1.5" y="8" width="4.5" height="4.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  },
];

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

  view.dispatch({
    changes: lines.map((line) =>
      allPrefixed
        ? { from: line.from, to: line.from + prefix.length, insert: "" }
        : { from: line.from, to: line.from, insert: prefix }
    ),
  });
  view.focus();
}

export function mountFormatBar(root: HTMLElement, view: EditorView, onClose: () => void): void {
  root.innerHTML = "";

  // The heading dropdown from the design. Rendered as a button for now — the popup it opens is
  // deferred with the rest of the menu chrome, and H1 is the common case.
  const heading = document.createElement("button");
  heading.className = "format-bar__heading";
  heading.title = "Heading";
  heading.textContent = "H";
  heading.addEventListener("mousedown", (event) => {
    event.preventDefault();
    applyLinePrefix(view, "# ");
  });
  root.appendChild(heading);

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
      if (item.wrap) applyWrap(view, item.wrap);
      else if (item.linePrefix) applyLinePrefix(view, item.linePrefix);
    });

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
  close.textContent = "✕";
  close.addEventListener("mousedown", (event) => {
    event.preventDefault();
    onClose();
    view.focus();
  });
  root.appendChild(close);
}
