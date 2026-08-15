/*
 * The number in the footer.
 *
 * Counted over the *rendered* text rather than the raw source, so markdown punctuation does not
 * inflate it, and a token only counts if it contains a letter or a digit. That rule was chosen to
 * match the one case in the design that can actually be checked — frame 1d's "Server IPs + ports"
 * note, which reads:
 *
 *     Server IPs + ports
 *     prod    10.0.4.12
 *     staging 10.0.7.3
 *     grafana :3000
 *
 * and is labelled **9 words**. Ten whitespace-separated tokens, of which the bare "+" has no
 * alphanumeric and does not count. The design's other counts are illustrative rather than computed,
 * so this is the only one worth fitting.
 */

/** Strips the markdown that would otherwise be counted as words. */
function toPlainText(markdown: string): string {
  return (
    markdown
      // Fenced code: keep the contents, drop the fences and any language tag.
      .replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, "")
      // Block markers at the start of a line: heading hashes, quote arrows, bullets, numbers, tasks.
      .replace(/^[ \t]*>+[ \t]?/gm, "")
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
      // Horizontal rules leave nothing behind.
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
      // Images and links collapse to their label.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Inline emphasis, code and strike markers.
      .replace(/(\*{1,3}|_{1,3}|~{1,2}|`+)/g, "")
      // Escapes: keep the character, drop the backslash.
      .replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, "$1")
  );
}

export function countWords(markdown: string): number {
  const plain = toPlainText(markdown);
  let count = 0;
  for (const token of plain.split(/\s+/)) {
    // `\p{L}` and `\p{N}` rather than [A-Za-z0-9]: a note written in Chinese or Greek has words too.
    if (token && /[\p{L}\p{N}]/u.test(token)) count++;
  }
  return count;
}
