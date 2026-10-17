/*
 * Every motion keeps its caret's side — `keyboard/motion.ts`. A bare `EditorSelection.cursor(` or
 * `.range(` passed as a transaction's `selection` is read as `{anchor, head}` and loses its side and
 * goal column, so no source file may pass one: `bare:` lists the lines that do, under `src/`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Case } from "./harness";

const BARE = /selection:\s*(?:[^,{}()\n]*\?\s*)?EditorSelection\.(?:cursor|range)\(/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

export const press = (doc: string): string => {
  const root = resolve(process.cwd(), doc.slice("bare:".length));
  const found = files(root).flatMap((path) =>
    readFileSync(path, "utf8").split("\n").flatMap((line, n) => (BARE.test(line) ? [`${relative(root, path)}:${n + 1}`] : [])));
  return found.length ? found.join(" ") : "none";
};

export const cases: Case[] = [
  { name: "no motion passes a bare range as its selection", doc: "bare:src", want: "none" },
  { name: "…and the check finds one", doc: "bare:tests/unit/fixtures-bare", want: "a.ts:1" },
];
