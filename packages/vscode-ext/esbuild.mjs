import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** The extension host is CommonJS, so the whole dependency graph — including
 *  the ESM-only @mpa/protocol workspace package — gets bundled down. */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
