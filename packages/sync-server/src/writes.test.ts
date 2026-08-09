import assert from "node:assert/strict";
import { test } from "node:test";
import { DirtyBufferIndex, isWriteTool, targetPath } from "./writes.js";

const CWD = "/work/project";

// ---------------------------------------------------------------------------
// Which calls touch a file, and which file
// ---------------------------------------------------------------------------

test("write tools are recognised, read tools are not", () => {
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(isWriteTool(t), true, t);
  }
  for (const t of ["Read", "Glob", "Grep", "Bash", "WebFetch"]) {
    assert.equal(isWriteTool(t), false, t);
  }
});

test("a relative path resolves against the agent's workspace root", () => {
  assert.equal(
    targetPath("Edit", { file_path: "src/login.ts" }, CWD),
    "/work/project/src/login.ts",
  );
});

test("an absolute path is kept, and traversal is normalised away", () => {
  assert.equal(
    targetPath("Write", { file_path: "/work/project/src/a.ts" }, CWD),
    "/work/project/src/a.ts",
  );
  // Both forms must land on the same string, or the dirty-buffer comparison
  // silently misses and someone loses their work.
  assert.equal(
    targetPath("Write", { file_path: "src/../src/a.ts" }, CWD),
    "/work/project/src/a.ts",
  );
});

test("notebook edits are covered too", () => {
  assert.equal(
    targetPath("NotebookEdit", { notebook_path: "explore.ipynb" }, CWD),
    "/work/project/explore.ipynb",
  );
});

test("a non-write tool has no target, whatever it carries", () => {
  assert.equal(targetPath("Bash", { file_path: "src/a.ts" }, CWD), null);
});

test("unusable input yields null rather than a wrong path", () => {
  assert.equal(targetPath("Write", undefined, CWD), null);
  assert.equal(targetPath("Write", {}, CWD), null);
  assert.equal(targetPath("Write", { file_path: "" }, CWD), null);
  assert.equal(targetPath("Write", { file_path: 42 }, CWD), null);
});

// ---------------------------------------------------------------------------
// Who would lose work
// ---------------------------------------------------------------------------

test("reports exactly the people holding that file unsaved", () => {
  const index = new DirtyBufferIndex();
  index.set("r", "alice", ["/work/project/src/login.ts"]);
  index.set("r", "bob", ["/work/project/README.md"]);

  assert.deepEqual(index.holders("r", "/work/project/src/login.ts"), ["alice"]);
  assert.deepEqual(index.holders("r", "/work/project/README.md"), ["bob"]);
  assert.deepEqual(index.holders("r", "/work/project/src/other.ts"), []);
});

test("two people editing the same file are both reported", () => {
  const index = new DirtyBufferIndex();
  index.set("r", "alice", ["/work/project/a.ts"]);
  index.set("r", "bob", ["/work/project/a.ts"]);
  assert.deepEqual(index.holders("r", "/work/project/a.ts").sort(), [
    "alice",
    "bob",
  ]);
});

test("saving a file releases it", () => {
  const index = new DirtyBufferIndex();
  index.set("r", "alice", ["/work/project/a.ts", "/work/project/b.ts"]);
  // Reports are the whole set, so saving a.ts arrives as a set without it.
  index.set("r", "alice", ["/work/project/b.ts"]);

  assert.deepEqual(index.holders("r", "/work/project/a.ts"), []);
  assert.deepEqual(index.holders("r", "/work/project/b.ts"), ["alice"]);
});

test("leaving the room releases everything that participant held", () => {
  const index = new DirtyBufferIndex();
  index.set("r", "alice", ["/work/project/a.ts"]);
  index.clear("r", "alice");

  // Otherwise a participant who closed their laptop blocks writes forever.
  assert.deepEqual(index.holders("r", "/work/project/a.ts"), []);
});

test("rooms do not see each other's unsaved files", () => {
  const index = new DirtyBufferIndex();
  index.set("alpha", "alice", ["/work/project/a.ts"]);
  assert.deepEqual(index.holders("beta", "/work/project/a.ts"), []);
});

test("paths are compared after normalisation, not as raw strings", () => {
  const index = new DirtyBufferIndex();
  index.set("r", "alice", ["/work/project/src/../src/a.ts"]);
  assert.deepEqual(index.holders("r", "/work/project/src/a.ts"), ["alice"]);
});
