/*
 * Pane's markdown: CommonMark and GFM, with three rules of its own — decision 158.
 *
 * The parser is the one reading every part of the app agrees on — what is drawn, where the caret
 * rests, what ⏎ continues, what renumbering counts — so the rules live here and nowhere else. The
 * bytes are never touched: a file means what it says, and Pane reads a few edge cases differently
 * from GitHub.
 *
 *   1. **A block marker waits for its space.** `#`, `-`, `1.` and `>` on their own are text; `# `,
 *      `- `, `1. ` and `> ` start the block. A rule and a fence have no space in them and still form
 *      on their third character (152).
 *   2. **A list item holds text.** No heading, rule, quote, fence, code block, table or HTML inside
 *      one, and no second list marker on its line: a nested list is made with ⇥, on a line of its
 *      own. A to-do is a bullet's; `1. [ ]` is a number followed by text.
 *   3. **A quote holds lists.** Paragraphs, lists and a deeper quote; no heading, rule, fence, code
 *      block, table or HTML.
 *
 * Each built-in block rule is replaced by name with a guard that calls the original, so everything
 * the original does (its node shapes, its continuation lines) is unchanged when the guard lets it
 * through.
 */

import { markdownLanguage } from "@codemirror/lang-markdown";
import type {
  BlockContext,
  BlockParser,
  LeafBlock,
  LeafBlockParser,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

type Parse = (cx: BlockContext, line: Line) => boolean | null;
type Leaf = (cx: BlockContext, leaf: LeafBlock) => LeafBlockParser | null;

/** The built-in rules, taken off the configured parser. Not public API, hence the cast. */
const base = markdownLanguage.parser as unknown as {
  blockNames: string[];
  blockParsers: (Parse | undefined)[];
  leafBlockParsers: (Leaf | undefined)[];
};
const original = (name: string): Parse => base.blockParsers[base.blockNames.indexOf(name)]!;
const originalLeaf = (name: string): Leaf => base.leafBlockParsers[base.blockNames.indexOf(name)]!;

const isSpace = (code: number) => code === 32 || code === 9;

/** Whether any container on the stack is a list item or a quote. */
function inContainer(cx: BlockContext): boolean {
  for (let d = 0; d < cx.depth; d++) {
    const name = cx.parentType(d).name;
    if (name === "ListItem" || name === "Blockquote") return true;
  }
  return false;
}

/** The innermost container that decides what may start here: `ListItem`, `Blockquote` or null. */
function container(cx: BlockContext): string | null {
  for (let d = cx.depth - 1; d >= 0; d--) {
    const name = cx.parentType(d).name;
    if (name === "ListItem" || name === "Blockquote") return name;
  }
  return null;
}

/** A list marker already stands earlier on this line: `- - x`, `1. 1. x`. Quote marks do not count,
 * because `> - x` is how a list inside a quote is written. */
const markerEarlierOnLine = (line: Line) => /[^\s>]/.test(line.text.slice(0, line.pos));

/** The character after a marker `size` long is a space: the marker is finished. */
const spaced = (line: Line, size: number) => isSpace(line.text.charCodeAt(line.pos + size));

/** A leaf block only the top level may hold. */
const topLevelOnly = (name: string): BlockParser => {
  const parse = original(name);
  return { name, parse: (cx, line) => (inContainer(cx) ? false : parse(cx, line)) };
};

const listRule = (name: string, markerSize: (line: Line) => number): BlockParser => {
  const parse = original(name);
  return {
    name,
    parse(cx, line) {
      if (markerEarlierOnLine(line)) return false;
      const size = markerSize(line);
      if (size < 0 || !spaced(line, size)) return false;
      return parse(cx, line);
    },
  };
};

const bulletSize = (line: Line) => (line.next === 45 || line.next === 42 || line.next === 43 ? 1 : -1);
const orderedSize = (line: Line) => {
  const m = /^\d{1,9}[.)]/.exec(line.text.slice(line.pos));
  return m ? m[0].length : -1;
};

/**
 * A setext underline inside a list item or a quote is part of the paragraph above it (158, rule 2).
 *
 * Not done by replacing the built-in setext parser: `isHorizontalRule` checks for that exact object
 * to let a top-level `---` under a paragraph be an underline, and a replacement turns every one of
 * them into a rule. So this runs just before it and takes the line first.
 */
class ContainedUnderline implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (!/^(?:-+|=+)[ \t]*$/.test(line.text.slice(line.pos))) return false;
    const scrubbed = line.text.slice(line.basePos);
    leaf.content += "\n" + scrubbed;
    // `marks` holds the quote markers inside the paragraph; internal, like the rest of this.
    for (const m of line.markers) (leaf as unknown as { marks: unknown[] }).marks.push(m);
    cx.nextLine();
    cx.addLeafElement(
      leaf,
      cx.elt("Paragraph", leaf.start, cx.prevLineEnd(), cx.parser.parseInline(leaf.content, leaf.start))
    );
    return true;
  }
  finish(): boolean {
    return false;
  }
}

const table = originalLeaf("Table");
const task = originalLeaf("TaskList");

/**
 * The same rule for a bullet list's *next* item. CommonMark ends a bullet list at a line that is also
 * a rule, so `- a` ⏎ `- --` started a second list. That check lives in the list's markup skipper,
 * which the config cannot replace, so it is wrapped where it lives. The object is lezer's own and
 * shared by every markdown parser in the bundle; Pane has one.
 */
{
  const parser = markdownLanguage.parser as unknown as {
    nodeSet: { types: readonly { id: number; name: string }[] };
    skipContextMarkup: Record<number, (bl: { value: number }, cx: BlockContext, line: Line) => boolean>;
  };
  const id = parser.nodeSet.types.find((t) => t.name === "BulletList")!.id;
  const skip = parser.skipContextMarkup[id]!;
  if (!(skip as { pane?: true }).pane) {
    const wrapped = (bl: { value: number }, cx: BlockContext, line: Line): boolean =>
      skip(bl, cx, line) ||
      (line.indent < line.baseIndent + 4 && bulletSize(line) > 0 && spaced(line, 1) && line.next === bl.value);
    (wrapped as { pane?: true }).pane = true;
    parser.skipContextMarkup[id] = wrapped;
  }
}

export const paneDialect: MarkdownConfig = {
  parseBlock: [
    {
      name: "ATXHeading",
      parse(cx, line) {
        if (inContainer(cx)) return false;
        const m = /^#{1,6}/.exec(line.text.slice(line.pos));
        if (!m || !spaced(line, m[0].length)) return false;
        return original("ATXHeading")(cx, line);
      },
    },
    {
      // `> ` starts a quote, and so does `>> ` — a run of marks is one marker, finished by its space.
      // A quote may hold a quote (a deeper level, as ⇥ makes a deeper list), never inside an item.
      name: "Blockquote",
      parse(cx, line) {
        if (container(cx) === "ListItem" || !/^>(?:[ \t]*>)*[ \t]/.test(line.text.slice(line.pos))) return false;
        return original("Blockquote")(cx, line);
      },
    },
    {
      // After a list marker and its space the line is an item: `- --` is a bullet holding dashes,
      // not CommonMark's rule, and so is `* * *`. A rule is `---`, `***` or `___` with no marker.
      name: "HorizontalRule",
      parse(cx, line) {
        if (inContainer(cx) || /^([-*+])[ \t]/.test(line.text.slice(line.pos))) return false;
        return original("HorizontalRule")(cx, line);
      },
    },
    listRule("BulletList", bulletSize),
    listRule("OrderedList", orderedSize),
    topLevelOnly("FencedCode"),
    topLevelOnly("IndentedCode"),
    topLevelOnly("HTMLBlock"),
    {
      name: "Table",
      leaf: (cx, leaf) => (container(cx) ? null : table(cx, leaf)),
    },
    {
      // A to-do is a bullet's: `1. [ ]` is a numbered item whose text starts with brackets.
      name: "TaskList",
      leaf(cx, leaf) {
        if (container(cx) !== "ListItem") return null;
        const text = (cx as unknown as { line: Line }).line.text;
        const before = text.slice(0, leaf.start - cx.lineStart);
        if (!/[-*+][ \t]+$/.test(before)) return null;
        return task(cx, leaf);
      },
    },
    {
      name: "ContainedUnderline",
      before: "SetextHeading",
      leaf: (cx) => (container(cx) ? new ContainedUnderline() : null),
    },
  ],
};
