/*
 * The ⌘K action panel — design frame 2a.
 *
 * Decision 17: everything that is not pin, switcher or new lives here, which is what lets the title
 * bar hold three icons forever. Built like the switcher and for the same reasons — inside the pane
 * (decision 14 wants every control in its own pane) rather than as a second window that would be a
 * second web view to keep warm.
 *
 * Frame 2a lists thirteen rows and this ships fourteen — all thirteen, plus Duplicate Note, which
 * Raycast carries on ⌘D and decision 39 took across with the rest of its key map.
 *
 * The thirteenth row came back. It was retired on the reasoning that decision 29 had already
 * answered it — a dragged height was a floor, so there was nothing left to switch off — and
 * decision 40 reversed decision 29 outright: a drag now turns auto-sizing OFF and the pane holds
 * that height, so the row is the way back on, on Raycast's own ⇧⌘/.
 *
 * Every row here is a thing Pane actually does, so none of them is a row that does nothing — the
 * same rule the Shortcuts tab follows (decision 31).
 */

import { icon } from "./format-bar";
import { desiredOverlayHeight } from "./overlay";

export interface ActionRow {
  id: string;
  label: string;
    svg: string;
  /**
   * What to print when the action has no rebindable binding of its own — Settings…, whose ⌘, is the
   * app menu's, and Recently Deleted, which the design deliberately leaves unbound. Every other row
   * prints the binding actually in force; see `keysFor`.
   */
  keys: string[];
  /** Delete is last, red, and separated — the design is explicit about all three. */
  danger?: boolean;
}

interface ActionPanelOptions {
  root: HTMLElement;
  pane: HTMLElement;
  /** Whether the current pane is pinned, so the Pin row can say which way it goes. */
  isPinned: () => boolean;
  /** Same, for the capture toggle. */
  isHiddenFromCapture: () => boolean;
  /** Same, for auto-sizing — which a drag can turn off without anyone pressing this row. */
  isAutoSizing: () => boolean;
  /** Same, for whether the pane is drawn on every Space or belongs to the one it is on. */
  isOnEverySpace: () => boolean;
  run: (id: string) => void;
  /** The key caps to print for a row, from the bindings in force. Null keeps the row's own. */
  keysFor: (id: string) => string[] | null;
  onVisibilityChange: (open: boolean, height: number) => void;
}

/** Grouped exactly as frame 2a groups them; the hairlines between groups are the grouping. */
const GROUPS: ActionRow[][] = [
  [
    { id: "newNote", label: "New Note", svg: `<path d="M5 12h14" /><path d="M12 5v14" />`, keys: ["⌘", "N"] },
    {
      id: "duplicateNote",
      label: "Duplicate Note",
      // Two sheets side by side, not the offset pair. This row arrived with decision 39 and took
      // its path from its neighbour, so Duplicate Note and Copy as Markdown drew the *same* icon —
      // and both are visible together every time the panel opens. The design only ever assigned
      // `M3 5h7v8H3zM5 2h7v8` to Copy as Markdown, so that one keeps it and this one gets its own.
      svg: `<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />`,
      keys: ["⌘", "D"],
    },
    { id: "browseNotes", label: "Browse Notes", svg: `<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />`, keys: ["⌘", "P"] },
  ],
  [
    { id: "pinPane", label: "Pin Pane", svg: `<path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />`, keys: ["⇧", "⌘", "P"] },
    {
      id: "findInNote",
      label: "Find in Note",
      svg: `<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />`,
      keys: ["⌘", "F"],
    },
    {
      id: "copyAsMarkdown",
      label: "Copy as Markdown",
      svg: `<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /><path d="M16 4h2a2 2 0 0 1 2 2v4" /><path d="M21 14H11" /><path d="m15 10-4 4 4 4" />`,
      keys: ["⇧", "⌘", "C"],
    },
    { id: "revealInFinder", label: "Reveal in Finder", svg: `<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />`, keys: ["⌥", "⌘", "R"] },
    {
      id: "exportNote",
      label: "Export…",
      svg: `<path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />`,
      keys: ["⇧", "⌘", "E"],
    },
  ],
  [
    {
      id: "autoSizing",
      label: "Disable Window Auto-sizing",
      svg: `<path d="M12 2v20" /><path d="m8 18 4 4 4-4" /><path d="m8 6 4-4 4 4" />`,
      keys: ["⇧", "⌘", "/"],
    },
    { id: "formatBar", label: "Show Format Bar", svg: `<path d="M12 4v16" /><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M9 20h6" />`, keys: ["⌥", "⌘", ","] },
    {
      id: "spaceBehaviour",
      label: "Keep on This Space",
      // Two overlapping rectangles: one desktop behind another.
      svg: `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />`,
      keys: ["⌥", "⌘", "S"],
    },
    {
      id: "hideFromCapture",
      label: "Hide from Screen Capture",
      svg: `<path d="M12 17v4" /><path d="M17 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 1.184-1.826" /><path d="m2 2 20 20" /><path d="M8 21h8" /><path d="M8.656 3H20a2 2 0 0 1 2 2v10a2 2 0 0 1-.293 1.042" />`,
      keys: ["⇧", "⌘", "H"],
    },
  ],
  [
    {
      id: "settings",
      label: "Settings…",
      svg: `<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" />`,
      keys: ["⌘", ","],
    },
    {
      id: "recentlyDeleted",
      label: "Recently Deleted",
      // A clock, not the trash. This row and Delete Note carried byte-identical path data, and they
      // sit four rows apart in a panel where both are on screen together — the same defect Duplicate
      // Note and Copy as Markdown had, and the smoke test's own rule that two rows never share an
      // icon. Deleting is the bin; this is where things wait, so it is the one that changes.
      svg: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />`,
      // The one row the design gives no shortcut, and it is right: this is a place you go looking
      // for, not a thing you fire off. Decision 31 keeps it out of the Shortcuts table for the
      // same reason — an unbound row there would be a blank waiting to be filled in.
      keys: [],
    },
    {
      id: "renameFile",
      label: "Rename File…",
      // A tag with a hole in it: this row is about the *file's* name, not the note's title, which is
      // line one and needs no menu item.
      svg: `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />`,
      // Unbound, and for Recently Deleted's reason exactly: decision 103 makes the name follow the
      // title on its own, so this is the escape hatch for a title improved an hour later — a place
      // you go looking for rather than something you fire off. Decision 31 keeps it out of the
      // Shortcuts table on the same grounds.
      keys: [],
    },
    {
      id: "deleteNote",
      label: "Delete Note",
      svg: `<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />`,
      keys: ["⌃", "X"],
      danger: true,
    },
  ],
];

export function mountActionPanel(options: ActionPanelOptions) {
  const { root, pane } = options;
  const search = root.querySelector<HTMLInputElement>(".actions__search")!;
  const list = root.querySelector<HTMLElement>(".actions__list")!;

  let visible: ActionRow[] = [];
  let selected = 0;

  function isOpen(): boolean {
    return pane.hasAttribute("data-actions");
  }

  /** See `desiredOverlayHeight` — shared with the switcher, which used to be a constant in Swift. */
  function desiredHeight(): number {
    return desiredOverlayHeight(root, list);
  }

  function open(): void {
    if (isOpen()) return;
    pane.setAttribute("data-actions", "");
    search.value = "";
    selected = 0;
    render("");
    // Back to the top, explicitly. The panel opens with row 0 selected, so a list left scrolled by
    // the previous visit shows a different row under the highlight than the one ⏎ will run — which
    // is exactly what happened while this list was capped shorter than its own content.
    list.scrollTop = 0;
    search.focus();
    // Measured rather than assumed: the pane has to grow to hold this, and the panel's height
    // depends on how many rows survived the filter.
    options.onVisibilityChange(true, desiredHeight());
  }

  function close(): void {
    if (!isOpen()) return;
    pane.removeAttribute("data-actions");
    options.onVisibilityChange(false, 0);
  }

  function toggle(): void {
    isOpen() ? close() : open();
  }

  function escapeHtml(text: string): string {
    return text.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
    );
  }

  /** Substring, case-insensitive. Fourteen rows do not need fuzzy matching, and fuzzy on a short
   *  fixed list mostly produces surprising matches rather than helpful ones. */
  function matches(row: ActionRow, query: string): boolean {
    return row.label.toLowerCase().includes(query.toLowerCase().trim());
  }

  function labelFor(row: ActionRow): string {
    // The two rows whose label depends on state. "Pin Pane" on a pinned pane would be a lie about
    // what pressing it does, and the same goes for a pane already hidden from capture — with no
    // checkmark column in this list, the label is the only place the current state can show.
    if (row.id === "pinPane" && options.isPinned()) return "Unpin Pane";
    if (row.id === "hideFromCapture" && options.isHiddenFromCapture()) {
      return "Show in Screen Capture";
    }
    // This one matters more than the other two, because auto-sizing turns itself off when the pane
    // is dragged (decision 40). The label is the only place that silent change is ever stated.
    if (row.id === "autoSizing" && !options.isAutoSizing()) {
      return "Enable Window Auto-sizing";
    }
    if (row.id === "spaceBehaviour" && !options.isOnEverySpace()) {
      return "Show on Every Space";
    }
    return row.label;
  }

  function render(query: string): void {
    visible = [];
    let html = "";

    for (const group of GROUPS) {
      const rows = group.filter((row) => matches(row, query));
      if (rows.length === 0) continue;

      html += `<div class="actions__group">`;
      for (const row of rows) {
        const index = visible.length;
        visible.push(row);
        html += `
          <div class="actions__row${row.danger ? " actions__row--danger" : ""}"
               role="option" data-index="${index}" aria-selected="${index === selected}">
            ${icon(row.svg).replace("<svg ", '<svg class="actions__icon" ')}
            <span class="actions__label">${escapeHtml(labelFor(row))}</span>
            <span class="actions__keys">
              ${(options.keysFor(row.id) ?? row.keys)
                .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
                .join("")}
            </span>
          </div>`;
      }
      html += `</div>`;
    }

    if (visible.length === 0) {
      html = `<div class="actions__empty">No actions match “${escapeHtml(query)}”</div>`;
    }
    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);

    list.innerHTML = html;
  }

  /** Stops at the ends rather than wrapping, for the reason spelled out on the switcher's `move`. */
  function move(delta: number): void {
    if (visible.length === 0) return;
    select(Math.min(visible.length - 1, Math.max(0, selected + delta)), { scroll: true });
  }

  /**
   * There is exactly one selected row, and the pointer moves it.
   *
   * Hover used to paint its own fill on top of the keyboard selection, so moving the mouse across
   * an open panel lit up two rows at once and neither of them was obviously the one ⏎ would run.
   * Letting the pointer *take* the selection is what the reference does and leaves one answer on
   * screen — which matters here more than in most lists, because every row does something.
   */
  function select(index: number, options: { scroll?: boolean } = {}): void {
    if (index === selected && !options.scroll) return;
    selected = index;
    list.querySelectorAll<HTMLElement>(".actions__row").forEach((row) => {
      row.setAttribute("aria-selected", String(Number(row.dataset.index) === selected));
    });
    if (options.scroll) {
      list
        .querySelector<HTMLElement>(`[data-index="${selected}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }

  function activate(): void {
    const row = visible[selected];
    if (!row) return;
    // Closed before the action runs, not after: several of these change the pane underneath the
    // panel — Browse Notes opens the switcher in the same slot, Delete Note swaps the note out —
    // and a panel still on screen while that happens is a panel describing the wrong pane.
    close();
    options.run(row.id);
  }

  // ---- Events -------------------------------------------------------------------------------

  search.addEventListener("input", () => {
    selected = 0;
    render(search.value);
    // Deliberately no height report here — the pane keeps whatever height opening this panel asked
    // for, however far the filter narrows the list.
    //
    // This used to re-report on every keystroke, and the switcher's `reportHeight` explains why it
    // does not: "a window that resizes on every keystroke of a search is a window that will not sit
    // still". ⌘K was exempted on the grounds that it "has fourteen rows and settles" — true while
    // this list had no cap, when the pane was sized to the note and filtering barely moved it.
    // **Decision 114 ended that.** With a ceiling, opening ⌘K grows the pane to 627pt and typing two
    // characters collapsed it to the height of two rows, which is the whole window jumping while
    // your eyes are on a menu. The reason for the exemption expired with the change that capped it.
    //
    // Reporting once is always enough here, and for the same reason it is enough in the switcher:
    // the panel is at its tallest the moment it opens, with nothing filtered out. A filter can only
    // shrink it, and the pane is already big enough for the largest case.
  });

  search.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter":
        event.preventDefault();
        activate();
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  });

  // Escape from anywhere in the pane, capture phase — same reasoning as the switcher's: focus can
  // sit on a row or nowhere at all, and an uncaught Escape falls through to CodeMirror, which
  // dismisses the whole pane instead of the panel.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !isOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    true
  );

  // `mousemove`, not `mouseover`: a re-render under a resting pointer fires mouseover and would
  // yank the selection to wherever the mouse happens to be sitting.
  list.addEventListener("mousemove", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".actions__row");
    if (row?.dataset.index) select(Number(row.dataset.index));
  });

  list.addEventListener("mousedown", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".actions__row");
    if (!row) return;
    event.preventDefault();
    selected = Number(row.dataset.index);
    activate();
  });

  return { open, close, toggle, isOpen };
}
