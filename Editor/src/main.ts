/*
 * The pane's web layer.
 *
 * Owns the editor, the chrome, the switcher and the format bar. Owns no truth: every note, every
 * pin and every setting arrives from Swift, and every change goes back the same way. The web layer
 * never touches a file.
 *
 * IPC is decision 4's: `WKScriptMessageHandler` inbound (window.webkit.messageHandlers.pane), and
 * `evaluateJavaScript` outbound, which lands on `window.paneHost`.
 */

import "./styles/tokens.css";
import "./styles/pane.css";
import "./styles/markdown.css";
import "./styles/switcher.css";
import "./styles/action-panel.css";

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import {
  deleteMarkupBackward,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";

import { mountActionPanel } from "./action-panel";
import { placeOverlay } from "./overlay";
import { describe, hideTooltip, mountTooltips, setPointer } from "./tooltip";
import { findHighlighting, mountFind } from "./find";
import { keyCommand } from "./keyboard/context";
import { chain } from "./keyboard/edit";
import { backspace } from "./keyboard/backspace";
import { arrowDown, arrowUp } from "./keyboard/arrows";
import { deleteForward } from "./keyboard/delete";
import { caretPlaces } from "./caret";
import { markerSpanEnd, notAPlace, ruleLine } from "./blocks";
import { enterKey } from "./keyboard/enter";
import { shiftEnterKey } from "./keyboard/shift-enter";
import { shiftTab, tab } from "./keyboard/tab";
import { caretBlankLineSlack, livePreview } from "./live-preview";
import { renumberOrderedLists } from "./renumber";
import { mountSwitcher, type NoteSummary } from "./switcher";
import { MARKDOWN_FORMAT_KEYS, mountFormatBar, setHeading, pendingWrapExtension } from "./format-bar";
import { noteTitle } from "./note-title";
import { countCharacters, countWords } from "./word-count";

// ---------------------------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------------------------

type OutboundMessage =
  | { type: "ready" }
  | { type: "edited"; text: string; caret: number }
  | { type: "caret"; caret: number; scrollLine: number }
  | { type: "requestNotes"; query: string }
  | { type: "openNote"; filename: string }
  | { type: "createNote"; title: string }
  | { type: "togglePin"; filename: string | null }
  | { type: "deleteNote"; filename: string }
  | { type: "close" }
  | { type: "contentHeight"; height: number }
  | { type: "switcherOpen"; open: boolean; height: number }
  | { type: "actionsOpen"; open: boolean; height: number }
  | { type: "revealInFinder" }
  /**
   * ⌘-click on a link (decision 138). Carries the node's raw text, not a URL: whether that text may
   * be opened at all is `LinkTarget.resolve`'s question, in PaneKit where it is tested.
   */
  | { type: "openLink"; target: string }
  /** ⌘K row fifteen (decision 103). Swift owns the vault, so the page can only ask. */
  | { type: "renameFile" }
  | { type: "openSettings" }
  | { type: "copyAsMarkdown"; text: string }
  | { type: "exportNote"; text: string }
  | { type: "toggleHideFromCapture" }
  | { type: "toggleAutoSizing" }
  | { type: "toggleSpaceBehaviour" }
  | { type: "toggleFooterCount" }
  | { type: "duplicateNote"; text: string }
  | { type: "requestDeleted" }
  | { type: "restoreDeleted"; storedName: string }
  | { type: "forgetDeleted"; storedName: string }
  | { type: "textSize"; action: "in" | "out" | "reset" }
  | { type: "navigate"; back: boolean }
  | { type: "dragRegions"; titleBar: Rect; exclusions: Rect[]; close: Rect }
  | { type: "headingMenu"; button: Rect; level: number | null };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { pane?: { postMessage(message: unknown): void } } };
    paneHost: typeof host;
  }
}

function send(message: OutboundMessage): void {
  // Absent when the bundle is opened directly in a browser for design work, which is a legitimate
  // way to run it — so this must degrade to a no-op rather than throw.
  window.webkit?.messageHandlers?.pane?.postMessage(message);
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

const paneEl = document.getElementById("pane") as HTMLElement;
const titleBarEl = document.getElementById("titlebar") as HTMLElement;
const closeEl = document.getElementById("close") as HTMLElement;
const paneTitleEl = document.getElementById("pane-title") as HTMLElement;
const wordCountEl = document.getElementById("word-count") as HTMLElement;
const editorHost = document.getElementById("editor-host") as HTMLElement;
const toastEl = document.getElementById("toast") as HTMLElement;
/** Auto-dismiss timers for the toast above. */
let toastTimer = 0;
let toastFadeTimer = 0;

const bannerEl = document.getElementById("banner") as HTMLElement;
const bannerTextEl = document.getElementById("banner-text") as HTMLElement;

/// Where a user's markdown theme lands (decision 19). Appended last so it wins the cascade against
/// the bundled stylesheets without needing !important.
const themeStyleEl = document.createElement("style");
themeStyleEl.id = "markdown-theme";
document.head.appendChild(themeStyleEl);

/** Suppresses the `edited` message while Swift is loading a note into the buffer. */
let applyingRemoteEdit = false;

let currentFilename: string | null = null;

const editorTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { fontFamily: "var(--font-ui)", lineHeight: "var(--line-height)" },
});

function notifyEdited(view: EditorView): void {
  const text = view.state.doc.toString();
  renderCount(text);
  showTitle(view.state.doc.iterLines());
  send({ type: "edited", text, caret: view.state.selection.main.head });
  scheduleContentHeight();
}

/** The note's name — its first non-blank line read as prose, one `noteTitle` for the bar and the
 * switcher, followed as it is typed (decisions 2, 67). */
function showTitle(lines: Iterable<string>): void {
  // "Untitled" rather than nothing, which is what an empty note showed until ⌘N stopped writing a
  // file the moment it was pressed. A pane with no title and no text reads as broken; the reference
  // names it, and the switcher already calls a nameless note Untitled, so this is the two agreeing.
  paneTitleEl.textContent = noteTitle(lines) || "Untitled";
}

/** The footer's number, and which one: a press swaps it, and it carries no bubble — a number in
 * English says its own name (decisions 124, 76). */
let footerCount: "words" | "characters" = "words";

function formatWordCount(n: number): string {
  return `${n} ${n === 1 ? "word" : "words"}`;
}

function renderCount(text: string): void {
  if (footerCount === "characters") {
    const n = countCharacters(text);
    wordCountEl.textContent = `${n} ${n === 1 ? "character" : "characters"}`;
  } else {
    wordCountEl.textContent = formatWordCount(countWords(text));
  }
}

/**
 * Tells Swift how tall the note wants to be, so the window can follow it.
 *
 * Rule 2 is implemented on the Swift side — width fixed, height grows downward until 24px from the
 * screen bottom, then the note scrolls. All the web layer contributes is the desired height.
 */
let lastReportedHeight = -1;
let heightFrame = 0;
let settlePass = false;

/**
 * Content height is asked for when the *content* changes, plus one settle pass for CodeMirror's
 * refined layout — never from the `ResizeObserver`, which fed a report → resize → re-estimate loop
 * and made the pane overshoot on every new line (decision 40, amended 2026-09-17).
 */
function scheduleContentHeight(): void {
  if (heightFrame) return;
  heightFrame = requestAnimationFrame(() => {
    heightFrame = 0;
    settlePass = false;
    reportContentHeight();
  });
}

function reportContentHeight(): void {
  // `view.contentHeight`, never `scrollHeight`: the host is `height: 100%`, so scrollHeight equals
  // clientHeight and the pane would report its current height as the one it wants. Minus the caret's
  // blank-line slack, a rendering choice the window must not follow (`caretBlankLineSlack`).
  const content = view.contentHeight - caretBlankLineSlack(view);

  // Whichever of the three rows is laid out, found by measuring: with ⌘F open both the footer and
  // the format bar are hidden, and reading an attribute measured a `display: none` row as 0 (decision 66).
  const bar = [".find", ".format-bar", ".pane__footer"]
    .map((selector) => paneEl.querySelector<HTMLElement>(selector))
    .find((element) => (element?.offsetHeight ?? 0) > 0);
  const chrome = titleBarEl.offsetHeight + (bar?.offsetHeight ?? 0) + bannerEl.offsetHeight;

  const height = Math.ceil(content + chrome);

  // An unchanged answer is not worth a resize, and re-sending one is how a two-value oscillation
  // stays alive.
  if (height === lastReportedHeight) return;
  lastReportedHeight = height;
  send({ type: "contentHeight", height });

  // One re-measure after the window has had a frame to become the size we just asked for. If the
  // refined layout disagrees, that correction is sent and the chain stops there.
  if (settlePass) return;
  settlePass = true;
  requestAnimationFrame(() => requestAnimationFrame(reportContentHeight));
}

/** Tells Swift where the window may be dragged from. `-webkit-app-region` is inert in a WKWebView
 * (LAB, 2026-08-15), so the web layer measures the title bar minus its buttons and Swift hit-tests. */
function reportDragRegions(): void {
  const box = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const bar = box(titleBarEl);
  const exclusions = Array.from(titleBarEl.querySelectorAll("button")).map(box);

  send({
    type: "dragRegions",
    titleBar: bar,
    exclusions,
    // Named rather than picked out of `exclusions` by index (decision 107). The dot is already in
    // that list — it is a button in the bar — but reading it back out means depending on document
    // order, and the pin comes and goes from this bar with the pinned state.
    close: box(closeEl),
  });
}

const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged && !applyingRemoteEdit) {
    notifyEdited(update.view);
  } else if (update.selectionSet) {
    const head = update.state.selection.main.head;
    send({
      type: "caret",
      caret: head,
      scrollLine: update.state.doc.lineAt(head).number,
    });
  }

  // The format bar's pressed fill follows the caret, so it has to be refreshed on both — a doc
  // change can move in or out of a construct without the selection being "set".
  // Optional because CodeMirror can fire an update during its own construction, before the bar
  // below has been mounted.
  if (update.docChanged || update.selectionSet) formatBar?.refresh();
});

let formatBar: ReturnType<typeof mountFormatBar> | undefined;
/// Declared here rather than at its mount, for the same reason `formatBar` is: `toggleFormatBar`
/// closes the find bar, and a `const` mounted further down would still be in its temporal dead zone.
let find: ReturnType<typeof mountFind> | undefined;

/** A new bullet takes the marker the list above it uses — to CommonMark a change of character
 * starts a second list (decision 59). Only with a list directly above at the same indent. */
function bulletInputRule(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== " ") return false;

    const line = view.state.doc.lineAt(from);
    const typed = /^(\s*)([-*+])$/.exec(line.text.slice(0, from - line.from));
    if (!typed) return false;

    const indent = typed[1];
    const marker = typed[2];

    // The nearest line above that is a bullet at this indent. A blank line does not end a list, so
    // it is skipped; anything else does.
    let above = line.number - 1;
    let previous: string | null = null;
    while (above >= 1) {
      const candidate = view.state.doc.line(above);
      if (candidate.text.trim() === "") {
        above -= 1;
        continue;
      }
      const match = new RegExp(`^${indent}([-*+])\\s`).exec(candidate.text);
      previous = match?.[1] ?? null;
      break;
    }

    if (!previous || previous === marker) return false;

    view.dispatch({
      changes: { from: from - 1, to, insert: previous + " " },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  });
}

function checkboxInputRule(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== " ") return false;

    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);

    // After a list marker: `- []`, `* []`, `1. []`.
    const marker = /^(\s*(?:[-*+]|\d+[.)])\s+)\[\]$/.exec(before)?.[1];
    if (marker !== undefined) {
      const start = line.from + marker.length;
      view.dispatch({
        changes: { from: start, to, insert: "[ ] " },
        selection: { anchor: start + 4 },
        userEvent: "input.type",
      });
      return true;
    }

    // On a line of its own — `[]` becomes a whole list item, which is what Typora does and what you
    // mean when you start a line that way.
    const indent = /^(\s*)\[\]$/.exec(before)?.[1];
    if (indent !== undefined) {
      const start = line.from + indent.length;
      view.dispatch({
        changes: { from: start, to, insert: "- [ ] " },
        selection: { anchor: start + 6 },
        userEvent: "input.type",
      });
      return true;
    }

    return false;
  });
}

/**
 * A rule is finished the moment it is typed — decision 152.
 *
 * `---` on a line of its own draws a 1px line with nothing in it, and that line is not a place the
 * caret can sit (151): parked there it is drawn below the rule, three hidden characters to the
 * right of where the text starts, over whatever line comes next. So the character that completes
 * the break also moves the caret to the first place under the rule, adding a line when the rule
 * ends the note. The same step ↓ takes from a rule, taken for the person who just made one.
 *
 * Only a line that is the break and nothing else, and only when the tree agrees it is one: `---`
 * directly under a paragraph is a setext underline, and the caret has to stay on it or the rest of
 * what they type scatters (151).
 */
function ruleInputRule(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (from !== to || !/^[-*_]$/.test(text)) return false;
    const state = view.state;
    const line = state.doc.lineAt(from);
    if (from !== line.to) return false;
    if (!new RegExp(`^[ \\t]*(?:\\${text}[ \\t]*)+$`).test(line.text)) return false;
    // Not on the note's first line. A rule there separates nothing, and `---` at the top of an
    // empty note is how a YAML frontmatter fence is typed — adding a line under it would break the
    // bytes of something Pane does not interpret and must not damage (121).
    if (line.number === 1) return false;

    const after = state.update({ changes: { from, to, insert: text } }).state;
    if (!ruleLine(after, line.number)) return false;

    // The first line under the rule the caret may rest on. A blank line between two paragraphs is
    // not one (146), so this lands where ↓ would.
    let n = line.number + 1;
    while (n <= after.doc.lines && notAPlace(after, n)) n += 1;
    if (n > after.doc.lines) {
      // Nothing below to land on: the rule takes a line of its own and the caret the one after it.
      view.dispatch({
        changes: { from, to, insert: `${text}\n` },
        selection: { anchor: from + text.length + 1 },
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: markerSpanEnd(after, n) },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  });
}

/** A marker typed at an item's content start is text, and the bytes say so: `1\. ` and `\* `
 * (decision 135). `> ` is deliberately not a trigger — `> - x` means a list inside a quote. */
function escapeNestedMarkerRule(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== " ") return false;

    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    // The parent's marker, then the one being typed right against the content column.
    const typed = /^\s*(?:[-*+]|\d+[.)])[ \t]+(\d+[.)]|[-*+])$/.exec(before)?.[1];
    if (typed === undefined) return false;

    // The backslash goes in front of the marker's last character, which is the punctuation in both
    // shapes: `-` is its own punctuation, `1.` carries it at the end.
    const escaped = `${typed.slice(0, -1)}\\${typed.slice(-1)} `;
    const start = from - typed.length;
    view.dispatch({
      changes: { from: start, to, insert: escaped },
      selection: { anchor: start + escaped.length },
      userEvent: "input.type",
    });
    return true;
  });
}

/** The blocks ⌘A steps through, innermost first. `ListItem` over the `Paragraph` inside it, so a task
 * item, which has no paragraph, selects like every other list (decision 65). */
const SELECTABLE_BLOCKS = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "HorizontalRule",
  "Table",
  "ListItem",
  "Blockquote",
]);

/** ⌘A selects the block; when the selection already is the block this declines and CodeMirror's
 * `selectAll` takes the note (decision 65). */
function selectBlockThenAll(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (range.from === 0 && range.to === state.doc.length) return false;

  // The smallest selectable block that **strictly contains** the selection, so a second press steps
  // *out* — paragraph, then the quote around it, then the note. Taking the innermost block at the
  // head instead sent the second press back *in*: ⌘A on a quoted note selected the quote, and ⌘A
  // again the last paragraph inside it, because the head had moved to the quote's end (decision 65,
  // amended 151). Both biases, because at a line start the node to the left is the block above.
  // A block is selected from its **content**, not from its first byte — decision 153. A list item
  // and a heading start at the line start, so ⌘A used to take `1. ` and `# ` with the text, and the
  // inline commands wrapped them: `**1. Hi**` is not a list item any more. Nothing in a marker span
  // is drawn as characters (151), so it is not something you can have selected either.
  const contentOf = (block: SyntaxNode) => markerSpanEnd(state, state.doc.lineAt(block.from).number);

  let best: SyntaxNode | null = null;
  for (const bias of [-1, 1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(range.head, bias); node; node = node.parent) {
      if (!SELECTABLE_BLOCKS.has(node.name)) continue;
      // A list item's own range, not the paragraph inside it — see SELECTABLE_BLOCKS.
      const block = node.parent?.name === "ListItem" ? node.parent : node;
      if (block.from > range.from || block.to < range.to) continue;
      // Against what this press would *select*, not against the node: the range this leaves starts
      // past the marker, so comparing node starts made the second press pick the same block again
      // and ⌘A never stepped out.
      if (contentOf(block) === range.from && block.to === range.to) continue;
      if (!best || block.to - block.from < best.to - best.from) best = block;
    }
  }
  if (!best) return false;

  view.dispatch({ selection: EditorSelection.range(contentOf(best), best.to) });
  return true;
}

/**
 * The shortcuts the Settings window can rebind (design frame 3c).
 *
 * Keyed by the same action names `Settings.shortcutActions` uses on the Swift side — the two lists
 * have to agree, and naming the action rather than the key is what lets the binding change without
 * anything here knowing.
 */
const DEFAULT_SHORTCUTS: Record<string, string> = {
  newNote: "Mod-n",
  browseNotes: "Mod-p",
  navigateBack: "Mod-[",
  navigateForward: "Mod-]",
  pinPane: "Shift-Mod-p",
  formatBar: "Alt-Mod-,",
  actionPanel: "Mod-k",
  revealInFinder: "Alt-Mod-r",
  deleteNote: "Ctrl-x",
  findInNote: "Mod-f",
  findReplace: "Alt-Mod-f",
  copyAsMarkdown: "Shift-Mod-c",
  exportNote: "Shift-Mod-e",
  hideFromCapture: "Shift-Mod-h",
  duplicateNote: "Mod-d",
  autoSizing: "Shift-Mod-/",
  spaceBehaviour: "Alt-Mod-s",
};

const shortcutsCompartment = new Compartment();

/** The undo history in a compartment, so it is thrown away when the note changes: undo belongs to
 * the note, or ⌘Z after a switch writes the previous note into this one's file (decision 80). */
const historyCompartment = new Compartment();

/**
 * A CodeMirror binding string as key caps — "Shift-Mod-p" becomes ⇧ ⌘ P.
 *
 * Apple's display order (⌃⌥⇧⌘, then the key), matching what the Shortcuts tab prints in Swift, so
 * the same action reads the same in both places.
 */
export function keyCaps(binding: string): string[] {
  if (!binding) return [];
  const parts = binding.split("-");
  const key = parts.pop() ?? "";
  const held = parts.map((p) => p.toLowerCase());

  const caps: string[] = [];
  if (held.includes("ctrl") || held.includes("control")) caps.push("⌃");
  if (held.includes("alt") || held.includes("option")) caps.push("⌥");
  if (held.includes("shift")) caps.push("⇧");
  if (held.includes("mod") || held.includes("cmd") || held.includes("meta")) caps.push("⌘");

  caps.push(key.length === 1 ? key.toUpperCase() : key);
  return caps;
}


/** What every ⌘K row does, keyed by the row's id — one table for the panel and the keymap, so a
 * printed shortcut cannot do something different from the click (decisions 17, 68). */
const actionHandlers: Record<string, () => boolean> = {
  newNote: () => (send({ type: "createNote", title: "" }), true),
  browseNotes: () => (toggleSwitcher(), true),
  navigateBack: () => (send({ type: "navigate", back: true }), true),
  navigateForward: () => (send({ type: "navigate", back: false }), true),
  pinPane: () => (send({ type: "togglePin", filename: currentFilename }), true),
  formatBar: () => (toggleFormatBar(), true),
  revealInFinder: () => (send({ type: "revealInFinder" }), true),
  settings: () => (send({ type: "openSettings" }), true),
  deleteNote: () =>
    currentFilename ? (send({ type: "deleteNote", filename: currentFilename }), true) : false,
  findInNote: () => (find?.open(), true),
  // ⌥⌘F is the macOS convention for find-and-replace and one Raycast leaves free, so decision 39's
  // habit-compatibility rule is untouched. No ⌘K row: the disclosure on the find bar is where
  // anyone would look for it, and decision 17's panel stays at fourteen — the same call decision 51
  // made for Back and Forward.
  findReplace: () => (find?.openWithReplace(), true),
  // The buffer goes with the message rather than Swift using its own copy. Swift's copy is up to
  // 500 ms stale by design (decision 10's debounce), and a copy that silently omits the last
  // sentence you typed is the kind of bug nobody reports because they blame the paste.
  copyAsMarkdown: () => (send({ type: "copyAsMarkdown", text: view.state.doc.toString() }), true),
  exportNote: () => (send({ type: "exportNote", text: view.state.doc.toString() }), true),
  hideFromCapture: () => (send({ type: "toggleHideFromCapture" }), true),
  autoSizing: () => (send({ type: "toggleAutoSizing" }), true),
  spaceBehaviour: () => (send({ type: "toggleSpaceBehaviour" }), true),
  duplicateNote: () => (send({ type: "duplicateNote", text: view.state.doc.toString() }), true),
  recentlyDeleted: () => (switcher.openDeleted(), true),
  renameFile: () => (send({ type: "renameFile" }), true),
};

function paneShortcuts(bindings: Record<string, string>): Extension {
  const run: Record<string, () => boolean> = { ...actionHandlers, actionPanel: () => (toggleActions(), true) };

  return keymap.of(
    Object.entries(run)
      // A binding the user cleared, or one Swift sent for an action this build does not have, drops
      // out rather than registering an undefined key.
      .filter(([action]) => Boolean(bindings[action] ?? DEFAULT_SHORTCUTS[action]))
      .map(([action, handler]) => ({
        key: bindings[action] ?? DEFAULT_SHORTCUTS[action],
        run: handler,
      }))
  );
}

function baseExtensions(): Extension[] {
  return [
    historyCompartment.of(history()),
    drawSelection(),
    rectangularSelection(),
    EditorView.lineWrapping,

    // `addKeymap: false`: the default Enter makes a list loose instead of exiting it (`keyboard/enter.ts`).
    // `autoCloseTags: false`: a typed `<div>` gained a second `</div>`, breaking decision 5
    // (decision 108, amended 2026-09-17).
    markdown({
      base: markdownLanguage,
      addKeymap: false,
      htmlTagLanguage: html({ matchClosingTags: false, autoCloseTags: false }),
    }),

    // Auto-close only the three that help in prose. The CodeMirror default also closes `'` and `"`,
    // which in a document made of sentences is a liability rather than a feature — an apostrophe is
    // not an opening quote.
    markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "`"] } }),
    closeBrackets(),

    livePreview((target) => send({ type: "openLink", target })),
    // Where the caret may rest: past every block marker, never on a break, a fence line or a
    // rule — one filter for every way a caret arrives (146, 151).
    caretPlaces(),
    findHighlighting(),
    // Ordered lists count themselves. A filter that writes to the document, so it declares the
    // transactions it is *for* rather than the ones it is against — see the file's own note, and
    // decision 81, which is what happened the first time that was the other way round.
    renumberOrderedLists(),
    // An empty note said nothing at all — a caret in a blank rectangle. The reference prompts, and
    // it matters more here than it does there: ⌘N now leaves nothing on disk until the first write,
    // so an empty pane is genuinely a blank page rather than a file that already exists.
    placeholder("Start writing…"),
    // First among the input rules: a pair waiting at a line start takes the first character (148).
    pendingWrapExtension(),
    checkboxInputRule(),
    bulletInputRule(),
    // The character that completes `---` also steps the caret off the rule it just made (152).
    ruleInputRule(),
    escapeNestedMarkerRule(),
    editorTheme,
    updateListener,
    // ⏎, ⇧⏎ and ⌫ are tables over the line under the caret — `keyboard/`, one file per key — and
    // sit above everything else. Each hands what it declines to CodeMirror's own markdown command
    // and then to the plain key. `nonTightLists: false` on the ⏎ delegate is why these are
    // hand-bound at all: CodeMirror's default makes a tight list loose instead of exiting it.
    Prec.high(
      keymap.of([
        { key: "Shift-Enter", run: shiftEnterKey },
        { key: "Enter", run: enterKey },
        { key: "Backspace", run: chain(keyCommand(backspace), deleteMarkupBackward) },
        // ↑ and ↓ step over every line that is not a place, keeping their column (146, 151).
        { key: "ArrowUp", run: arrowUp },
        { key: "ArrowDown", run: arrowDown },
        // ⌦ cannot pull a fence or a rule up into the line above (151).
        { key: "Delete", run: keyCommand(deleteForward) },
        { key: "Mod-a", run: selectBlockThenAll },
      ])
    ),

    // Pane's own shortcuts, in their own compartment so the Shortcuts tab can rebind them without
    // rebuilding the editor. Listed before the keymap below so they win over CodeMirror's defaults —
    // within one precedence level, the earlier extension is the higher one.
    shortcutsCompartment.of(paneShortcuts(DEFAULT_SHORTCUTS)),

    keymap.of([
      // Tier 2: the markdown formatting keys, fixed rather than rebindable (see the note on
      // MARKDOWN_FORMAT_KEYS). This is also where "Bold ⌘B" and "Italic ⌘I" stopped being a lie —
      // the format bar has printed those two on its buttons since it shipped while nothing bound
      // them, which is precisely what the comment below this one warns against.
      ...MARKDOWN_FORMAT_KEYS,

      // Text size, also fixed and also convention — ⌘+ / ⌘- / ⌘0 mean this everywhere. The
      // Appearance tab has printed "⌘= / ⌘− in any pane" beside the stepper since it shipped while
      // neither key was bound to anything; ⌘0 comes from the reference, which carries all three.
      // Swift owns the value because it is a setting, so these only ask.
      { key: "Mod-=", run: () => (send({ type: "textSize", action: "in" }), true) },
      // Both spellings, because they are the same physical key. Holding shift makes the browser
      // report `key` as "+", not "=" with a shift flag — so `Mod-Shift-=` never matches and only
      // `Mod-+` does. Measured: with just the Shift- form bound, ⌘+ did nothing while ⌘= worked.
      // ⌘+ is what most people actually press.
      { key: "Mod-+", run: () => (send({ type: "textSize", action: "in" }), true) },
      { key: "Mod--", run: () => (send({ type: "textSize", action: "out" }), true) },
      { key: "Mod-0", run: () => (send({ type: "textSize", action: "reset" }), true) },
      // Escape dismisses the pane. The switcher handles its own Escape while it is open, so this
      // only ever fires with the caret in the editor — where the reflex is "put this away", not
      // "cancel something".
      { key: "Escape", run: () => (send({ type: "close" }), true) },
      // ⇥ and ⇧⇥ nest and un-nest list items (`keyboard/tab.ts`); outside a list they are CodeMirror's.
      { key: "Tab", run: chain(keyCommand(tab), indentMore), shift: chain(keyCommand(shiftTab), indentLess) },
      // After the markdown bindings above, so Backspace only deletes a bracket pair once
      // `deleteMarkupBackward` has declined the position.
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}

/** Throws the undo stack away: out of the configuration, then back in. Reconfiguring with a fresh
 * `history()` hands back the same field and the same stack — it looks like it works and does nothing
 * (decision 80, amended 2026-09-17; decision 71's genre). */
function clearHistory(): void {
  view.dispatch({ effects: historyCompartment.reconfigure([]) });
  view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}

const view = new EditorView({
  state: EditorState.create({ doc: "", extensions: baseExtensions() }),
  parent: editorHost,
});

// ---------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------

function toggleFormatBar(): void {
  // One footer row, never two (decision 22). Find and the format bar are both that row, so opening
  // either has to put the other away.
  find?.close();
  paneEl.toggleAttribute("data-format-bar");
  formatBar?.refresh();
  // The bar and the footer are different heights, so swapping them changes how much room the note
  // has — and the window has to follow.
  scheduleContentHeight();
  reportDragRegions();
}

/* `mousedown`, and prevented: a click would blur the editor and decision 53 would redraw the note
 * under the pointer. Swapped here rather than after Swift's round trip, or the number lags the press
 * (decision 124). */
document.getElementById("word-count")!.addEventListener("mousedown", (event) => {
  event.preventDefault();
  footerCount = footerCount === "words" ? "characters" : "words";
  renderCount(view.state.doc.toString());
  send({ type: "toggleFooterCount" });
});

// Named from the first frame rather than from the first edit. The markup ships "0 words" as text
// and nothing had ever set the tip, so an untouched pane had one control the bubble could not name.
renderCount(view.state.doc.toString());

document.getElementById("format-toggle")!.addEventListener("click", toggleFormatBar);
closeEl.addEventListener("click", () => send({ type: "close" }));
document.getElementById("new-note")!.addEventListener("click", () =>
  send({ type: "createNote", title: "" })
);
document.getElementById("pin")!.addEventListener("click", () =>
  send({ type: "togglePin", filename: currentFilename })
);
document.getElementById("browse")!.addEventListener("click", () => toggleSwitcher());
document.getElementById("open-actions")!.addEventListener("click", () => toggleActions());

/* Every button names itself the same way: one string carries the shortcut and becomes the accessible
 * name, so a key cannot be advertised differently in two places (decision 58). */
mountTooltips(paneEl);

/** The chrome's tooltips read the binding in force, re-read whenever settings arrive — decision 68's
 * rule, its fourth instance (92). */
const CHROME_TIPS: [selector: string, label: string, action: string | null][] = [
  ["#close", "Close", null],
  ["#pin", "Unpin", "pinPane"],
  ["#open-actions", "Actions", "actionPanel"],
  ["#browse", "Notes", "browseNotes"],
  ["#new-note", "New note", "newNote"],
  ["#format-toggle", "Format", "formatBar"],
  // The find bar's disclosure is the **only** place ⌥⌘F is printed anywhere in the app — it has no
  // ⌘K row (decision 72) and no Shortcuts row. If this string goes stale the key is documented
  // nowhere, which is why it is listed here rather than left as a literal beside its neighbours.
  ["[data-disclosure]", "Replace", "findReplace"],
];

function refreshChromeTooltips(): void {
  for (const [selector, label, action] of CHROME_TIPS) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const binding = action ? liveShortcuts[action] ?? DEFAULT_SHORTCUTS[action] : undefined;
    describe(element, binding ? `${label} ${keyCaps(binding).join("")}` : label);
  }
}
// The first call lives beside `liveShortcuts` below, not here: that binding is a `let` declared
// further down the file, and reading it from up here is a temporal-dead-zone throw — which took
// out `window.paneHost` entirely and presented as the whole bridge being missing.

formatBar = mountFormatBar(
  document.getElementById("format-bar") as HTMLElement,
  view,
  toggleFormatBar,
  (button, level) => send({ type: "headingMenu", button, level })
);

find = mountFind({
  root: document.getElementById("find") as HTMLElement,
  pane: paneEl,
  view,
  onLayoutChange: () => {
    scheduleContentHeight();
    reportDragRegions();
  },
});

/** Swift owns this — it is a window property, not a document one — and mirrors it back here. */
let hiddenFromCapture = false;
/** Likewise window state, and it changes without this layer being asked: dragging the pane turns it
 *  off (decision 40). Only ever set from Swift. */
let autoSizing = true;
let onEverySpace = true;

const actionsEl = document.getElementById("actions") as HTMLElement;
const switcherEl = document.getElementById("switcher") as HTMLElement;

/* Both overlays are placed by one calculation whenever the panel opens, its height changes, or the
 * pane's height changes after Swift grows the window (decision 45). One `ResizeObserver`, and `top`
 * changes no size, so it cannot feed itself. */
function placeOverlays(): void {
  placeOverlay(switcherEl, paneEl);
  placeOverlay(actionsEl, paneEl);
}

new ResizeObserver(placeOverlays).observe(switcherEl);
new ResizeObserver(placeOverlays).observe(actionsEl);

const actions = mountActionPanel({
  root: actionsEl,
  pane: paneEl,
  isPinned: () => paneEl.hasAttribute("data-pinned"),
  isHiddenFromCapture: () => hiddenFromCapture,
  isAutoSizing: () => autoSizing,
  isOnEverySpace: () => onEverySpace,
  run: (id) => actionHandlers[id]?.(),
  // The keys a row prints come from the bindings in force, not from a literal beside the label.
  // They were literals, so rebinding New Note in the Shortcuts tab left ⌘K still advertising ⌘N —
  // which is exactly what decision 17 forbids: "a row cannot advertise a key that does something
  // else". Rows with no binding of their own (Settings…, which the menu bar owns) keep the literal.
  keysFor: (id) => (liveShortcuts[id] ? keyCaps(liveShortcuts[id]) : null),
  onVisibilityChange: (open, height) => {
    send({ type: "actionsOpen", open, height });
    if (!open) view.focus();
  },
});

const switcher = mountSwitcher({
  root: switcherEl,
  pane: paneEl,
  onQuery: (query) => send({ type: "requestNotes", query }),
  onOpen: (filename) => send({ type: "openNote", filename }),
  onCreate: (title) => send({ type: "createNote", title }),
  onPin: (filename) => send({ type: "togglePin", filename }),
  onDelete: (filename) => send({ type: "deleteNote", filename }),
  onRequestDeleted: () => send({ type: "requestDeleted" }),
  onRestore: (storedName) => send({ type: "restoreDeleted", storedName }),
  onForgetDeleted: (storedName) => send({ type: "forgetDeleted", storedName }),
  onVisibilityChange: (open, height) => {
    send({ type: "switcherOpen", open, height });
    if (!open) view.focus();
  },
});

/** One slot: opening either panel closes the other first, here rather than at every call site
 * (decision 45). */
function toggleSwitcher(): void {
  actions.close();
  switcher.toggle();
}

function toggleActions(): void {
  switcher.close();
  actions.toggle();
}

/* Clicking outside an open overlay closes it and never reaches the note. `mousedown`, prevented: by
 * the time a click completes focus has already left the panel's input (decision 52). */
document.getElementById("overlay-scrim")!.addEventListener("mousedown", (event) => {
  event.preventDefault();
  actions.close();
  switcher.close();
});

/**
 * Does this keydown match a CodeMirror-style binding string — "Mod-k", "Shift-Mod-p", "Alt-Mod-,"?
 *
 * Needed only by the overlay-closing listener below. Everything else goes through CodeMirror's own
 * keymap, which does this properly; this is the one place a key has to be recognised outside it.
 */
function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const parts = binding.split("-");
  const wanted = parts.pop()?.toLowerCase() ?? "";
  let mod = false;
  let shift = false;
  let alt = false;
  let ctrl = false;
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "mod":
      case "cmd":
      case "meta":
        mod = true;
        break;
      case "shift":
        shift = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "ctrl":
      case "control":
        ctrl = true;
        break;
    }
  }
  return (
    event.key.toLowerCase() === wanted &&
    event.metaKey === mod &&
    event.shiftKey === shift &&
    event.altKey === alt &&
    event.ctrlKey === ctrl
  );
}

/** The bindings in force, so the listener below follows a rebind from the Settings window. */
let liveShortcuts: Record<string, string> = { ...DEFAULT_SHORTCUTS };
refreshChromeTooltips();

/** An open overlay's own shortcut closes it: focus is in a plain `<input>` outside CodeMirror, so the
 * keymap never sees the second press. Capture phase, only while open (decision 45). */
document.addEventListener(
  "keydown",
  (event) => {
    // Only while an overlay is up. With the caret in the editor, CodeMirror's keymap is already
    // handling both of these properly and this must stay out of its way.
    if (!actions.isOpen() && !switcher.isOpen()) return;

    const binding = (action: string) => liveShortcuts[action] ?? DEFAULT_SHORTCUTS[action] ?? "";

    // Each key keeps its own meaning from inside either panel: it closes its own panel, and swaps
    // to it from the other one. Handling only the closing half left ⌘K doing nothing at all while
    // the switcher was open, which is a different kind of dead key from the one being fixed.
    if (matchesBinding(event, binding("actionPanel"))) {
      event.preventDefault();
      event.stopPropagation();
      actions.isOpen() ? actions.close() : toggleActions();
      return;
    }
    if (matchesBinding(event, binding("browseNotes"))) {
      event.preventDefault();
      event.stopPropagation();
      switcher.isOpen() ? switcher.close() : toggleSwitcher();
    }
  },
  true
);

// ---------------------------------------------------------------------------------------------
// Inbound — everything Swift can ask the web layer to do
// ---------------------------------------------------------------------------------------------

const host = {
  /**
   * Loads a note and puts the caret back exactly where it was (decision 11).
   *
   * The whole document is replaced rather than diffed: this only runs on a note switch or an
   * external-change reload, and a diff would be a second place for the buffer to drift from the file.
   */
  loadNote(filename: string, text: string, caret: number, pinned: boolean): void {
    applyingRemoteEdit = true;
    // An empty name means a draft: ⌘N no longer touches the disk, so the pane can hold a note that
    // has no file yet. Stored as null rather than "" so every `currentFilename ?` guard here —
    // Delete Note, Pin Pane — declines instead of naming a file that does not exist.
    currentFilename = filename || null;

    const clamped = Math.max(0, Math.min(caret, text.length));
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: clamped },
      scrollIntoView: true,
      // Loading a note is not an edit: without this annotation the first ⌘Z undid the load, emptied the
      // note, and the write model flushed the empty buffer (decision 80).
      annotations: Transaction.addToHistory.of(false),
    });
    // And a fresh stack, so undo cannot reach back past this note into the last one.
    clearHistory();
    applyingRemoteEdit = false;

    paneEl.toggleAttribute("data-pinned", pinned);
    document.getElementById("pin")!.setAttribute("aria-pressed", String(pinned));
    showTitle(text.split("\n"));
    renderCount(text);
    scheduleContentHeight();
  },

  /** Puts the caret in the editor without changing anything — what a summon does. */
  focusEditor(): void {
    view.focus();
  },

  /** Undo describes one sitting with the note: the buffer survives a dismissal offscreen, so a summon
   * starts the history fresh rather than reaching back across it (decision 80, amended 2026-09-17;
   * decision 51's reasoning). */
  resetHistory(): void {
    clearHistory();
  },

  /**
   * The draft on screen has just become a real file.
   *
   * Deliberately not `loadNote`: the buffer is already correct and the user is typing in it, so
   * re-sending the document would replace it under their hands and move the caret. Only the name
   * changes.
   */
  setNoteFilename(filename: string): void {
    currentFilename = filename || null;
  },

  setPinned(pinned: boolean): void {
    paneEl.toggleAttribute("data-pinned", pinned);
    document.getElementById("pin")!.setAttribute("aria-pressed", String(pinned));
  },

  setFocused(focused: boolean): void {
    // Kept for anything that genuinely cares about key state. It no longer drives the chrome —
    // decision 41 moved that to the cursor — and so it no longer changes the title bar's layout,
    // which is why the drag regions do not need re-reporting here any more.
    paneEl.toggleAttribute("data-focused", focused);
  },

  /** Appearance, accent, theme and key bindings. The CSS keys off these attributes and variables. */
  applySettings(settings: {
    appearance?: string;
    accent?: string;
    textSize?: number;
    translucent?: boolean;
    themeCSS?: string;
    shortcuts?: Record<string, string>;
    footerCount?: string;
  }): void {
    const root = document.documentElement;
    if (settings.appearance && settings.appearance !== "system") {
      root.setAttribute("data-appearance", settings.appearance);
    } else {
      root.removeAttribute("data-appearance");
    }
    root.setAttribute("data-vibrancy", settings.translucent === false ? "off" : "on");
    if (settings.textSize) root.style.setProperty("--text-size", `${settings.textSize}px`);
    if (settings.accent) root.style.setProperty("--accent", settings.accent);

    // Decision 19: a theme is a CSS file. Swift reads it and hands over the text; all that happens
    // here is that it goes last in the cascade, after tokens/pane/markdown, so a theme can override
    // any token without !important and without knowing the stylesheet order.
    if (settings.themeCSS !== undefined) themeStyleEl.textContent = settings.themeCSS;

    if (settings.footerCount === "words" || settings.footerCount === "characters") {
      footerCount = settings.footerCount;
      renderCount(view.state.doc.toString());
    }

    if (settings.shortcuts) {
      liveShortcuts = { ...DEFAULT_SHORTCUTS, ...settings.shortcuts };
      view.dispatch({
        effects: shortcutsCompartment.reconfigure(paneShortcuts(settings.shortcuts)),
      });
      // The chrome's bubbles print keys too, and a rebind has to reach them or a button goes on
      // advertising a key that now does something else — decision 17's rule, in its fourth place.
      refreshChromeTooltips();
    }
  },

  showNotes(notes: NoteSummary[], total: number, query: string): void {
    switcher.render(notes, total, query);
  },

  /** Recently Deleted's rows (decision 20). Same shape, same list, different verb on ⏎. */
  showDeleted(notes: NoteSummary[]): void {
    switcher.renderDeleted(notes);
  },

  setHiddenFromCapture(hidden: boolean): void {
    hiddenFromCapture = hidden;
  },

  setOnEverySpace(on: boolean): void {
    onEverySpace = on;
  },

  setAutoSizing(on: boolean): void {
    autoSizing = on;
  },

  /** The close dot alone, from the same read as `setHover`: `:hover` cannot, because the page gets no
   * mouse events with the pane over another app (decision 107). */
  setCloseHover(inside: boolean): void {
    paneEl.toggleAttribute("data-close-hover", inside);
  },

  setHover(inside: boolean): void {
    paneEl.toggleAttribute("data-hover", inside);
    // The dot cannot be hovered when the pane is not: both come from one pointer read, and leaving
    // the pane behind a stale `data-close-hover` would strand a lit dot on a dimmed bar.
    if (!inside) paneEl.removeAttribute("data-close-hover");
    // The pointer can leave a *window* without the page seeing a leave event, and the chrome it was
    // over is about to fade out from under any tooltip naming it.
    if (!inside) hideTooltip();
  },

  /** Where the pointer is, from Swift, on every move: the page gets no mouse events in the state the
   * pane lives in (decision 120). */
  setPointer(x: number, y: number): void {
    setPointer(x, y);
  },

  openSwitcher(): void {
    // Toggle, not open: this is what ⌘P and the menu bar's "Browse Notes…" both land on, and a
    // second press of either should close the list rather than silently do nothing.
    toggleSwitcher();
  },

  openActions(): void {
    // Same contract as `openSwitcher`, for the menu bar's "Actions…". Frame 2a leans on the menu bar
    // as one of ⌘K's two discovery paths; this is that path.
    toggleActions();
  },

  /** Chosen from the native heading menu. */
  setHeadingLevel(level: number): void {
    setHeading(view, level);
  },

  /**
   * The one-line status row: a conflict sibling was written, a note is downloading, or something
   * failed. Never steals the caret and never blocks typing (decision 8).
   */
  /** A transient confirmation. Out of layout, so it never disturbs the reported height. */
  showToast(text: string, dwell?: number): void {
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.removeAttribute("data-fading");
    if (toastTimer) clearTimeout(toastTimer);
    if (toastFadeTimer) clearTimeout(toastFadeTimer);
    // 1900ms reads a short receipt; `dwell` is longer for the one toast that is news (decision 136).
    toastTimer = window.setTimeout(() => {
      toastEl.setAttribute("data-fading", "");
      toastFadeTimer = window.setTimeout(() => {
        toastEl.hidden = true;
      }, 200);
    }, dwell ?? 1900);
  },

  showBanner(kind: string, text: string): void {
    bannerEl.setAttribute("data-kind", kind);
    bannerTextEl.textContent = text;
    bannerEl.hidden = false;
    scheduleContentHeight();
  },

  hideBanner(): void {
    if (bannerEl.hidden) return;
    bannerEl.hidden = true;
    bannerEl.removeAttribute("data-kind");
    scheduleContentHeight();
  },
};

window.paneHost = host;

/* Hover arrives from Swift (`setHover`): the page's own `mouseenter` only fires once the pane has been
 * clicked (decisions 41, 120). The web layer owns no truth. */

// Clicking the banner acknowledges it. That is the whole dismissal affordance: a conflict banner
// with an ✕ would be a control the user must operate before the pane looks normal again, which is
// the interruption decision 8 rules out.
bannerEl.addEventListener("click", () => host.hideBanner());

// Drag regions only, on every title-bar relayout. Never content height: the window's size is not an
// input to how tall the content wants to be, and reporting it here is what made the pane overshoot
// (decision 40, amended 2026-09-17).
new ResizeObserver(() => {
  reportDragRegions();
  placeOverlays();
}).observe(paneEl);

/* The pin enters and leaves the title bar with the pane's pinned state (decision 54), which moves
 * the buttons beside it — and the drag-exclusion rects Swift hit-tests are measured from those
 * boxes. This is the same hook the title's old scroll-gated reveal needed, pointed at the one
 * attribute that still changes the bar's layout. */
new MutationObserver(reportDragRegions).observe(paneEl, {
  attributes: true,
  attributeFilter: ["data-pinned"],
});

reportDragRegions();
send({ type: "ready" });
