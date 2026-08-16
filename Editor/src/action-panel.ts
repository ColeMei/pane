/*
 * The ⌘K action panel — design frame 2a.
 *
 * Decision 17: everything that is not pin, switcher or new lives here, which is what lets the title
 * bar hold three icons forever. Built like the switcher and for the same reasons — inside the pane
 * (decision 14 wants every control in its own pane) rather than as a second window that would be a
 * second web view to keep warm.
 *
 * Frame 2a lists thirteen rows and this ships twelve. The one that is missing:
 *
 *   Disable Auto-sizing — retired outright. It was the answer to the problem decision 29 solved
 *     better, and the design never specified it beyond the row label: it appears exactly once in
 *     the whole design record, with no frame and no annotation behind it. A dragged height is
 *     already a floor, so there is nothing left for it to switch off.
 *
 * Every other row here is a thing Pane actually does, so none of them is a row that does nothing —
 * the same rule the Shortcuts tab follows (decision 31).
 */

export interface ActionRow {
  id: string;
  label: string;
  /** SVG path data, 14×14 viewBox, straight from the design's own `actionGroups`. */
  d: string;
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
  run: (id: string) => void;
  onVisibilityChange: (open: boolean, height: number) => void;
}

/** Grouped exactly as frame 2a groups them; the hairlines between groups are the grouping. */
const GROUPS: ActionRow[][] = [
  [
    { id: "newNote", label: "New Note", d: "M7 2v10M2 7h10", keys: ["⌘", "N"] },
    {
      id: "duplicateNote",
      label: "Duplicate Note",
      d: "M3 5h7v8H3zM5 2h7v8",
      keys: ["⌘", "D"],
    },
    { id: "browseNotes", label: "Browse Notes", d: "M2 3h10M2 7h10M2 11h10", keys: ["⌘", "P"] },
  ],
  [
    { id: "pinPane", label: "Pin Pane", d: "M7 2a3 3 0 110 6 3 3 0 010-6zM7 8v5", keys: ["⇧", "⌘", "P"] },
    {
      id: "findInNote",
      label: "Find in Note",
      d: "M6 2a4 4 0 110 8 4 4 0 010-8zM9.2 9.2l3.3 3.3",
      keys: ["⌘", "F"],
    },
    {
      id: "copyAsMarkdown",
      label: "Copy as Markdown",
      d: "M3 5h7v8H3zM5 2h7v8",
      keys: ["⇧", "⌘", "C"],
    },
    { id: "revealInFinder", label: "Reveal in Finder", d: "M2 4h4l1 1.5h5V11H2z", keys: ["⌥", "⌘", "R"] },
    {
      id: "exportNote",
      label: "Export…",
      d: "M7 9V2M4.5 4L7 1.5 9.5 4M3 8v4h8V8",
      keys: ["⇧", "⌘", "E"],
    },
  ],
  [
    {
      id: "autoSizing",
      label: "Disable Window Auto-sizing",
      d: "M7 1v12M4.5 3.5L7 1l2.5 2.5M4.5 10.5L7 13l2.5-2.5",
      keys: ["⇧", "⌘", "/"],
    },
    { id: "formatBar", label: "Show Format Bar", d: "M3 3h8M7 3v9", keys: ["⌥", "⌘", ","] },
    {
      id: "hideFromCapture",
      label: "Hide from Screen Capture",
      d: "M2 3.5h10v7H2zM1.5 2l11 10",
      keys: ["⇧", "⌘", "H"],
    },
  ],
  [
    {
      id: "settings",
      label: "Settings…",
      d: "M7 4.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM7 1v2M7 11v2M1 7h2M11 7h2M2.8 2.8l1.4 1.4M9.8 9.8l1.4 1.4M2.8 11.2l1.4-1.4M9.8 4.2l1.4-1.4",
      keys: ["⌘", ","],
    },
    {
      id: "recentlyDeleted",
      label: "Recently Deleted",
      d: "M3 4h8l-.7 8.5H3.7zM2 4h10M5.5 4V2.5h3V4",
      // The one row the design gives no shortcut, and it is right: this is a place you go looking
      // for, not a thing you fire off. Decision 31 keeps it out of the Shortcuts table for the
      // same reason — an unbound row there would be a blank waiting to be filled in.
      keys: [],
    },
    {
      id: "deleteNote",
      label: "Delete Note",
      d: "M3 4h8l-.7 8.5H3.7zM2 4h10M5.5 4V2.5h3V4",
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

  function open(): void {
    if (isOpen()) return;
    pane.setAttribute("data-actions", "");
    search.value = "";
    selected = 0;
    render("");
    search.focus();
    // Measured rather than assumed: the pane has to grow to hold this, and the panel's height
    // depends on how many rows survived the filter.
    options.onVisibilityChange(true, root.offsetHeight);
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

  /** Substring, case-insensitive. Seven rows do not need fuzzy matching, and fuzzy on a short
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
            <svg class="actions__icon" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <path d="${row.d}" fill="none" stroke="currentColor" stroke-width="1.4"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="actions__label">${escapeHtml(labelFor(row))}</span>
            <span class="actions__keys">
              ${row.keys.map((k) => `<kbd>${escapeHtml(k)}</kbd>`).join("")}
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

  function move(delta: number): void {
    if (visible.length === 0) return;
    selected = (selected + delta + visible.length) % visible.length;
    list.querySelectorAll<HTMLElement>(".actions__row").forEach((row) => {
      row.setAttribute("aria-selected", String(Number(row.dataset.index) === selected));
    });
    list
      .querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
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
    if (isOpen()) options.onVisibilityChange(true, root.offsetHeight);
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

  list.addEventListener("mousedown", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".actions__row");
    if (!row) return;
    event.preventDefault();
    selected = Number(row.dataset.index);
    activate();
  });

  return { open, close, toggle, isOpen };
}
