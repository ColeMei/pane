/*
 * Find in Note — design frame 2a row 4, and the only unbuilt v0.1 item the design specified twice:
 * it is also row 8 of frame 3c's shortcut table.
 *
 * Hand-rolled rather than `@codemirror/search`, which is the opposite of decision 5's advice and is
 * right here for the reason decision 5 gives. That decision says to prefer an existing MIT package
 * over hand-rolling *live-preview decorations*, because reconciling source with rendered output is
 * the hard part and the place these editors break. Finding a substring is not that. What the package
 * would actually bring is its own panel DOM, a replace UI and a regexp mode — three things this pane
 * has nowhere to put — in exchange for a literal-string search that is forty lines.
 *
 * The bar replaces the footer, exactly as the format bar does (decision 22): one row, never two. It
 * is the third state of that row rather than new chrome, which is what keeps frame 1e's rule — every
 * control inside its own pane — affordable.
 */

import { describe } from "./tooltip";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { EditorSelection, StateEffect, StateField, type Extension } from "@codemirror/state";

interface Match {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  matches: Match[];
  /** Index into `matches`, or -1 when there are none. */
  current: number;
}

const setFind = StateEffect.define<FindState | null>();

const matchMark = Decoration.mark({ class: "cm-find-match" });
const currentMark = Decoration.mark({ class: "cm-find-match cm-find-current" });

function decorationsFor(state: FindState | null): DecorationSet {
  if (!state || state.matches.length === 0) return Decoration.none;
  return Decoration.set(
    state.matches.map((m, i) => (i === state.current ? currentMark : matchMark).range(m.from, m.to)),
    true
  );
}

const findField = StateField.define<FindState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFind)) return effect.value;
    if (!value) return null;

    // Typing while the bar is open moves every match after the caret. The controller recomputes on
    // the next keystroke anyway, but mapping here stops the highlight visibly lagging one character
    // behind the text underneath it.
    if (tr.docChanged) {
      return {
        ...value,
        matches: value.matches.map((m) => ({
          from: tr.changes.mapPos(m.from),
          to: tr.changes.mapPos(m.to, 1),
        })),
      };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, decorationsFor),
});

export function findHighlighting(): Extension {
  return findField;
}

/** Case-insensitive, literal. Nobody types a regexp into a notes app by accident. */
function matchesOf(text: string, query: string): Match[] {
  if (!query) return [];
  const found: Match[] = [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push({ from: at, to: at + needle.length });
    // `at + needle.length` rather than `at + 1`: overlapping hits of the same string are one hit as
    // far as anyone reading them is concerned.
    at = haystack.indexOf(needle, at + needle.length);
  }
  return found;
}

interface FindOptions {
  root: HTMLElement;
  pane: HTMLElement;
  view: EditorView;
  /** The bar and the footer are different heights, so the window has to follow. */
  onLayoutChange: () => void;
}

export function mountFind(options: FindOptions) {
  const { root, pane, view } = options;

  root.innerHTML = `
    <div class="find__row">
      <button class="find__disclosure" data-disclosure aria-expanded="false">
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3.5 1.5L7 5l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <svg class="find__icon" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M6 2a4 4 0 110 8 4 4 0 010-8zM9.2 9.2l3.3 3.3" fill="none" stroke="currentColor"
              stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <input class="find__input" type="text" placeholder="Find in note…" spellcheck="false"
             aria-label="Find in note">
      <span class="find__count" aria-live="polite"></span>
      <button class="find__step" data-prev>↑</button>
      <button class="find__step" data-next>↓</button>
      <button class="find__close">✕</button>
    </div>
    <div class="find__row find__row--replace">
      <span class="find__replace-lead" aria-hidden="true"></span>
      <input class="find__input" type="text" placeholder="Replace" spellcheck="false"
             aria-label="Replace with" data-replace-input>
      <button class="find__step" data-replace-one>
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 5.5h5.5a2.25 2.25 0 1 1 0 4.5H5.5M5.5 3L3 5.5 5.5 8" fill="none"
                stroke="currentColor" stroke-width="1.3" stroke-linecap="round"
                stroke-linejoin="round"/>
        </svg>
      </button>
      <button class="find__step" data-replace-all>
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 4.5h5a2 2 0 1 1 0 4H4M4 2.5L2 4.5 4 6.5" fill="none" stroke="currentColor"
                stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9.5 10.5h2.5M9.5 12.5h2.5" fill="none" stroke="currentColor" stroke-width="1.3"
                stroke-linecap="round"/>
        </svg>
      </button>
    </div>`;

  // The pane's own bubble, not the system's. This bar *is* the footer row that the format bar
  // occupies (decision 38), so having the two answer differently — one instantly in the pane's
  // material, one a second later in the system's yellow — was the inconsistency decision 58 set
  // out to remove, sitting in the one place it is most obvious.
  describe(root.querySelector<HTMLElement>("[data-prev]")!, "Previous ⇧⏎");
  describe(root.querySelector<HTMLElement>("[data-next]")!, "Next ⏎");
  describe(root.querySelector<HTMLElement>(".find__close")!, "Close ⎋");
  // Not this one — its key is rebindable through `settings.json`, so it is set from the binding in
  // force by `refreshChromeTooltips` in main.ts. The four around it are keys nothing can rebind.
  describe(root.querySelector<HTMLElement>("[data-replace-one]")!, "Replace ⏎");
  describe(root.querySelector<HTMLElement>("[data-replace-all]")!, "Replace all ⌘⏎");

  const input = root.querySelector<HTMLInputElement>(".find__input")!;
  const replaceInput = root.querySelector<HTMLInputElement>("[data-replace-input]")!;
  const disclosure = root.querySelector<HTMLElement>("[data-disclosure]")!;
  const count = root.querySelector<HTMLElement>(".find__count")!;

  function isOpen(): boolean {
    return pane.hasAttribute("data-find");
  }

  function state(): FindState | null {
    return view.state.field(findField, false) ?? null;
  }

  function refresh(query: string, preferred = 0): void {
    const matches = matchesOf(view.state.doc.toString(), query);
    apply(query, matches, matches.length === 0 ? -1 : Math.min(preferred, matches.length - 1));
  }

  /** Publishes a match set and its selected index. The one place the highlight and the count agree. */
  function apply(query: string, matches: Match[], current: number): void {
    view.dispatch({ effects: setFind.of({ query, matches, current }) });
    renderCount(query, matches.length, current);
    if (current >= 0) reveal(matches[current]!);
  }

  // ---- Replace ------------------------------------------------------------------------------
  //
  // Decision 38 hand-rolled find and ruled replace out in the same breath, on the grounds that
  // `@codemirror/search` "would bring a panel, a replace UI and regexp — three things this pane has
  // nowhere to put". The first and third still hold. The second turned out to be wrong: there is
  // somewhere to put it, and it is where the reference puts it — a disclosure on the search row
  // that opens one more row underneath. See decision 72.

  function isReplaceOpen(): boolean {
    return root.hasAttribute("data-replace");
  }

  function showReplace(open: boolean): void {
    root.toggleAttribute("data-replace", open);
    disclosure.setAttribute("aria-expanded", String(open));
    // The bar is now two rows tall or one, and the pane follows it (decision 66 measures whichever
    // row is laid out, so this needs no special case beyond saying the layout moved).
    options.onLayoutChange();
  }

  /**
   * Replaces the match you are standing on, then moves to the next one *after the replacement*.
   *
   * Not "stay on the same index": replacing `a` with `aa` grows the match list, and an index that
   * did not move would rewrite the same spot for as long as the button was held. Searching forward
   * from the end of what was just inserted is what every editor does and cannot loop.
   */
  function replaceCurrent(): void {
    const found = state();
    if (!found || found.current < 0 || !found.query) return;

    const match = found.matches[found.current]!;
    const insert = replaceInput.value;
    view.dispatch({
      changes: { from: match.from, to: match.to, insert },
      userEvent: "input.replace",
    });

    const after = match.from + insert.length;
    const matches = matchesOf(view.state.doc.toString(), found.query);
    const next = matches.findIndex((m) => m.from >= after);
    apply(found.query, matches, matches.length === 0 ? -1 : next === -1 ? 0 : next);
  }

  /** Every match, in **one** transaction — so the whole thing is a single ⌘Z. */
  function replaceAll(): void {
    const query = input.value;
    if (!query) return;

    const matches = matchesOf(view.state.doc.toString(), query);
    if (matches.length === 0) return;

    const insert = replaceInput.value;
    view.dispatch({
      changes: matches.map((m) => ({ from: m.from, to: m.to, insert })),
      userEvent: "input.replace",
    });
    refresh(query);
  }

  function renderCount(query: string, total: number, current: number): void {
    if (!query) {
      count.textContent = "";
      root.removeAttribute("data-empty");
      return;
    }
    count.textContent = total === 0 ? "no matches" : `${current + 1} of ${total}`;
    root.toggleAttribute("data-empty", total === 0);
  }

  /**
   * Scrolls a match into view without moving the caret.
   *
   * Moving the caret would be the obvious thing and is wrong twice: decision 11 restores the caret
   * to an exact offset, so find would quietly rewrite the position the next summon returns to — and
   * the live preview reveals raw source on the caret's line, so stepping through matches would
   * un-render a different line each time.
   */
  function reveal(match: Match): void {
    view.dispatch({
      effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to).from, {
        y: "center",
      }),
    });
  }

  function step(delta: number): void {
    const found = state();
    if (!found || found.matches.length === 0) return;

    const total = found.matches.length;
    const current = (found.current + delta + total) % total;
    view.dispatch({ effects: setFind.of({ ...found, current }) });
    renderCount(found.query, total, current);
    reveal(found.matches[current]!);
  }

  function open(withReplace = false): void {
    if (withReplace) showReplace(true);
    if (isOpen()) {
      input.select();
      input.focus();
      return;
    }
    pane.setAttribute("data-find", "");
    // The format bar and this one are both the footer row; two of them would stack.
    pane.removeAttribute("data-format-bar");
    options.onLayoutChange();

    // Whatever is selected is almost always what you were about to type.
    const selection = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to
    );
    if (selection && !selection.includes("\n")) input.value = selection;

    input.focus();
    input.select();
    refresh(input.value);
  }

  function close(): void {
    if (!isOpen()) return;
    pane.removeAttribute("data-find");
    // The disclosure closes with the bar. Reopening find to a replace row you opened an hour ago
    // is a taller bar than you asked for.
    root.removeAttribute("data-replace");
    disclosure.setAttribute("aria-expanded", "false");
    view.dispatch({ effects: setFind.of(null) });
    count.textContent = "";
    root.removeAttribute("data-empty");
    options.onLayoutChange();
    view.focus();
  }

  function toggle(): void {
    isOpen() ? close() : open();
  }

  // ---- Events -------------------------------------------------------------------------------

  input.addEventListener("input", () => refresh(input.value));

  input.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  });

  replaceInput.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        // ⌘⏎ for all of them, which is the pairing ⌘P already uses for its second verb.
        event.metaKey ? replaceAll() : replaceCurrent();
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  });

  root.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-disclosure]")) {
      event.preventDefault();
      showReplace(!isReplaceOpen());
      (isReplaceOpen() ? replaceInput : input).focus();
    } else if (target.closest("[data-replace-one]")) {
      event.preventDefault();
      replaceCurrent();
    } else if (target.closest("[data-replace-all]")) {
      event.preventDefault();
      replaceAll();
    } else if (target.closest("[data-next]")) {
      event.preventDefault();
      step(1);
    } else if (target.closest("[data-prev]")) {
      event.preventDefault();
      step(-1);
    } else if (target.closest(".find__close")) {
      event.preventDefault();
      close();
    }
  });

  return { open, close, toggle, isOpen, openWithReplace: () => open(true) };
}
