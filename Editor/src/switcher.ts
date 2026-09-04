/*
 * The ⌘P switcher — design frame 1c, all five states.
 *
 * Holds no note data of its own: Swift sends rows already ordered, banded and time-formatted by
 * PaneKit, and this file draws them. Ordering rules that matter (the ~8-note grouping threshold, the
 * recency bands, the relative-time format) live in Swift where they are unit-tested.
 */

import { desiredOverlayHeight } from "./overlay";

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
  /** Recently Deleted (decision 20). `storedName` is the timestamped name in the holding folder. */
  onRestore: (storedName: string) => void;
  onRequestDeleted: () => void;
  /** Permanent removal from the holding folder, per row. No undo behind this one. */
  onForgetDeleted: (storedName: string) => void;
  /** Carries the height the panel wants, so the pane can grow to hold it (decision 45). */
  onVisibilityChange: (open: boolean, height: number) => void;
}

/**
 * Which list is on screen.
 *
 * Recently Deleted is the same list with a different source and one different verb, so it is a mode
 * here rather than a second component: the rows, the bands, the keyboard model, the fade and the
 * stylesheet are all already right, and a second near-identical list is the kind of thing that
 * drifts out of step one fix at a time.
 */
type Mode = "notes" | "deleted";

const PIN_SVG = `<svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="5" r="3.4" fill="currentColor"/><line x1="7" y1="8" x2="7" y2="13.5" stroke="currentColor" stroke-width="1.8"/></svg>`;
const TRASH_SVG = `<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 4h8l-.7 8.5H3.7zM2 4h10M5.5 4V2.5h3V4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PIN_OUTLINE_SVG = `<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="7" y1="8" x2="7" y2="13" stroke="currentColor" stroke-width="1.5"/></svg>`;

export function mountSwitcher(options: SwitcherOptions) {
  const { root, pane } = options;
  const search = root.querySelector<HTMLInputElement>(".switcher__search")!;
  const list = root.querySelector<HTMLElement>(".switcher__list")!;
  const footer = root.querySelector<HTMLElement>(".switcher__footer")!;

  let rows: NoteSummary[] = [];
  let selected = 0;
  let query = "";
  let mode: Mode = "notes";
  /** Every deleted note, unfiltered. Searching this list is done here — see `applyQuery`. */
  let deleted: NoteSummary[] = [];
  /** Whether this opening has told Swift how tall it wants the pane — see `reportHeight`. */
  let heightReported = false;

  function isOpen(): boolean {
    return pane.hasAttribute("data-switcher");
  }

  function show(): void {
    pane.setAttribute("data-switcher", "");
    search.value = "";
    query = "";
    selected = 0;
    search.focus();
    heightReported = false;
    // Deliberately no height yet: the rows are a round trip away, so there is nothing to measure
    // until the first render. `reportHeight` does it then.
    options.onVisibilityChange(true, 0);
  }

  /**
   * Tells Swift how tall a pane this list wants — **once per opening**, at the first render.
   *
   * Swift used to work this out from a constant: `54 + 430 + 34` handed to
   * `paneHeight(forOverlay:)`, which adds the 54 again. So ⌘P grew the pane to 691pt whatever was
   * in it, and a six-note vault got a 370pt panel floating in the middle of it.
   *
   * Once, rather than on every keystroke: this list can go from 200 notes to three as you type, and
   * a window that resizes on every keystroke of a search is a window that will not sit still. The
   * panel keeps its own max-height, so a list that outgrows the pane scrolls (decision 45).
   *
   * ⌘K used to re-report on every keystroke and now does not — see the note on its `input` handler.
   * Once is enough for both, and for the same reason: an unfiltered list is the tallest either panel
   * can be, so the height asked for at opening already covers every filter that follows.
   */
  function reportHeight(): void {
    if (!isOpen() || heightReported) return;
    heightReported = true;
    options.onVisibilityChange(true, desiredOverlayHeight(root, list));
  }

  function open(): void {
    if (isOpen()) return;
    mode = "notes";
    show();
    options.onQuery("");
  }

  /**
   * Recently Deleted, in the switcher's clothes.
   *
   * Always opens rather than toggling: this arrives from a ⌘K row, and a row that sometimes closes
   * the thing it names is a row that does nothing half the time.
   */
  function openDeleted(): void {
    mode = "deleted";
    deleted = [];
    show();
    options.onRequestDeleted();
  }

  function close(): void {
    if (!isOpen()) return;
    pane.removeAttribute("data-switcher");
    options.onVisibilityChange(false, 0);
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
    // A `requestNotes` already in flight when Recently Deleted opened would otherwise land here and
    // replace the deleted list with the vault's — the two share one panel and one round trip.
    if (mode !== "notes") return;

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

  /**
   * The deleted list arrives whole and is searched here rather than in Swift.
   *
   * The vault's search is in Swift because it is full-text over 200 notes and needs the index
   * (decision 23). This one is a title match over a handful of rows that are already in hand, and
   * routing every keystroke through the bridge to do it would be slower and more code.
   */
  function renderDeleted(notes: NoteSummary[]): void {
    if (mode !== "deleted") return;
    deleted = notes;
    applyQuery();
  }

  function applyQuery(): void {
    const needle = query.toLowerCase().trim();
    rows = needle
      ? deleted.filter((n) => n.title.toLowerCase().includes(needle))
      : deleted.slice();

    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
    root.toggleAttribute("data-flat", true);
    // Naming the place rather than offering to search nothing — the empty panel below already says
    // what is going on, and "Search 0 deleted notes…" reads like a bug.
    search.placeholder =
      deleted.length === 0
        ? "Recently Deleted"
        : deleted.length === 1
          ? "Search 1 deleted note…"
          : `Search ${deleted.length} deleted notes…`;

    if (deleted.length === 0) {
      renderNothingDeleted();
      return;
    }
    if (rows.length === 0) {
      list.innerHTML = `<div class="switcher__noresults">No deleted notes match “${escapeHtml(query)}”</div>`;
      footer.innerHTML = "";
      footer.style.display = "none";
      return;
    }
    renderRows(deleted.length);
  }

  function renderNothingDeleted(): void {
    list.innerHTML = `
      <div class="switcher__empty">
        <div class="switcher__empty-title">Nothing deleted</div>
      </div>`;
    footer.innerHTML = "";
    footer.style.display = "none";
    reportHeight();
  }

  function renderEmptyVault(): void {
    list.innerHTML = `
      <div class="switcher__empty">
        <div class="switcher__empty-title">No notes yet</div>
      </div>`;
    footer.innerHTML = "";
    footer.style.display = "none";
    reportHeight();
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
    reportHeight();
  }

  function renderRows(total: number): void {
    // Say the retention where the deleted notes are. It was only ever on the Storage tab, which is
    // the one screen you are not looking at while trying to get something back — and "how long have
    // I got?" is the question this list exists to answer.
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
            ${
              // Pinning still means nothing to a deleted note — it would sort it to the top of a
              // list it is not in. Erasing it does. The old note here said that was "not a button
              // this app is going to grow", on the reasoning that retention already answers it.
              // It does not: retention answers "eventually", and the case that matters is a
              // password pasted into the wrong pane, where the whole point is *now*. Without this
              // the only way to remove it was to go and find the holding folder in Finder, which
              // is a worse thing to ask than a button.
              mode === "deleted"
                ? `<span class="switcher__actions">
              <button class="switcher__action switcher__action--danger" data-forget
                      aria-label="Delete permanently"
                      data-tip="Delete permanently">${TRASH_SVG}</button>
            </span>`
                : `<span class="switcher__actions">
              <button class="switcher__action" data-pin
                      aria-label="Pin" data-tip="Pin ⌘⏎">${PIN_OUTLINE_SVG}</button>
              <button class="switcher__action" data-delete
                      aria-label="Delete" data-tip="Delete ⌃X">✕</button>
            </span>`
            }
          </div>
          <div class="switcher__meta">${meta}</div>
        </div>`;
    });

    list.innerHTML = html + `<div class="switcher__fade" aria-hidden="true"></div>`;

    updateFade();

    footer.style.display = "";
    const hints =
      mode === "deleted"
        ? `<span>${total} deleted</span><span class="switcher__footer-spacer"></span><span>↑↓ navigate</span><span>⏎ restore</span>`
        : query
          ? `<span>${rows.length} of ${total} notes match</span><span class="switcher__footer-spacer"></span><span>⏎ open</span>`
          : total < 8
            ? `<span>${total} notes</span><span class="switcher__footer-spacer"></span><span>⏎ open</span><span>⌘N new</span>`
            : `<span>${total} notes</span><span class="switcher__footer-spacer"></span><span>↑↓ navigate</span><span>⏎ open</span><span>⌘⏎ pin</span>`;
    footer.innerHTML = hints;

    scrollSelectedIntoView();
    reportHeight();
  }

  /**
   * Whether the fade is drawn, and whether there is still anything under it.
   *
   * The fade says "there is more below". With a short list there is not, and it was washing out the
   * last row's preview instead — visible with as few as three notes, and reading as a rendering
   * fault rather than an affordance. The same is true at the end of a long list, which the old
   * absolutely-positioned fade hid by accident: it scrolled away with the content. Now that it is
   * pinned it would sit over the last row forever, so the end of the scroll has to be watched.
   */
  function updateFade(): void {
    const overflows = list.scrollHeight > list.clientHeight + 1;
    root.toggleAttribute("data-overflows", overflows);
    // A pixel of slack: fractional layout means `scrollTop` can stop a hair short of the arithmetic.
    root.toggleAttribute(
      "data-at-end",
      overflows && list.scrollTop + list.clientHeight >= list.scrollHeight - 1
    );
  }

  function scrollSelectedIntoView(): void {
    list
      .querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  /**
   * Arrow keys stop at the ends. They do not wrap.
   *
   * Measured against Raycast Notes, which is the reference this panel is built to: ArrowDown on its
   * last row moves nothing at all — not the selection, not the scroll offset — and ArrowUp on its
   * first behaves the same. Fourteen notes, four presses past the end, and every reading identical.
   *
   * The modulo that used to be here made the list a carousel, and a carousel is a surprise in a list
   * you are reading top to bottom: the one keystroke that should do nothing threw you back to the
   * first note instead, which reads as the panel having jumped rather than as having stopped.
   */
  function move(delta: number): void {
    if (rows.length === 0) return;
    select(Math.min(rows.length - 1, Math.max(0, selected + delta)), { scroll: true });
  }

  /** One selected row, and the pointer moves it — see the note on `select` in action-panel.ts. */
  function select(index: number, options: { scroll?: boolean } = {}): void {
    if (index === selected && !options.scroll) return;
    selected = index;
    list.querySelectorAll<HTMLElement>(".switcher__row").forEach((row) => {
      row.setAttribute("aria-selected", String(Number(row.dataset.index) === selected));
    });
    if (options.scroll) scrollSelectedIntoView();
  }

  function activate(): void {
    if (mode === "deleted") {
      // No "create from the query" fallback here: the point of this list is getting something
      // specific back, and inventing a new note out of a failed search for an old one is a
      // different intention wearing the same keystroke.
      const row = rows[selected];
      if (row) {
        options.onRestore(row.filename);
        close();
      }
      return;
    }

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
    if (mode === "deleted") {
      query = search.value;
      applyQuery();
    } else {
      options.onQuery(search.value);
    }
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
        if (event.metaKey && mode === "notes" && rows.length > 0) {
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

  // Programmatic scrolls fire this too, so the arrow keys are covered by the same line as the wheel.
  list.addEventListener("scroll", updateFade);

  list.addEventListener("mousemove", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".switcher__row");
    if (row?.dataset.index) select(Number(row.dataset.index));
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
    selected = index;
    // The row's own buttons come first, and `data-forget` in particular *must*: in deleted mode a
    // bare row click restores, so testing that branch first swallows every click on the trash and
    // silently does the opposite of what the button says. Measured — the note came back into the
    // vault and opened.
    if (target.closest("[data-forget]")) {
      options.onForgetDeleted(note.filename);
    } else if (mode === "deleted") {
      options.onRestore(note.filename);
      close();
    } else if (target.closest("[data-pin]")) {
      options.onPin(note.filename);
    } else if (target.closest("[data-delete]")) {
      options.onDelete(note.filename);
    } else {
      options.onOpen(note.filename);
      close();
    }
  });


  return { open, close, toggle, render, renderDeleted, openDeleted, isOpen };
}
