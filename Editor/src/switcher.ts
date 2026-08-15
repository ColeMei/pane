/*
 * The ⌘P switcher — design frame 1c, all five states.
 *
 * Holds no note data of its own: Swift sends rows already ordered, banded and time-formatted by
 * PaneKit, and this file draws them. Ordering rules that matter (the ~8-note grouping threshold, the
 * recency bands, the relative-time format) live in Swift where they are unit-tested.
 */

export interface NoteSummary {
  filename: string;
  title: string;
  /** Preformatted by PaneKit: "now", "42m", "2h", "Thu", "Jul 30", "May 12, 2025". */
  time: string;
  preview: string;
  /** "Pinned", "Today", "Yesterday", "This week", "July"… Absent when the list is flat. */
  band?: string;
  pinned?: boolean;
  current?: boolean;
  /** Set when the query matched the body: the snippet replaces the preview, highlighted. */
  match?: { pre: string; hit: string; post: string };
}

interface SwitcherOptions {
  root: HTMLElement;
  pane: HTMLElement;
  onQuery: (query: string) => void;
  onOpen: (filename: string) => void;
  onCreate: (title: string) => void;
  onPin: (filename: string) => void;
  onDelete: (filename: string) => void;
  onVisibilityChange: (open: boolean) => void;
}

const PIN_SVG = `<svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="5" r="3.4" fill="currentColor"/><line x1="7" y1="8" x2="7" y2="13.5" stroke="currentColor" stroke-width="1.8"/></svg>`;
const PIN_OUTLINE_SVG = `<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="8" x2="7" y2="13" stroke="currentColor" stroke-width="1.5"/></svg>`;

export function mountSwitcher(options: SwitcherOptions) {
  const { root, pane } = options;
  const search = root.querySelector<HTMLInputElement>(".switcher__search")!;
  const list = root.querySelector<HTMLElement>(".switcher__list")!;
  const footer = root.querySelector<HTMLElement>(".switcher__footer")!;

  let rows: NoteSummary[] = [];
  let selected = 0;
  let query = "";

  function isOpen(): boolean {
    return pane.hasAttribute("data-switcher");
  }

  function open(): void {
    if (isOpen()) return;
    pane.setAttribute("data-switcher", "");
    search.value = "";
    query = "";
    selected = 0;
    options.onQuery("");
    search.focus();
    options.onVisibilityChange(true);
  }

  function close(): void {
    if (!isOpen()) return;
    pane.removeAttribute("data-switcher");
    options.onVisibilityChange(false);
  }

  /// What both entry points actually want. Pressing ⌘P or the switcher button a second time means
  /// "put this away" — the old `open()`-only binding made the button a one-way door.
  function toggle(): void {
    isOpen() ? close() : open();
  }

  // Escape, wherever the focus happens to be.
  //
  // The search field's own keydown handler covers the normal case, but focus inside the pane can sit
  // on a row, on a button, or nowhere at all after a click — and then Escape fell through to
  // CodeMirror's binding, which dismisses the whole pane instead of the list. Capture phase so it
  // wins before the editor sees it.
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

  function escapeHtml(text: string): string {
    return text.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
    );
  }

  function render(notes: NoteSummary[], total: number, forQuery: string): void {
    rows = notes;
    query = forQuery;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);

    search.placeholder = total === 0 ? "Search notes…" : `Search ${total} notes…`;

    // Below the grouping threshold the bands are suppressed. Swift decides by omitting `band`;
    // the attribute is a belt-and-braces so a stray header cannot render.
    root.toggleAttribute("data-flat", !notes.some((n) => n.band));

    if (total === 0) {
      renderEmptyVault();
      return;
    }
    if (rows.length === 0) {
      renderNoResults();
      return;
    }
    renderRows(total);
  }

  function renderEmptyVault(): void {
    list.innerHTML = `
      <div class="switcher__empty">
        <div class="switcher__empty-title">No notes yet</div>
        <div class="switcher__empty-body">
          Press <kbd>⌘N</kbd> to start one. It’s a file in
          <span style="font-family:var(--font-mono)">~/Documents/Pane</span> the moment you type.
        </div>
      </div>`;
    footer.innerHTML = "";
    footer.style.display = "none";
  }

  /** A dead end becomes capture: ⏎ creates a note whose first line is the query. */
  function renderNoResults(): void {
    list.innerHTML = `
      <div class="switcher__noresults">No notes match “${escapeHtml(query)}”</div>
      <div class="switcher__create" data-create>
        <span>Create note <strong>“${escapeHtml(query)}”</strong></span>
        <span class="switcher__create-spacer"></span>
        <kbd>⏎</kbd>
      </div>`;
    footer.innerHTML = "";
    footer.style.display = "none";
  }

  function renderRows(total: number): void {
    let html = "";
    let lastBand: string | undefined;

    rows.forEach((note, index) => {
      if (note.band && note.band !== lastBand) {
        html += `<div class="switcher__group">${escapeHtml(note.band)}</div>`;
        lastBand = note.band;
      }

      // A body match replaces the first-line preview with the matched snippet.
      const preview = note.match
        ? `<span class="switcher__preview">${escapeHtml(note.match.pre)}<span class="switcher__match">${escapeHtml(note.match.hit)}</span>${escapeHtml(note.match.post)}</span>`
        : `<span class="switcher__preview">${escapeHtml(note.preview)}</span>`;

      // While searching, the time moves to the right edge and the separator dot goes with it.
      // `time · preview` reads as one phrase, which is right when the preview is the note's own first
      // line — but a search snippet is an answer to the query, not a continuation of the timestamp,
      // and leading with the date buries it. Swift suppresses recency bands during a search for the
      // same reason: the list is ordered by relevance, so a date is metadata, not structure.
      const meta = query
        ? `${preview}<span class="switcher__meta-spacer"></span><span class="switcher__time">${escapeHtml(note.time)}</span>`
        : `<span class="switcher__time">${escapeHtml(note.time)}</span><span class="switcher__dot">·</span>${preview}`;

      html += `
        <div class="switcher__row" role="option" data-index="${index}"
             aria-selected="${index === selected}">
          <div class="switcher__row-top">
            <span class="switcher__title">${escapeHtml(note.title || "Untitled")}</span>
            ${note.pinned ? `<span class="switcher__pin">${PIN_SVG}</span>` : ""}
            ${note.current ? `<span class="switcher__badge">CURRENT</span>` : ""}
            <span class="switcher__row-spacer"></span>
            <span class="switcher__actions">
              <button class="switcher__action" data-pin title="Pin">${PIN_OUTLINE_SVG}</button>
              <button class="switcher__action" data-delete title="Delete">✕</button>
            </span>
          </div>
          <div class="switcher__meta">${meta}</div>
        </div>`;
    });

    list.innerHTML = html + `<div class="switcher__fade" aria-hidden="true"></div>`;

    footer.style.display = "";
    const hints = query
      ? `<span>${rows.length} of ${total} notes match</span><span class="switcher__footer-spacer"></span><span>⏎ open</span>`
      : total < 8
        ? `<span>${total} notes</span><span class="switcher__footer-spacer"></span><span>⏎ open</span><span>⌘N new</span>`
        : `<span>${total} notes</span><span class="switcher__footer-spacer"></span><span>↑↓ navigate</span><span>⏎ open</span><span>⌘⏎ pin</span>`;
    footer.innerHTML = hints;

    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView(): void {
    list
      .querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function move(delta: number): void {
    if (rows.length === 0) return;
    selected = (selected + delta + rows.length) % rows.length;
    list.querySelectorAll<HTMLElement>(".switcher__row").forEach((row) => {
      row.setAttribute("aria-selected", String(Number(row.dataset.index) === selected));
    });
    scrollSelectedIntoView();
  }

  function activate(): void {
    if (rows.length === 0) {
      // Empty vault or no results — either way, ⏎ makes a note.
      options.onCreate(query);
      close();
      return;
    }
    options.onOpen(rows[selected]!.filename);
    close();
  }

  // ---- Events -------------------------------------------------------------------------------

  search.addEventListener("input", () => {
    selected = 0;
    options.onQuery(search.value);
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
        if (event.metaKey && rows.length > 0) {
          options.onPin(rows[selected]!.filename);
        } else {
          activate();
        }
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  });

  list.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;

    if (target.closest("[data-create]")) {
      event.preventDefault();
      options.onCreate(query);
      close();
      return;
    }

    const row = target.closest<HTMLElement>(".switcher__row");
    if (!row) return;
    const index = Number(row.dataset.index);
    const note = rows[index];
    if (!note) return;

    event.preventDefault();
    if (target.closest("[data-pin]")) {
      options.onPin(note.filename);
    } else if (target.closest("[data-delete]")) {
      options.onDelete(note.filename);
    } else {
      options.onOpen(note.filename);
      close();
    }
  });

  return { open, close, toggle, render, isOpen };
}
