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
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
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
import { describe, hideTooltip, mountTooltips } from "./tooltip";
import { findHighlighting, mountFind } from "./find";
import { caretBlankLineSlack, livePreview } from "./live-preview";
import { renumberOrderedLists } from "./renumber";
import { mountSwitcher, type NoteSummary } from "./switcher";
import { MARKDOWN_FORMAT_KEYS, mountFormatBar, setHeading } from "./format-bar";
import { noteTitle } from "./note-title";
import { countWords } from "./word-count";

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
  | { type: "openSettings" }
  | { type: "copyAsMarkdown"; text: string }
  | { type: "exportNote"; text: string }
  | { type: "toggleHideFromCapture" }
  | { type: "toggleAutoSizing" }
  | { type: "duplicateNote"; text: string }
  | { type: "requestDeleted" }
  | { type: "restoreDeleted"; storedName: string }
  | { type: "forgetDeleted"; storedName: string }
  | { type: "textSize"; action: "in" | "out" | "reset" }
  | { type: "navigate"; back: boolean }
  | { type: "dragRegions"; titleBar: Rect; exclusions: Rect[] }
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
  wordCountEl.textContent = formatWordCount(countWords(text));
  showTitle(view.state.doc.iterLines());
  send({ type: "edited", text, caret: view.state.selection.main.head });
  scheduleContentHeight();
}

/**
 * The note's name, which is its first non-blank line (decision 2), read as prose.
 *
 * Follows the first line as it is typed, not only as it is loaded. That was harmless while the
 * title bar was empty until you scrolled (decision 22) and is not now it is always there: a note
 * created with ⌘N had no title at all until it was next opened, so the pane spent the whole of the
 * writing sitting there unnamed.
 *
 * The extraction is `noteTitle`, a port of the Swift the ⌘P switcher already uses. What used to be
 * here stripped `#` and nothing else, off line 1 and no further — so a note beginning
 * `**A research plan**` put the asterisks in the title bar while the switcher showed the words, and
 * a note whose first line was blank was nameless in the bar and named in the list. Two answers to
 * "what is this note called" is one too many.
 */
function showTitle(lines: Iterable<string>): void {
  // "Untitled" rather than nothing, which is what an empty note showed until ⌘N stopped writing a
  // file the moment it was pressed. A pane with no title and no text reads as broken; the reference
  // names it, and the switcher already calls a nameless note Untitled, so this is the two agreeing.
  paneTitleEl.textContent = noteTitle(lines) || "Untitled";
}

function formatWordCount(n: number): string {
  return `${n} ${n === 1 ? "word" : "words"}`;
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
 * Asks for a height at most once per frame, and at most once more after that.
 *
 * The pane visibly overshot and corrected on every new line. The loop: the web layer reports a
 * height, Swift resizes the window, the `ResizeObserver` on the pane sees that resize and reports
 * again — and the second answer differs, because CodeMirror only lays out the lines in view and
 * *estimates* the rest, so growing the window turns estimates into measurements. Report, resize,
 * re-estimate, resize.
 *
 * So the observer no longer drives this at all (it still reports drag regions, which genuinely do
 * depend on window size). Content height is asked for when the *content* changes, plus exactly one
 * settle pass afterwards to pick up CodeMirror's refined layout. Two steps, and it cannot chain.
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
  // `view.contentHeight` is CodeMirror's laid-out document height. `editorHost.scrollHeight` was the
  // obvious choice and always wrong: the host is `height: 100%` and the editor inside it is themed
  // to match, so scrollHeight equals clientHeight forever and the pane reports its *current* height
  // as its desired height — which means rule 2 could never actually fire.
  // Minus the caret's blank-line exemption: that 12px is a rendering choice, and a window that
  // followed it would pulse every time the caret crossed a blank line. See `caretBlankLineSlack`.
  const content = view.contentHeight - caretBlankLineSlack(view);

  // The format bar replaces the footer rather than stacking on it, so only one of them is ever laid
  // out. Measuring whichever is visible avoids assuming which.
  // Whichever of the three is actually laid out, found by measuring rather than by re-deriving the
  // rule from attributes. The old version asked `data-format-bar` and otherwise took the footer —
  // which is wrong in the third state: with ⌘F open, `.pane[data-find]` hides *both* the footer and
  // the format bar, so it measured a `display: none` element, got 0, and dropped the whole row out
  // of the height. The pane shrank by the find bar's height when find opened and grew back when it
  // closed. A fourth state could not make this wrong again.
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

/**
 * Tells Swift where the window may be dragged from.
 *
 * `-webkit-app-region: drag` in `pane.css` is what the design's markup uses, and it is an
 * Electron/Tauri extension that a WKWebView ignores entirely — so the title bar would not move the
 * window at all without this. The web layer is the only place that knows where the buttons ended up
 * after layout, so it measures and Swift hit-tests: rule 3, "only a drag moves a pane", without
 * hard-coding a single button position into Swift.
 */
function reportDragRegions(): void {
  const bar = titleBarEl.getBoundingClientRect();
  const exclusions = Array.from(titleBarEl.querySelectorAll("button")).map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

  send({
    type: "dragRegions",
    titleBar: { x: bar.x, y: bar.y, width: bar.width, height: bar.height },
    exclusions,
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

/**
 * `- []` + space becomes `- [ ] `, which is how everyone actually types a checkbox.
 *
 * Typora, Obsidian and Bear all do this, and it is the one markdown construct whose real syntax
 * nobody remembers — `[ ]` with a space inside the brackets. Getting it wrong produces literal text
 * that looks like a bug in the renderer.
 *
 * An input handler rather than a decoration, because it must change the buffer: decision 5 says what
 * is on disk is what was typed, so a checkbox the user can see has to be a checkbox on disk.
 */
/**
 * A new bullet takes the marker the list is already using.
 *
 * `-`, `*` and `+` all mean "bullet", and they all render as one here — but CommonMark treats a
 * change of character as the *end of one list and the start of another*, so typing `* first` then
 * `- second` produces two lists that happen to sit next to each other. The rendering gives that
 * away (they are spaced as two blocks, decision 55) and nothing on screen explains why.
 *
 * So the marker is normalised to whatever the item above it uses, at the moment the space after it
 * is typed. It edits the buffer rather than the rendering, which is the only honest place for it:
 * decision 5 says the file is what you typed, and what you meant to type was another item in the
 * list you were already in. Only when there is a list directly above at the same indent — the first
 * bullet of a list is still whatever character you chose.
 */
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
 * ⇧⏎ — get out of a fenced code block.
 *
 * Inside a code block every Enter is a newline *in the code*, which is correct and is also a trap:
 * the only way back to prose is to reach the last line, move past the closing fence, and start a
 * line there — and decision 34 collapsed the fences to the height of a blank line, so the thing you
 * have to navigate past is nearly invisible. Every editor with live preview grows some way out;
 * this is that way out.
 *
 * Returns false anywhere else, so ⇧⏎ keeps whatever meaning CodeMirror gives it outside a block.
 */
function escapeCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;

  let node = syntaxTree(state).resolveInner(head, -1);
  while (node.parent && node.name !== "FencedCode" && node.name !== "CodeBlock") {
    node = node.parent;
  }
  if (node.name !== "FencedCode" && node.name !== "CodeBlock") return false;

  const closing = state.doc.lineAt(Math.min(node.to, state.doc.length));

  // Already the last line of the document: there is nowhere to go, so make somewhere.
  if (closing.number === state.doc.lines) {
    view.dispatch({
      changes: { from: state.doc.length, insert: "\n" },
      selection: { anchor: state.doc.length + 1 },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }

  // Land on the line below if it is free, and only add one when it is not — pressing this twice
  // should not leave a trail of blank lines behind the block.
  const next = state.doc.line(closing.number + 1);
  if (next.text.trim() === "") {
    view.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
  } else {
    view.dispatch({
      changes: { from: closing.to, insert: "\n" },
      selection: { anchor: closing.to + 1 },
      scrollIntoView: true,
      userEvent: "input",
    });
  }
  return true;
}

/** Walks up from `pos` looking for an enclosing node — the same walk `escapeCodeBlock` does. */
function inside(state: EditorState, pos: number, nodeName: string): boolean {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node.name !== nodeName && node.parent) node = node.parent;
  return node.name === nodeName;
}

/**
 * The blocks ⌘A steps through, innermost first.
 *
 * `ListItem` is in the set *and* preferred over the `Paragraph` inside it: a bullet's paragraph is
 * its text without the marker, while a task item has no paragraph at all and would otherwise select
 * a different thing from every other list. One rule for both.
 */
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

/**
 * ⌘A selects the block you are in; press it again for the whole note.
 *
 * Typora, Obsidian and every editor with a block model do this, and it is the difference between
 * "replace this paragraph" being one keystroke and being a drag. The second press is not a special
 * case in here — when the selection already *is* the block, this declines and CodeMirror's own
 * `selectAll` takes the key, which also means ⌘A on a one-paragraph note does the obvious thing on
 * the first press.
 */
function selectBlockThenAll(view: EditorView): boolean {
  const state = view.state;
  const range = state.selection.main;
  if (range.from === 0 && range.to === state.doc.length) return false;

  let node = syntaxTree(state).resolveInner(range.head, -1);
  while (node.parent && !SELECTABLE_BLOCKS.has(node.name)) node = node.parent;
  if (!SELECTABLE_BLOCKS.has(node.name)) return false;

  // A list item's own range, not the paragraph inside it — see SELECTABLE_BLOCKS.
  if (node.parent?.name === "ListItem") node = node.parent;

  if (range.from === node.from && range.to === node.to) return false;

  view.dispatch({ selection: EditorSelection.range(node.from, node.to) });
  return true;
}

/**
 * Backspace undoes a paragraph break instead of turning it into a soft one.
 *
 * ⏎ writes `\n\n` (decision 63), so a plain Backspace deletes one of them and leaves the two
 * paragraphs joined into a single **soft-broken** one — which renders as two lines 20pt apart and
 * reads as the editor deciding every paragraph needs a spare line in it. Decision 78 fixed that for
 * the one position it was reported from, the caret on the empty line ⏎-at-the-end-of-a-paragraph
 * leaves you on, and **the guard it used made that the only position it covered.** Measured on the
 * running build, the other three all still produced the soft break:
 *
 *   - ⏎ in the *middle* of a paragraph puts the caret at the start of the new one, which is not an
 *     empty line — so ⌫ straight afterwards was not the inverse of the ⏎ that had just run.
 *   - The caret on the blank line *between* two paragraphs.
 *   - The caret at the start of the second paragraph.
 *
 * Worse, pressing it twice from there ate a character of the paragraph above while leaving the soft
 * break in place, so the obvious recovery made things worse.
 *
 * The rule is one rule now: **a caret at the start of a line with a blank line above it deletes the
 * break, not half of it.** The paragraphs join, which is what every block editor does and what the
 * ⏎ being undone had separated. A soft break is still one ⇧⏎ away.
 */
function joinBackToParagraph(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const doc = state.doc;
  const line = doc.lineAt(range.head);
  if (range.head !== line.from) return false;

  // Inside a fenced block a blank line is content, not a paragraph break, and Backspace there means
  // delete one character, as it does in any code editor.
  for (let node = syntaxTree(state).resolveInner(range.head, 1); node.parent; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
  }

  // Standing at the start of a line with a blank one above it: the break is the two newlines
  // *before* the caret. Line 3 at the earliest, because the deletion starts at the newline before
  // the blank line and at line 2 that offset is -1 — the original guard said `< 2` and was saved
  // only by an emptiness test this no longer applies.
  if (line.number >= 3 && doc.line(line.number - 1).length === 0) {
    const blank = doc.line(line.number - 1);
    view.dispatch({
      changes: { from: blank.from - 1, to: range.head },
      selection: { anchor: blank.from - 1 },
      userEvent: "delete.backward",
    });
    return true;
  }

  // Standing *on* the blank line that separates two paragraphs: the break is the newline before the
  // caret and the one after it. Deleting only the first is what left the soft break, and pressing
  // Backspace again then ate a character of the paragraph above while the soft break stayed.
  if (
    line.length === 0 &&
    line.number >= 2 &&
    line.number < doc.lines &&
    doc.line(line.number - 1).length !== 0 &&
    doc.line(line.number + 1).length !== 0
  ) {
    view.dispatch({
      changes: { from: doc.line(line.number - 1).to, to: line.to + 1 },
      selection: { anchor: doc.line(line.number - 1).to },
      userEvent: "delete.backward",
    });
    return true;
  }

  return false;
}

/** Built once. It is the ⏎ binding as well, so the two keys cannot drift apart. */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/**
 * Blocks where ⏎ must stay a single newline.
 *
 * A list or a quote is handled by `continueMarkup` before this runs; they are named here anyway so
 * that a change in that command cannot silently hand prose's rule to a list. Code is the one that
 * genuinely needs it: `continueMarkup` declines inside a fence — there is no list context — so
 * without this, ⏎ in a code block would start inserting blank lines into the code.
 */
const NOT_PROSE = new Set([
  "ListItem",
  "Blockquote",
  "FencedCode",
  "CodeBlock",
  "Table",
  "HTMLBlock",
]);

/**
 * ⏎ starts a new paragraph. ⇧⏎ stays in the one you are in.
 *
 * These two did the same thing until now, and the thing they did was the *wrong* one: ⏎ inserted a
 * single newline, which in CommonMark is a soft break **inside the same paragraph**. So pressing
 * Return in prose never started a paragraph — it added a line to the one you were already in, and
 * you had to press it twice to get a block break.
 *
 * Which means decision 55's rhythm has been correct and unreachable since the day it landed. It
 * renders 20pt between lines inside a block and 28pt between two blocks, measured against the
 * reference; the keyboard could only ever produce the first of those. Nothing about the spacing
 * changes here. ⏎ now writes the blank line that the 28pt has always been waiting for.
 *
 * `\n\n` rather than a hard break (`  \n`) because a paragraph break is what is meant, and it is
 * what every markdown tool that will ever open the file reads it as. ⇧⏎ keeps the single newline,
 * which is CodeMirror's own default and is the soft break — "new line, same paragraph".
 *
 * One newline rather than two when there is nothing but whitespace before the caret on its line:
 * the line being left behind is already blank, so a second would stack empty lines up every time
 * Return was held down.
 */
function newParagraph(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;

  let node = syntaxTree(state).resolveInner(head, -1);
  while (node.parent) {
    if (NOT_PROSE.has(node.name)) return false;
    node = node.parent;
  }

  const line = state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  const insert = before.trim() === "" ? "\n" : "\n\n";

  view.dispatch({
    ...state.replaceSelection(insert),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/**
 * Tries each command in turn, stopping at the first that handles the key.
 *
 * Written out rather than relying on two entries for one key inside a single `keymap.of`: the order
 * matters here and this way it is readable at the binding.
 */
function chain(...commands: ((view: EditorView) => boolean)[]) {
  return (view: EditorView): boolean => commands.some((run) => run(view));
}

/**
 * ⏎ on a line holding nothing but blockquote markers leaves the quote.
 *
 * Every list type already does this — `continueMarkup` exits an empty item, and pressing Enter twice
 * to get out is muscle memory older than markdown. A blockquote was the single construct that did
 * not: `> quoted` and then ⏎ on the empty `> ` gave a bare `>` and another `> `, so the quote
 * continued for as long as you kept pressing and there was no way out but Backspace. Measured across
 * every block type; it was the only exception, which is the argument for fixing it rather than
 * calling it markdown's behaviour.
 *
 * One level at a time, because that is what an empty nested list item does.
 */
function exitEmptyBlockquote(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  const match = /^(\s*)((?:>[ \t]*)+)$/.exec(line.text);
  const [, indent, markers] = match ?? [];
  if (indent === undefined || markers === undefined) return false;

  // The regex on its own would also fire on a `>` typed inside a code block, where it is just text.
  if (!inside(state, range.head, "Blockquote")) return false;

  // Drop the last `>` and keep the rest of the prefix exactly as it was typed. Rebuilding it as
  // `"> ".repeat(n)` would turn `>>>` into `> > ` — both are valid two-level quotes, but silently
  // restyling markdown the user wrote is not something a byte-for-byte editor gets to do.
  const outer = markers.slice(0, markers.lastIndexOf(">")).replace(/[ \t]+$/, "");
  const next = outer ? `${indent}${outer} ` : "";

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    selection: { anchor: line.from + next.length },
    userEvent: "input",
  });
  return true;
}

/**
 * A line whose entire content is a list marker — `-`, `*`, `+`, `1.`, `1)`, with or without `[ ]`.
 *
 * The optional `>` prefix is there because a list inside a blockquote is still an empty list item:
 * without it `> - ` fell through to a plain newline and left the marker behind, which is the exact
 * debris this command exists to stop.
 */
const EMPTY_LIST_ITEM = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]*(?:\[[ xX]\][ \t]*)?$/;

/**
 * ⇧⏎ on a line that is nothing but markup does what ⏎ does.
 *
 * ⇧⏎ means "newline, do not continue the markup", and on a line whose only content IS markup there
 * is nothing to carry forward — so the old behaviour left the marker sitting there: `- item`, an
 * empty `- `, and ⇧⏎ gave `- item`, `- `, and a new line, i.e. a bullet with nothing after it that
 * the user then has to delete. Delegates to `continueMarkup` rather than reimplementing the exit, so
 * nested items outdent exactly as they do on ⏎.
 */
function exitEmptyMarkup(view: EditorView): boolean {
  if (exitEmptyBlockquote(view)) return true;

  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  if (!EMPTY_LIST_ITEM.test(line.text)) return false;
  if (!inside(state, range.head, "ListItem")) return false;

  return continueMarkup(view);
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
};

const shortcutsCompartment = new Compartment();

/**
 * The undo history, in a compartment so it can be **thrown away when the note changes**.
 *
 * Undo belongs to the note, not to the pane. Without this the one history spans every note you
 * have opened, so ⌘Z after switching walks backwards into the note before — which is not undo, it
 * is ⌘[ wearing undo's key, and it writes the previous note's text into the current note's file.
 */
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


/**
 * What every ⌘K row does, keyed by the same id the panel's rows carry.
 *
 * One table, two callers: the panel runs an entry when a row is chosen, and the keymap binds the
 * same entry to that row's advertised shortcut. Written once because the alternative is a row whose
 * printed key does something subtly different from clicking it — and a shortcut printed next to an
 * action that does not do that thing is worse than no shortcut at all, which is the same reasoning
 * that made the format bar's heading dropdown a real menu.
 */
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
  duplicateNote: () => (send({ type: "duplicateNote", text: view.state.doc.toString() }), true),
  recentlyDeleted: () => (switcher.openDeleted(), true),
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

    // `addKeymap: false` because the default Enter binding is wrong for a notes app — see the
    // high-precedence keymap below.
    markdown({ base: markdownLanguage, addKeymap: false }),

    // Auto-close only the three that help in prose. The CodeMirror default also closes `'` and `"`,
    // which in a document made of sentences is a liability rather than a feature — an apostrophe is
    // not an opening quote.
    markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "`"] } }),
    closeBrackets(),

    livePreview(),
    findHighlighting(),
    // Ordered lists count themselves. A filter that writes to the document, so it declares the
    // transactions it is *for* rather than the ones it is against — see the file's own note, and
    // decision 81, which is what happened the first time that was the other way round.
    renumberOrderedLists(),
    // An empty note said nothing at all — a caret in a blank rectangle. The reference prompts, and
    // it matters more here than it does there: ⌘N now leaves nothing on disk until the first write,
    // so an empty pane is genuinely a blank page rather than a file that already exists.
    placeholder("Start writing…"),
    checkboxInputRule(),
    bulletInputRule(),
    editorTheme,
    updateListener,
    // Enter and Backspace, above everything else.
    //
    // `nonTightLists: false` is the whole reason this is hand-bound. CodeMirror's default, on Enter
    // in an empty list item, inserts a blank line *above* it and keeps the marker — turning a tight
    // list into a loose one, which is CommonMark-correct and is what nobody wants. Every notes app
    // ever written exits the list instead, and pressing Enter twice to get out of a list is muscle
    // memory older than markdown.
    Prec.high(
      keymap.of([
        // ⇧⏎, in order: get out of a code block, else leave an empty marker line, else fall through
        // to CodeMirror's plain newline. Every one of those is "a newline that does not carry the
        // markup forward"; the chain is which flavour of that applies where.
        { key: "Shift-Enter", run: chain(escapeCodeBlock, exitEmptyMarkup) },
        // In order: leave an empty quote, continue a list or quote, else start a new paragraph.
        // `continueMarkup` declines in prose (it needs a list or quote context), which is what
        // leaves the last link reachable at all.
        { key: "Enter", run: chain(exitEmptyBlockquote, continueMarkup, newParagraph) },
        { key: "Backspace", run: chain(joinBackToParagraph, deleteMarkupBackward) },
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
      indentWithTab,
      // After the markdown bindings above, so Backspace only deletes a bracket pair once
      // `deleteMarkupBackward` has declined the position.
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}

/**
 * Throws the undo stack away.
 *
 * **Out of the configuration, then back in** — and that is not ceremony. `history()` returns a
 * module-level `StateField`, so reconfiguring the compartment with a *fresh* `history()` hands back
 * the same field with the same stack still in it. Removing the field is what discards its state;
 * re-adding it calls `create` and starts empty. Reconfiguring in place looks like it works and does
 * nothing, which is this codebase's oldest genre of bug (decision 71).
 */
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

document.getElementById("format-toggle")!.addEventListener("click", toggleFormatBar);
document.getElementById("close")!.addEventListener("click", () => send({ type: "close" }));
document.getElementById("new-note")!.addEventListener("click", () =>
  send({ type: "createNote", title: "" })
);
document.getElementById("pin")!.addEventListener("click", () =>
  send({ type: "togglePin", filename: currentFilename })
);
document.getElementById("browse")!.addEventListener("click", () => toggleSwitcher());
document.getElementById("open-actions")!.addEventListener("click", () => toggleActions());

/*
 * Every button in the pane names itself the same way (decision 58's bubble, generalised).
 *
 * The strings carry their shortcut, and the same string becomes the accessible name — so a button
 * cannot advertise a key in one place and something else in another, which is the defect decisions
 * 47 and 49 were both instances of.
 */
mountTooltips(paneEl);

/**
 * The chrome's tooltips, **read from the binding in force** rather than written out.
 *
 * They were literals — "Actions ⌘K", "Notes ⌘P", "New note ⌘N" — so rebinding Browse Notes to ⌘O
 * left the switcher button still promising ⌘P. That is decision 17's rule broken in a fourth place:
 * decision 68 fixed the ⌘K rows and the File menu and did not reach here, because a tooltip is
 * mounted once at start-up and nothing was re-reading it. `refreshChromeTooltips` is called again
 * whenever settings arrive, which is the same hook the ⌘K rows already use.
 */
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

const actionsEl = document.getElementById("actions") as HTMLElement;
const switcherEl = document.getElementById("switcher") as HTMLElement;

/*
 * Both overlays are placed by one calculation, whenever anything it depends on moves.
 *
 * Three things move it: the panel opening, its own height changing as a filter narrows the list,
 * and the pane's height changing — which happens *after* the panel opens, because the panel reports
 * the height it wants and Swift grows the window to it (decision 45). A `ResizeObserver` on all
 * three is one hook instead of three call sites, and setting `top` changes no size, so it cannot
 * feed itself.
 */
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

/**
 * The switcher and ⌘K occupy the same slot, so only one of them is ever open.
 *
 * They are absolutely positioned at the same offset with adjacent z-indexes, so opening the second
 * simply stacked it on the first — two search fields and two lists on screen at once, with the
 * keystrokes going to whichever happened to hold focus. Every entry point goes through these rather
 * than calling `toggle` directly, because "close the other one first" is not something a call site
 * should be able to forget.
 */
function toggleSwitcher(): void {
  actions.close();
  switcher.toggle();
}

function toggleActions(): void {
  switcher.close();
  actions.toggle();
}

/*
 * Clicking outside an open overlay closes it, and never reaches the note.
 *
 * `mousedown` rather than `click`, and prevented: by the time a click completes the browser has
 * already moved focus, and focus leaving the panel's `<input>` is the whole bug — the editor took
 * the caret back while the panel stayed on screen, so the next keystroke was typed into the
 * document under it. Closing here also hands focus back to the editor, through the same
 * `onVisibilityChange` path every other close goes through.
 */
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

/**
 * An open overlay's own shortcut closes it.
 *
 * Opening either panel moves focus into its `<input>`, a plain DOM node outside CodeMirror — so the
 * keymap that opened the panel never sees the second press. ⌘K opened the action panel and then did
 * nothing at all for as long as it was up. Escape still worked, which is what disguised it.
 *
 * Capture phase, and only while that overlay is open, so it cannot shadow the editor's own bindings
 * the rest of the time.
 */
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
      /*
       * **Loading a note is not an edit, and ⌘Z must not be able to undo it.**
       *
       * This dispatch replaces the whole document, and without the annotation it went into the undo
       * history like anything else — so the first ⌘Z in any note reversed *the load*, which is to
       * say it emptied the document. Then the write model flushed the empty buffer to the file, in
       * as long as it takes to notice. Measured: undo straight after opening a note, undo after an
       * ordinary edit, and undo after switching notes all left an empty document.
       *
       * This has been true since the first commit — `addToHistory` has never appeared in this file
       * — which makes it the oldest and worst bug in the product, and the only one found by someone
       * pressing ⌘Z rather than by reading anything.
       */
      annotations: Transaction.addToHistory.of(false),
    });
    // And a fresh stack, so undo cannot reach back past this note into the last one.
    clearHistory();
    applyingRemoteEdit = false;

    paneEl.toggleAttribute("data-pinned", pinned);
    document.getElementById("pin")!.setAttribute("aria-pressed", String(pinned));
    showTitle(text.split("\n"));
    wordCountEl.textContent = formatWordCount(countWords(text));
    scheduleContentHeight();
  },

  /** Puts the caret in the editor without changing anything — what a summon does. */
  focusEditor(): void {
    view.focus();
  },

  /**
   * Undo describes **this sitting with the note**, so a summon starts a fresh one.
   *
   * Dismissing does not reload the note — the buffer and its history survive offscreen, which is
   * what keeps a summon under 100ms. So without this, ⌘Z after a summon reaches back across the
   * dismissal into typing that happened before it, and CodeMirror groups a continuous burst into
   * one event: write a note in one go, dismiss, come back an hour later, press ⌘Z once, and the
   * whole note is gone — then the write model flushes the empty buffer to the file.
   *
   * That is not the same bug as decision 80's, which was the *load* being undoable, and it is not
   * fixed by fixing that one. It is the same reasoning decision 51 used for the visit history: this
   * describes one sitting with the app, and reaching across a dismissal into text you no longer
   * have any context for is worse than starting fresh.
   */
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

  setAutoSizing(on: boolean): void {
    autoSizing = on;
  },

  /**
   * Seeds the hover state when the pane appears (decision 41).
   *
   * `mouseenter` fires on a pointer crossing a boundary, and summoning moves the boundary instead —
   * so a pane that opens underneath a stationary cursor is hovered without any event ever saying
   * so, and would sit there dimmed until the mouse twitched. Swift knows where the pointer is
   * relative to the new frame; the web layer cannot.
   */
  setHover(inside: boolean): void {
    paneEl.toggleAttribute("data-hover", inside);
    // The pointer can leave a *window* without the page seeing a leave event, and the chrome it was
    // over is about to fade out from under any tooltip naming it.
    if (!inside) hideTooltip();
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
  showToast(text: string): void {
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.removeAttribute("data-fading");
    if (toastTimer) clearTimeout(toastTimer);
    if (toastFadeTimer) clearTimeout(toastFadeTimer);
    // Long enough to read a short sentence, short enough not to sit over the note you moved on to.
    toastTimer = window.setTimeout(() => {
      toastEl.setAttribute("data-fading", "");
      toastFadeTimer = window.setTimeout(() => {
        toastEl.hidden = true;
      }, 200);
    }, 1900);
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

/*
 * Hover arrives from Swift (`setHover`), not from listeners here.
 *
 * `mouseenter`/`mouseleave` in the page only fired once the pane had been clicked: a WKWebView in a
 * window that is not key receives no mouse events at all, so the chrome stayed dim wherever the
 * pointer went — in precisely the situation decision 41 exists for, the pane sitting over another
 * app you are working in. Swift's mouse monitors see the pointer regardless of which app is active,
 * which is also the rule everywhere else here: the web layer owns no truth.
 */

// Clicking the banner acknowledges it. That is the whole dismissal affordance: a conflict banner
// with an ✕ would be a control the user must operate before the pane looks normal again, which is
// the interruption decision 8 rules out.
bannerEl.addEventListener("click", () => host.hideBanner());

// The draggable strip changes whenever the title bar relays out — the pane resizing, the title
// fading in past the H1, the format bar swapping the footer out.
// Drag regions only. This used to report content height too, which is what made the pane overshoot
// and correct — see the note on `scheduleContentHeight`. The window's own size can never be an
// input to how tall the content wants to be, because the width is fixed (decision 22's measure) and
// nothing else about the note depends on the window.
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
