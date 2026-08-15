import { mkdirSync, writeFileSync } from "node:fs";

/**
 * Mark the compiled test output as ESM.
 *
 * The extension itself ships as CommonJS — the VS Code extension host requires
 * it — so this package cannot declare `"type": "module"` at the top level. But
 * `tsc` emits ES modules here, and the pure rules import the ESM-only
 * `@mpa/crdt`, so the test output has to be ESM to run under `node --test`.
 *
 * Dropping the marker inside the output directory scopes the declaration to
 * exactly the files that need it and leaves `out/extension.js` alone.
 */
mkdirSync("dist", { recursive: true });
writeFileSync("dist/package.json", JSON.stringify({ type: "module" }, null, 2));
