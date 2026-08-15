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
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, rectangularSelection } from "@codemirror/view";

import { mountActionPanel } from "./action-panel";
import { findHighlighting, mountFind } from "./find";
import { livePreview, scrollReporter } from "./live-preview";
import { mountSwitcher, type NoteSummary } from "./switcher";
import { mountFormatBar, setHeading } from "./format-bar";
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
  | { type: "switcherOpen"; open: boolean }
  | { type: "actionsOpen"; open: boolean; height: number }
  | { type: "revealInFinder" }
  | { type: "openSettings" }
  | { type: "copyAsMarkdown"; text: string }
  | { type: "exportNote"; text: string }
  | { type: "toggleHideFromCapture" }
  | { type: "requestDeleted" }
  | { type: "restoreDeleted"; storedName: string }
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
  send({ type: "edited", text, caret: view.state.selection.main.head });
  reportContentHeight();
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
function reportContentHeight(): void {
  // `view.contentHeight` is CodeMirror's laid-out document height. `editorHost.scrollHeight` was the
  // obvious choice and always wrong: the host is `height: 100%` and the editor inside it is themed
  // to match, so scrollHeight equals clientHeight forever and the pane reports its *current* height
  // as its desired height — which means rule 2 could never actually fire.
  const content = view.contentHeight;

  // The format bar replaces the footer rather than stacking on it, so only one of them is ever laid
  // out. Measuring whichever is visible avoids assuming which.
  const bar = paneEl.querySelector<HTMLElement>(
    paneEl.hasAttribute("data-format-bar") ? ".format-bar" : ".pane__footer"
  );
  const chrome = titleBarEl.offsetHeight + (bar?.offsetHeight ?? 34) + bannerEl.offsetHeight;

  send({ type: "contentHeight", height: Math.ceil(content + chrome) });
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
 * The shortcuts the Settings window can rebind (design frame 3c).
 *
 * Keyed by the same action names `Settings.shortcutActions` uses on the Swift side — the two lists
 * have to agree, and naming the action rather than the key is what lets the binding change without
 * anything here knowing.
 */
const DEFAULT_SHORTCUTS: Record<string, string> = {
  newNote: "Mod-n",
  browseNotes: "Mod-p",
  pinPane: "Shift-Mod-p",
  formatBar: "Alt-Mod-,",
  actionPanel: "Mod-k",
  revealInFinder: "Alt-Mod-r",
  deleteNote: "Ctrl-x",
  findInNote: "Mod-f",
  copyAsMarkdown: "Shift-Mod-c",
  exportNote: "Shift-Mod-e",
  hideFromCapture: "Shift-Mod-h",
};

const shortcutsCompartment = new Compartment();

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
  browseNotes: () => (switcher.toggle(), true),
  pinPane: () => (send({ type: "togglePin", filename: currentFilename }), true),
  formatBar: () => (toggleFormatBar(), true),
  revealInFinder: () => (send({ type: "revealInFinder" }), true),
  settings: () => (send({ type: "openSettings" }), true),
  deleteNote: () =>
    currentFilename ? (send({ type: "deleteNote", filename: currentFilename }), true) : false,
  findInNote: () => (find?.open(), true),
  // The buffer goes with the message rather than Swift using its own copy. Swift's copy is up to
  // 500 ms stale by design (decision 10's debounce), and a copy that silently omits the last
  // sentence you typed is the kind of bug nobody reports because they blame the paste.
  copyAsMarkdown: () => (send({ type: "copyAsMarkdown", text: view.state.doc.toString() }), true),
  exportNote: () => (send({ type: "exportNote", text: view.state.doc.toString() }), true),
  hideFromCapture: () => (send({ type: "toggleHideFromCapture" }), true),
  recentlyDeleted: () => (switcher.openDeleted(), true),
};

function paneShortcuts(bindings: Record<string, string>): Extension {
  const run: Record<string, () => boolean> = { ...actionHandlers, actionPanel: () => (actions.toggle(), true) };

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
    history(),
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
    checkboxInputRule(),
    editorTheme,
    updateListener,
    scrollReporter((scrolled) => {
      // Decision 22: the title bar stays empty until you scroll past the H1.
      titleBarEl.toggleAttribute("data-scrolled", scrolled);
    }),
    // Enter and Backspace, above everything else.
    //
    // `nonTightLists: false` is the whole reason this is hand-bound. CodeMirror's default, on Enter
    // in an empty list item, inserts a blank line *above* it and keeps the marker — turning a tight
    // list into a loose one, which is CommonMark-correct and is what nobody wants. Every notes app
    // ever written exits the list instead, and pressing Enter twice to get out of a list is muscle
    // memory older than markdown.
    Prec.high(
      keymap.of([
        { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
        { key: "Backspace", run: deleteMarkupBackward },
      ])
    ),

    // Pane's own shortcuts, in their own compartment so the Shortcuts tab can rebind them without
    // rebuilding the editor. Listed before the keymap below so they win over CodeMirror's defaults —
    // within one precedence level, the earlier extension is the higher one.
    shortcutsCompartment.of(paneShortcuts(DEFAULT_SHORTCUTS)),

    keymap.of([
      // The levels the heading dropdown advertises. A shortcut printed in a menu that does nothing
      // is worse than no shortcut.
      { key: "Alt-Mod-1", run: (v) => (setHeading(v, 1), true) },
      { key: "Alt-Mod-2", run: (v) => (setHeading(v, 2), true) },
      { key: "Alt-Mod-3", run: (v) => (setHeading(v, 3), true) },
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
  reportContentHeight();
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
document.getElementById("browse")!.addEventListener("click", () => switcher.toggle());

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
    reportContentHeight();
    reportDragRegions();
  },
});

/** Swift owns this — it is a window property, not a document one — and mirrors it back here. */
let hiddenFromCapture = false;

const actions = mountActionPanel({
  root: document.getElementById("actions") as HTMLElement,
  pane: paneEl,
  isPinned: () => paneEl.hasAttribute("data-pinned"),
  isHiddenFromCapture: () => hiddenFromCapture,
  run: (id) => actionHandlers[id]?.(),
  onVisibilityChange: (open, height) => {
    send({ type: "actionsOpen", open, height });
    if (!open) view.focus();
  },
});

const switcher = mountSwitcher({
  root: document.getElementById("switcher") as HTMLElement,
  pane: paneEl,
  onQuery: (query) => send({ type: "requestNotes", query }),
  onOpen: (filename) => send({ type: "openNote", filename }),
  onCreate: (title) => send({ type: "createNote", title }),
  onPin: (filename) => send({ type: "togglePin", filename }),
  onDelete: (filename) => send({ type: "deleteNote", filename }),
  onRequestDeleted: () => send({ type: "requestDeleted" }),
  onRestore: (storedName) => send({ type: "restoreDeleted", storedName }),
  onVisibilityChange: (open) => {
    send({ type: "switcherOpen", open });
    if (!open) view.focus();
  },
});

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
    currentFilename = filename;

    const clamped = Math.max(0, Math.min(caret, text.length));
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: clamped },
      scrollIntoView: true,
    });
    applyingRemoteEdit = false;

    paneEl.toggleAttribute("data-pinned", pinned);
    document.getElementById("pin")!.setAttribute("aria-pressed", String(pinned));
    paneTitleEl.textContent = text.split("\n", 1)[0]?.replace(/^#+\s*/, "") ?? "";
    wordCountEl.textContent = formatWordCount(countWords(text));
    reportContentHeight();
  },

  /** Puts the caret in the editor without changing anything — what a summon does. */
  focusEditor(): void {
    view.focus();
  },

  setPinned(pinned: boolean): void {
    paneEl.toggleAttribute("data-pinned", pinned);
    document.getElementById("pin")!.setAttribute("aria-pressed", String(pinned));
  },

  setFocused(focused: boolean): void {
    paneEl.toggleAttribute("data-focused", focused);
    // Losing focus takes two buttons out of the title bar (frame 1e), so the draggable strip is a
    // different shape. Neither observer below catches this — one watches the title bar's own
    // attributes and the other the pane's size, and this changes neither.
    reportDragRegions();
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
      view.dispatch({
        effects: shortcutsCompartment.reconfigure(paneShortcuts(settings.shortcuts)),
      });
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

  openSwitcher(): void {
    // Toggle, not open: this is what ⌘P and the menu bar's "Browse Notes…" both land on, and a
    // second press of either should close the list rather than silently do nothing.
    switcher.toggle();
  },

  /** Chosen from the native heading menu. */
  setHeadingLevel(level: number): void {
    setHeading(view, level);
  },

  /**
   * The one-line status row: a conflict sibling was written, a note is downloading, or something
   * failed. Never steals the caret and never blocks typing (decision 8).
   */
  showBanner(kind: string, text: string): void {
    bannerEl.setAttribute("data-kind", kind);
    bannerTextEl.textContent = text;
    bannerEl.hidden = false;
    reportContentHeight();
  },

  hideBanner(): void {
    if (bannerEl.hidden) return;
    bannerEl.hidden = true;
    bannerEl.removeAttribute("data-kind");
    reportContentHeight();
  },
};

window.paneHost = host;

// Clicking the banner acknowledges it. That is the whole dismissal affordance: a conflict banner
// with an ✕ would be a control the user must operate before the pane looks normal again, which is
// the interruption decision 8 rules out.
bannerEl.addEventListener("click", () => host.hideBanner());

// The draggable strip changes whenever the title bar relays out — the pane resizing, the title
// fading in past the H1, the format bar swapping the footer out.
new ResizeObserver(() => {
  reportDragRegions();
  reportContentHeight();
}).observe(paneEl);

new MutationObserver(reportDragRegions).observe(titleBarEl, {
  attributes: true,
  attributeFilter: ["data-scrolled"],
});

reportDragRegions();
send({ type: "ready" });
