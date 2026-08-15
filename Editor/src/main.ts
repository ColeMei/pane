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

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, rectangularSelection } from "@codemirror/view";

import { livePreview, scrollReporter } from "./live-preview";
import { mountSwitcher, type NoteSummary } from "./switcher";
import { mountFormatBar } from "./format-bar";
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
  | { type: "switcherOpen"; open: boolean };

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
  const content = editorHost.scrollHeight;
  const chrome = titleBarEl.offsetHeight + (paneEl.querySelector(".pane__footer") as HTMLElement | null)?.offsetHeight!;
  send({ type: "contentHeight", height: content + (Number.isFinite(chrome) ? chrome : 74) });
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
});

function baseExtensions(): Extension[] {
  return [
    history(),
    drawSelection(),
    rectangularSelection(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage }),
    livePreview(),
    editorTheme,
    updateListener,
    scrollReporter((scrolled) => {
      // Decision 22: the title bar stays empty until you scroll past the H1.
      titleBarEl.toggleAttribute("data-scrolled", scrolled);
    }),
    keymap.of([
      // Pane's own shortcuts come first so they win over the editor's defaults.
      { key: "Mod-p", run: () => (switcher.open(), true) },
      { key: "Mod-n", run: () => (send({ type: "createNote", title: "" }), true) },
      { key: "Shift-Mod-p", run: () => (send({ type: "togglePin", filename: currentFilename }), true) },
      { key: "Alt-Mod-,", run: () => (toggleFormatBar(), true) },
      indentWithTab,
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
  paneEl.toggleAttribute("data-format-bar");
}

document.getElementById("format-toggle")!.addEventListener("click", toggleFormatBar);
document.getElementById("close")!.addEventListener("click", () => send({ type: "close" }));
document.getElementById("new-note")!.addEventListener("click", () =>
  send({ type: "createNote", title: "" })
);
document.getElementById("pin")!.addEventListener("click", () =>
  send({ type: "togglePin", filename: currentFilename })
);
document.getElementById("browse")!.addEventListener("click", () => switcher.open());

mountFormatBar(document.getElementById("format-bar") as HTMLElement, view, toggleFormatBar);

const switcher = mountSwitcher({
  root: document.getElementById("switcher") as HTMLElement,
  pane: paneEl,
  onQuery: (query) => send({ type: "requestNotes", query }),
  onOpen: (filename) => send({ type: "openNote", filename }),
  onCreate: (title) => send({ type: "createNote", title }),
  onPin: (filename) => send({ type: "togglePin", filename }),
  onDelete: (filename) => send({ type: "deleteNote", filename }),
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
  },

  /** Appearance and vibrancy come from settings; the CSS keys off these attributes. */
  applySettings(settings: { appearance?: string; textSize?: number; translucent?: boolean }): void {
    const root = document.documentElement;
    if (settings.appearance && settings.appearance !== "system") {
      root.setAttribute("data-appearance", settings.appearance);
    } else {
      root.removeAttribute("data-appearance");
    }
    root.setAttribute("data-vibrancy", settings.translucent === false ? "off" : "on");
    if (settings.textSize) root.style.setProperty("--text-size", `${settings.textSize}px`);
  },

  showNotes(notes: NoteSummary[], total: number, query: string): void {
    switcher.render(notes, total, query);
  },

  openSwitcher(): void {
    switcher.open();
  },
};

window.paneHost = host;

send({ type: "ready" });
