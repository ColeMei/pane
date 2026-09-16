/*
 * The keyboard tables, in plain node.
 *
 * The four WKWebView suites ask what the editor *draws*. This one asks what a key's table *decides*,
 * for a document and a caret, in milliseconds and with no window: every `tests/unit/*.test.ts` is
 * bundled with esbuild (the sources use extensionless imports node cannot resolve), imported, and
 * its `cases` are run through its `press`. A case's `want` is the document after the key with `|`
 * where the caret lands, or the word `fallthrough` when the table must decline and hand the key on.
 *
 * Not a replacement for the markdown suite — a table can be right and the rendering wrong — but it
 * is where a new ⌫ or ⏎ rule is written first, from the report (decision 84).
 */

import { build } from "esbuild";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = resolve(root, "dist/unit");
await mkdir(out, { recursive: true });

const files = (await readdir(here)).filter((f) => f.endsWith(".test.ts")).sort();
let passed = 0;
const failures = [];

for (const file of files) {
  const result = await build({
    entryPoints: [resolve(here, file)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    logLevel: "silent",
  });
  const bundled = resolve(out, file.replace(/\.ts$/, ".mjs"));
  await writeFile(bundled, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(bundled).href + `?t=${Date.now()}`);

  for (const c of mod.cases) {
    const got = mod.press(c.doc);
    if (got === c.want) passed += 1;
    else failures.push({ file, name: c.name, want: c.want, got });
  }
}

const show = (s) => (s === null ? "null" : String(s).replace(/\n/g, "⏎").replace(/ /g, "·"));
for (const f of failures) {
  console.log(`✗ ${f.file} — ${f.name}\n    want ${show(f.want)}\n    got  ${show(f.got)}`);
}
console.log(`${failures.length ? "✗" : "✓"} ${passed + failures.length} keyboard cases, ${failures.length} failing`);
process.exit(failures.length ? 1 : 0);
