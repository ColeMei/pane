/*
 * The gesture replay: every key cell of the October 2026 sweep, against Typora's results.
 *
 * The sweep drove Pane and Typora side by side through every caret, selection, delete and edit key
 * and every pair of moves, from every start on 81 fixtures, and read where each ended: the bytes,
 * the selection, and the row the caret is drawn on. `gestures.golden.json` is what each cell should
 * end as: Typora's outcome, or Pane's own where a divergence was settled in Pane's favour. This
 * replays each cell here with the keyboard driver and checks it ends the same way.
 *
 * Wrapped lines break in different places in every layout, Typora's, the pane's and this window's.
 * So a start on a wrapped fixture is a role (the start of row two, the middle of row one, …) found
 * in this layout, and an end compares by its role too: its line, its row, and whether it is that
 * row's first place, its end, or a place in between. A caret at a wrap point is on the row it is
 * drawn on, `coordsAtPos(head, assoc || 1)` (LAB, 2026-10-17). A vertical move lands by x, which
 * depends on each app's font, so it compares by line and row alone.
 *
 * `Scripts/test-gestures.sh` puts the golden file in front of this one as `GOLDEN`.
 */

/* global GOLDEN, RANGE */

const KEYS = {
  left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", home: "Home", end: "End",
  pgup: "PageUp", pgdn: "PageDown", delete: "Backspace", fdel: "Delete", return: "Enter", tab: "Tab",
};
const CODES = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const EDITS = new Set(["delete", "opt+delete", "cmd+delete", "fdel", "opt+fdel", "return", "shift+return", "tab", "shift+tab", "ctrl+k", "ctrl+d", "ctrl+h", "ctrl+t"]);
const VERTICAL = new Set(["up", "down", "ctrl+n", "ctrl+p", "pgup", "pgdn", "shift+up", "shift+down"]);

export function run(view, _bar, doc) {
  const EditorView = view.constructor;
  const content = doc.querySelector(".cm-content");
  // Pane reveals a construct's markers only while the editor has focus (`reveal.ts`), as it has in
  // use. The probe's window never becomes key, so `hasFocus` is pinned, as the other suites do.
  view.focus();
  Object.defineProperty(view, "hasFocus", { get: () => true, configurable: true });
  const failures = [];
  let checked = 0;

  const press = (combo) => {
    const parts = combo.split("+");
    const name = parts.pop();
    // As a keyboard sends it: ⇧ makes a letter a capital.
    const key = KEYS[name] ?? (parts.includes("shift") ? name.toUpperCase() : name);
    content.dispatchEvent(new KeyboardEvent("keydown", {
      key, code: key, keyCode: CODES[key] ?? key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true,
      metaKey: parts.includes("cmd"), altKey: parts.includes("opt"), ctrlKey: parts.includes("ctrl"), shiftKey: parts.includes("shift"),
    }));
  };
  // Typing goes through the input handlers, as a keyboard's does (markdown.test.js has the reasons).
  const typeQ = () => {
    const { from, to } = view.state.selection.main;
    const defaultInsert = () => view.state.update({ changes: { from, to, insert: "Q" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    for (const handler of view.state.facet(EditorView.inputHandler)) if (handler(view, from, to, "Q", defaultInsert)) return;
    view.dispatch({ changes: { from, to, insert: "Q" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  };
  const load = (text) => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    view.dispatch({ selection: { anchor: 0 } });
  };

  // A fixture's plain text — what a reader sees — and the source offsets of each plain offset.
  const plainOf = (fx) => {
    const [, src, mask] = fx;
    let plain = "";
    const p2s = [];   // plain offset -> the source offsets it can be (several next to a marker)
    const s2p = [];
    for (let i = 0, j = 0; i <= src.length; i++) {
      s2p[i] = j; (p2s[j] ??= []).push(i);
      if (i < src.length && mask[i] === "1") { plain += src[i]; j++; }
    }
    return { src, mask, plain, p2s, s2p, wrap: fx[3] === 1 };
  };
  const lines = (plain) => {
    const out = [];
    let a = 0;
    for (let k = 0; k <= plain.length; k++) if (k === plain.length || plain[k] === "\n") { out.push([a, k]); a = k + 1; }
    return out;
  };
  // The plain offsets where a row starts in `a..b`, in the layout drawn now: a character that
  // begins below the middle of the one before it. Spaces are skipped; a space at a wrap can sit on
  // either row.
  const rowStarts = (F, a, b) => {
    const out = [];
    let lastMid = -Infinity;
    for (let p = a; p < b; p++) {
      if (F.plain[p] === " ") continue;
      const s = F.p2s[p].find((i) => F.mask[i] === "1") ?? F.p2s[p][0];
      const r = view.coordsAtPos(s, 1);
      if (!r) continue;
      if (r.top > lastMid && lastMid > -Infinity) out.push(p);
      lastMid = (r.top + r.bottom) / 2;
    }
    return out;
  };
  // Where the role sits in this layout, as the sweep found it in each app's (`sweep.swift`).
  const roleAt = (F, needle, role) => {
    const at = F.plain.indexOf(needle);
    if (at < 0) return null;
    let end = F.plain.indexOf("\n", at); if (end < 0) end = F.plain.length;
    const starts = [at, ...rowStarts(F, at, end).filter((w) => w > at)];
    const rows = starts.map((s, k) => [s, k + 1 < starts.length ? starts[k + 1] : end]);
    if (rows.length < 2) return null;
    const mid = (a, b) => { let m = Math.floor((a + b) / 2); for (let i = 0; i < 6 && m > a + 1 && m < b - 1 && (F.plain[m] === " " || F.plain[m - 1] === " "); i++) m++; return m; };
    const [part, where] = role.split(".");
    if (part === "c") return null;   // a construct role: resolved by the caller, which knows the construct
    const row = part === "rL" ? rows[rows.length - 1] : rows[Number(part.slice(1)) - 1];
    if (!row) return null;
    const [a, b] = row;
    if (where === "first") return a;
    if (where === "mid") return mid(a, b);
    if (where === "end") return b === end ? b : F.plain[b - 1] === " " ? b - 1 : null;
    return null;
  };
  const constructAt = (F, needle, role, con) => {
    const at = F.plain.indexOf(needle);
    let end = F.plain.indexOf("\n", at); if (end < 0) end = F.plain.length;
    const [ca, cb] = con;
    const where = role.split(".")[1];
    if (where === "first") return ca;
    if (where === "last") return cb;
    if (where === "in1") return ca + 2;
    const starts = [at, ...rowStarts(F, at, end).filter((w) => w > at)];
    const last = [...starts].reverse().find((s) => s < cb);
    if (last === undefined || last <= ca) return null;
    let m = Math.floor((Math.max(last, ca) + cb) / 2);
    for (let i = 0; i < 6 && m > last + 1 && m < cb - 1 && (F.plain[m] === " " || F.plain[m - 1] === " "); i++) m++;
    return m;
  };

  const EditorSelection = view.state.selection.constructor;
  const { fixtures, starts, keys, cells } = GOLDEN;
  const F = fixtures.map(plainOf);
  const edit = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < Math.min(a.length, b.length) - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    return [i, a.length - j - i, b.slice(i, b.length - j)];
  };
  const trim = (s) => s.replace(/\n+$/, "");
  const nextToMarker = (fx, s) => (s > 0 && fx.mask[s - 1] === "0") || (s < fx.mask.length && fx.mask[s] === "0");
  // Every line's row starts, in plain offsets, in the layout drawn now; the document is the fixture.
  const snapshot = (fx) => lines(fx.plain).map(([a, b]) => rowStarts(fx, a, b).filter((w) => a < w && w < b));
  const labelIn = (fx, rowsByLine, p, drawnUp) => {
    const ls = lines(fx.plain);
    let li = ls.findIndex(([a, b]) => a <= p && p <= b);
    if (li < 0) li = ls.length - 1;
    const [a, b] = ls[li], rows = rowsByLine[li];
    let r = rows.filter((w) => w <= p).length;
    const atEnd = rows.includes(p) && drawnUp;
    if (atEnd) r -= 1;
    const rs = [a, ...rows], re = [...rows, b];
    let kind = "mid";
    if (atEnd || p === re[r]) kind = "end";
    else if (r < rows.length && p === re[r] - 1 && fx.plain[p] === " ") kind = "end";
    else if (p === rs[r]) kind = "first";
    return [li, r, kind, kind === "mid" ? p : null];
  };
  const place = (at, assoc) => view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(at, assoc)]) });

  // `Scripts/test-gestures.sh` runs the cells in slices, so a long replay shows its progress.
  const [lo, hi] = typeof RANGE === "undefined" ? [0, cells.length] : RANGE;
  // A role start whose no-key cell does not match in this layout is a different start here (the
  // sweep sets such starts aside too): its cells are skipped and counted, not failed.
  const offStarts = new Set();
  let skipped = 0;
  // Rows waiting on Cole's call (2026-10-19): `**left***right*` draws as one word, so is ⌥ a word
  // move or a style stop; and ⌥⌦ at a nested ordered item's start (158). They run; a divergence is
  // a note, not a failure, until the call lands.
  const PENDING = new Set(["st.adj · @22 · opt+right", "st.adj · @26 · opt+right", "st.adj · @26 · shift+opt+right",
    "st.adj · @26 · opt+fdel", "st.adj · @33 · opt+left", "ne.olist · @37 · opt+fdel"]);
  let pending = 0;
  const fail = (f) => { if (PENDING.has(f.case.split("  [")[0])) pending++; else failures.push(f); };
  for (const [si, ki, wantFrom, wantDel, wantIns, wantLabels, why] of cells.slice(lo, hi)) {
    if (offStarts.has(si)) { skipped++; continue; }
    const [fi, spec] = starts[si];
    const fx = F[fi], fid = fixtures[fi][0], con = fixtures[fi][4], combo = keys[ki];
    const name = `${fid} · ${spec.role ?? `@${spec.at}`} · ${combo}`;
    load(fx.src);
    // The start: a source offset, or a role found in this layout and put on the side of its
    // markers the golden start was on.
    let at = spec.at, assoc = 0;
    if (spec.role) {
      const p = spec.role.startsWith("c.") ? (con ? constructAt(fx, spec.needle, spec.role, con) : null) : roleAt(fx, spec.needle, spec.role);
      checked++;
      if (p === null) { failures.push({ case: name, want: "the start", got: "no such role in this layout" }); continue; }
      checked--;
      const choices = fx.p2s[p];
      at = choices[Math.min(spec.side, choices.length - 1)];
      if (spec.role.endsWith(".first")) assoc = 1;
    }
    place(at, assoc);
    const tokens = combo === "-" ? [] : combo.split(" ");
    const edits = tokens.some((k) => EDITS.has(k));
    // From a role start, a mid-row end is on whatever word this layout put there: by row only.
    const loose = VERTICAL.has(tokens[tokens.length - 1]) || !!spec.role;
    const startRows = wantLabels && edits ? snapshot(fx) : null;
    // The keys, then the readout: where the caret is drawn, and the rows, before the probe.
    for (const k of tokens) press(k);
    const sel = view.state.selection.main;
    const unchanged = view.state.doc.toString() === fx.src;
    let drawnUp = false;
    if (sel.empty && unchanged) {
      const drawn = view.coordsAtPos(sel.head, sel.assoc || 1), lower = view.coordsAtPos(sel.head, 1);
      drawnUp = !!(drawn && lower && drawn.top < lower.top - 2);
    }
    const endRows = wantLabels && !edits && unchanged ? snapshot(fx) : null;
    let out;
    if (edits || !unchanged || nextToMarker(fx, sel.from) || nextToMarker(fx, sel.to)) { typeQ(); out = view.state.doc.toString(); }
    else out = fx.src.slice(0, sel.from) + "Q" + fx.src.slice(sel.to);
    const [from, del, ins] = edit(trim(fx.src), trim(out));
    checked++;
    const same = from === wantFrom && del === wantDel && ins === wantIns;
    const near = trim(out).slice(Math.max(0, from - 14), from + Math.max(del, ins.length) + 14).replace(/\n/g, "⏎");
    // The same place on screen, with every marker as the golden has it, the only difference which
    // side of a hidden marker the caret is on: Pane's side is 177's, so it is the same outcome.
    const wantDoc = trim(fx.src).slice(0, wantFrom) + wantIns + trim(fx.src).slice(wantFrom + wantDel);
    const marks = (t) => ["**", "`", "~~", "==", "<u>", "</u>", "["].map((m) => t.split(m).length - 1).join(",");
    const plain = (t) => t.replace(/\]\(https:\/\/[a-z./]+\)/g, "").replace(/\*\*|\*|`|~~|==|<u>|<\/u>|\[|\]/g, "");
    const onScreen = !same && marks(wantDoc) === marks(trim(out)) && plain(wantDoc) === plain(trim(out));
    if (!wantLabels) {
      if (!same && !onScreen) fail({ case: `${name}  [${why}]`, want: `${JSON.stringify(wantIns)} at ${wantFrom}, ${wantDel} gone`, got: `${JSON.stringify(ins)} at ${from}, ${del} gone: …${near}…` });
      continue;
    }
    const rowsByLine = startRows ?? endRows ?? snapshot(fx);
    const p0 = fx.s2p[Math.min(from, fx.src.length)], p1 = fx.s2p[Math.min(from + del, fx.src.length)];
    const mine = [labelIn(fx, rowsByLine, p0, drawnUp), p1 !== p0 ? labelIn(fx, rowsByLine, p1, false) : null];
    // A vertical move lands by x, which the fonts decide: line and row only. Otherwise a role
    // start's mid-row places are whatever this layout has there, so by line, row and kind.
    const vertical = VERTICAL.has(tokens[tokens.length - 1]);
    const key = (l) => (l == null ? null : vertical ? l.slice(0, 2).join(".") : loose || l[2] !== "mid" ? l.slice(0, 3).join(".") : l.join("."));
    const labelsMatch = key(mine[0]) === key(wantLabels[0]) && key(mine[1]) === key(wantLabels[1]);
    // Same bytes is the same outcome, except a caret at a wrap point here drawn on the other row
    // from the golden's. Where this layout has no wrap at that place, there is no row to disagree on.
    const ln = lines(fx.plain).findIndex(([a, b]) => a <= p0 && p0 <= b);
    const atWrap = sel.empty && ln >= 0 && rowsByLine[ln].includes(p0);
    const wantUp = wantLabels[0]?.[2] === "end", wantDown = wantLabels[0]?.[2] === "first";
    const ok = same || onScreen ? !fx.wrap || !atWrap || (wantUp ? drawnUp : wantDown ? !drawnUp : true)
                    : (ins === wantIns || (spec.role && del === wantDel && ins.replace("Q", "") === wantIns.replace("Q", ""))) && labelsMatch;
    if (!ok && spec.role && combo === "-") { offStarts.add(si); checked--; skipped++; continue; }
    if (!ok) {
      const show = (ls) => ls.map((l) => (l ? l.slice(0, 3).join(".") : "")).join("…");
      fail({ case: `${name}  [${why}]`, want: `${JSON.stringify(wantIns)} at ${wantFrom}  ${show(wantLabels)}`, got: `${JSON.stringify(ins)} at ${from}  ${show(mine)}: …${near}…` });
    }
  }
  const notes = [];
  if (skipped) notes.push(`${skipped} cells from ${offStarts.size} wrapped-row starts this layout places differently, skipped`);
  if (pending) notes.push(`${pending} cells pending a call, diverging`);
  const note = notes.length ? notes.join("; ") : undefined;
  return { checked, failures, note };
}
