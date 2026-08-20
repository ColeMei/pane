/*
 * The note's name, as the title bar shows it.
 *
 * **A deliberate port of `MarkdownDocument.title(of:)`, rule for rule.** Swift already answers this
 * question — it is what the ⌘P switcher prints on every row — and the answer must be the same in
 * both places or the same note has two names: the title bar said `**Let's try**` while the switcher
 * said `Let's try`, and a note whose first line was blank had no title at all in the bar while the
 * switcher read on to the first line with something on it.
 *
 * It is not simply asked of Swift because the title has to follow the first line *as it is typed*
 * (decision 54), and that would be a bridge round trip on every keystroke — on the one path in the
 * product that has to stay quiet. So the rules live in two places on purpose, and the corpus in
 * `MarkdownDocumentTests.swift` is the same corpus the probe runs against this file, so the two
 * cannot drift without a test saying so.
 */

/** Leading `- `, `* `, `+ `, `1. ` or `1) `, as a length. Null when the line does not start one. */
function leadingListMarker(s: string): number | null {
  const first = s[0];
  if (first === "-" || first === "*" || first === "+") {
    const rest = s.slice(1);
    if (rest[0] === " " || rest.length === 0) {
      // A line of nothing but dashes is a horizontal rule, not a bullet.
      return [...s].every((c) => c === first || c === " ") ? null : 1;
    }
    return null;
  }

  const digits = /^\d{1,9}/.exec(s)?.[0];
  if (digits) {
    const after = s.slice(digits.length);
    if (after[0] === "." || after[0] === ")") {
      const rest = after.slice(1);
      if (rest[0] === " " || rest.length === 0) return digits.length + 1;
    }
  }
  return null;
}

function dropLeadingSpaces(s: string): string {
  return s.replace(/^[ \t]+/, "");
}

/** The index of the `]` closing the `[` at `start`, honouring nesting. */
function matchingBracket(chars: string[], start: number): number | null {
  let depth = 0;
  for (let i = start; i < chars.length; i++) {
    if (chars[i] === "[") depth++;
    if (chars[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/**
 * Removes emphasis, strike, inline-code and link syntax so the title reads as prose.
 *
 * Character-level rather than a parse, exactly as Swift does it: this runs on every keystroke, and
 * a title that keeps a stray asterisk is a cosmetic miss where a parser on this path is a hitch in
 * the one interaction the product is built around.
 */
function stripInlineMarkers(s: string): string {
  const chars = [...s];
  let out = "";
  let i = 0;

  while (i < chars.length) {
    const c = chars[i]!;

    // Escaped punctuation: keep the character, drop the backslash.
    if (c === "\\" && i + 1 < chars.length) {
      out += chars[i + 1];
      i += 2;
      continue;
    }

    // Runs of emphasis markers vanish entirely.
    if (c === "*" || c === "_" || c === "`" || c === "~") {
      while (i < chars.length && chars[i] === c) i++;
      continue;
    }

    // `[label](target)` and `![alt](target)` collapse to the label.
    if (c === "[") {
      const close = matchingBracket(chars, i);
      if (close !== null) {
        const label = chars.slice(i + 1, close).join("");
        let j = close + 1;
        if (chars[j] === "(") {
          let depth = 1;
          j++;
          while (j < chars.length && depth > 0) {
            if (chars[j] === "(") depth++;
            if (chars[j] === ")") depth--;
            j++;
          }
          if (out.endsWith("!")) out = out.slice(0, -1);
          out += stripInlineMarkers(label);
          i = j;
          continue;
        }
      }
    }

    out += c;
    i++;
  }

  return out;
}

/** One line, with its block markers and inline syntax taken off. */
export function displayText(line: string): string {
  let s = line;

  // Leading block markers, in the order they can legally nest: `> ` quotes, a list marker, a task box.
  while (s[0] === ">") s = dropLeadingSpaces(s.slice(1));
  s = dropLeadingSpaces(s);

  if (s[0] === "#") {
    const hashes = /^#+/.exec(s)![0];
    const rest = s.slice(hashes.length);
    // ATX headings need whitespace after the hashes; `#hashtag` is not a heading.
    if (hashes.length <= 6 && (rest[0] === " " || rest.length === 0)) {
      s = dropLeadingSpaces(rest).replace(/#+$/, "").replace(/[ \t]+$/, "");
    }
  } else {
    const marker = leadingListMarker(s);
    if (marker !== null) {
      s = dropLeadingSpaces(s.slice(marker));
      // A task checkbox, checked or not.
      if (s[0] === "[" && s.length >= 3 && s[2] === "]" && /^[ xX]$/.test(s[1]!)) {
        s = dropLeadingSpaces(s.slice(3));
      }
    }
  }

  return stripInlineMarkers(s);
}

/**
 * How far down a note to look for a line with something on it.
 *
 * The first non-blank line is the title (decision 2), and a note that opens with blank lines is
 * ordinary — but this runs on every keystroke, so a document of nothing but empty lines must not
 * be walked end to end each time. Past this, the note has no title worth finding.
 */
const MAX_LINES_SCANNED = 100;

/** The note's title: its first non-blank line, as prose. Empty when there is nothing to show. */
export function noteTitle(lines: Iterable<string>): string {
  let scanned = 0;
  for (const line of lines) {
    if (++scanned > MAX_LINES_SCANNED) break;
    if (line.trim() !== "") return displayText(line).trim();
  }
  return "";
}
