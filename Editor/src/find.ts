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
    <svg class="find__icon" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M6 2a4 4 0 110 8 4 4 0 010-8zM9.2 9.2l3.3 3.3" fill="none" stroke="currentColor"
            stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <input class="find__input" type="text" placeholder="Find in note…" spellcheck="false"
           aria-label="Find in note">
    <span class="find__count" aria-live="polite"></span>
    <button class="find__step" data-prev aria-label="Previous match" title="Previous ⇧⏎">↑</button>
    <button class="find__step" data-next aria-label="Next match" title="Next ⏎">↓</button>
    <button class="find__close" aria-label="Close find" title="Close ⎋">✕</button>`;

  const input = root.querySelector<HTMLInputElement>(".find__input")!;
  const count = root.querySelector<HTMLElement>(".find__count")!;

  function isOpen(): boolean {
    return pane.hasAttribute("data-find");
  }

  function state(): FindState | null {
    return view.state.field(findField, false) ?? null;
  }

  function refresh(query: string, preferred = 0): void {
    const matches = matchesOf(view.state.doc.toString(), query);
    const current = matches.length === 0 ? -1 : Math.min(preferred, matches.length - 1);

    view.dispatch({ effects: setFind.of({ query, matches, current }) });
    renderCount(query, matches.length, current);
    if (current >= 0) reveal(matches[current]!);
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

  function open(): void {
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

  root.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-next]")) {
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

  return { open, close, toggle, isOpen };
}
