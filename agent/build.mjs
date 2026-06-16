/*
 * build.mjs — minimal, dependency-light MV3 build.
 * -----------------------------------------------------------------------------
 * Bundles the TS entry points with esbuild (ESM) and copies the static assets
 * (manifest.json, side panel HTML/CSS) into dist/ so the result is a directly
 * load-unpacked-able MV3 extension. No dev server, no framework — keeps the
 * scaffold easy to audit (a Phase-1 trust requirement).
 *
 *   dist/
 *     manifest.json
 *     background/index.js
 *     sidepanel/index.html
 *     sidepanel/sidepanel.js
 *     sidepanel/sidepanel.css
 *
 * Usage: `node build.mjs` (prod) or `node build.mjs --watch`.
 * -----------------------------------------------------------------------------
 */
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: {
    "background/index": join(root, "src/background/index.ts"),
    "sidepanel/sidepanel": join(root, "src/sidepanel/sidepanel.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "chrome114",
  platform: "browser",
  sourcemap: true,
  logLevel: "info",
};

async function copyStatic() {
  await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
  await mkdir(join(dist, "sidepanel"), { recursive: true });
  await cp(
    join(root, "src/sidepanel/index.html"),
    join(dist, "sidepanel/index.html"),
  );
  await cp(
    join(root, "src/sidepanel/sidepanel.css"),
    join(dist, "sidepanel/sidepanel.css"),
  );
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const ctx = await context(buildOptions);
  await ctx.rebuild();
  await copyStatic();
  await ctx.watch();
  console.log("[agent] watching for changes…");
} else {
  await build(buildOptions);
  await copyStatic();
  console.log("[agent] build complete → dist/");
}
