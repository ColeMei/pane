/*
 * Builds the editor into ONE self-contained HTML file at dist/index.html.
 *
 * Single file on purpose. The bundle is loaded inside a WKWebView with no network access, so anything
 * that resolves at runtime — a CDN script, an external stylesheet, a web font, a source map fetch —
 * would not merely be slow, it would not load at all. Inlining makes that failure impossible rather
 * than merely unlikely, and it means the Swift side has exactly one file to serve.
 */

import { build, context } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/** Safari 17 is the engine in the WKWebView on macOS 14, which is the deployment target. */
const TARGET = "safari17";

const options = {
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  // Nothing is written here — `write: false` keeps the outputs in memory so they can be inlined into
  // the HTML below. esbuild still needs somewhere to *name* them, and refuses to emit the CSS bundle
  // without it.
  outdir: resolve(root, "dist"),
  format: "iife",
  target: TARGET,
  platform: "browser",
  write: false,
  minify: !watch,
  // No source maps: they would be a second file the web view cannot fetch, and inlining them would
  // double the bundle for no benefit in a shipped panel.
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
};

async function emit(result) {
  const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";

  const template = await readFile(resolve(root, "src/index.html"), "utf8");
  const html = template
    .replace("__STYLES__", () => css)
    .replace("__SCRIPT__", () => js);

  await mkdir(resolve(root, "dist"), { recursive: true });
  await writeFile(resolve(root, "dist/index.html"), html, "utf8");

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  console.log(
    `dist/index.html  ${kb(Buffer.byteLength(html))}  (js ${kb(Buffer.byteLength(js))}, css ${kb(Buffer.byteLength(css))})`
  );
}

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: "emit-html",
        setup(b) {
          b.onEnd(async (result) => {
            if (result.errors.length === 0) await emit(result);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log("watching…");
} else {
  await emit(await build(options));
}
