/*
 * A key that belongs to an input method's composition (204).
 *
 * ⏎ that commits Pinyin letters, or Esc that cancels them, is the input method's, not the panel's.
 * Safari sends it either during the composition (`isComposing`, keyCode 229) or just after
 * `compositionend` (LAB, 2026-10-09), so the one key right after an end counts too, as CodeMirror's
 * own guard does for the note.
 */

let endedAt = -Infinity;
let pending = false;

document.addEventListener(
  "compositionend",
  () => {
    endedAt = performance.now();
    pending = true;
  },
  true
);

export function composing(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  if (pending && performance.now() - endedAt < 100) {
    pending = false;
    return true;
  }
  pending = false;
  return false;
}
