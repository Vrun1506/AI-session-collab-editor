import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as Y from "yjs";
import {
  AGENT_ORIGIN,
  applyUpdate,
  mergeText,
  setText,
  stateSince,
  stateVector,
  textOf,
} from "./text.js";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  textOf(doc).insert(0, text);
  return doc;
}

test("a merge into an untouched document produces exactly the after text", () => {
  const doc = docWith("one\ntwo\nthree\n");
  const report = mergeText(
    textOf(doc),
    "one\ntwo\nthree\n",
    "one\nTWO\nthree\n",
  );

  assert.equal(textOf(doc).toString(), "one\nTWO\nthree\n");
  assert.equal(report.conflicts, 0);
  assert.equal(report.applied, 1);
});

test("a keystroke typed during the agent's write survives the merge", () => {
  // The scenario the milestone exists for. The agent read the file, thought
  // for a few seconds, and wrote it back — and in that window a human typed
  // somewhere else in the same file.
  const before = "function login() {\n  return null;\n}\n\nexport {};\n";
  const doc = docWith(before);

  textOf(doc).insert(before.length, "// a human was typing\n");

  const after = "function login() {\n  validate();\n  return null;\n}\n\nexport {};\n";
  const report = mergeText(textOf(doc), before, after);

  const result = textOf(doc).toString();
  assert.equal(report.conflicts, 0);
  assert.ok(result.includes("validate();"), "the agent's change landed");
  assert.ok(
    result.includes("// a human was typing"),
    "the human's keystrokes survived",
  );
});

test("an edit above the agent's hunk moves it rather than misplacing it", () => {
  const before = "a\nb\nc\nd\ne\n";
  const doc = docWith(before);
  textOf(doc).insert(0, "new first line\n");

  const report = mergeText(textOf(doc), before, "a\nb\nC\nd\ne\n");

  assert.equal(report.conflicts, 0);
  assert.equal(report.moved, 1);
  assert.equal(textOf(doc).toString(), "new first line\na\nb\nC\nd\ne\n");
});

test("an agent edit to a line a human just rewrote is a conflict, not an overwrite", () => {
  const before = "const timeout = 1000;\n";
  const doc = docWith(before);
  // The human replaced the very thing the agent was about to change.
  setText(textOf(doc), "const timeout = FOREVER;\n");

  const report = mergeText(textOf(doc), before, "const timeout = 5000;\n");

  assert.equal(report.applied, 0);
  assert.equal(report.conflicts, 1);
  assert.equal(
    textOf(doc).toString(),
    "const timeout = FOREVER;\n",
    "the human's version is left alone",
  );
});

test("merged ranges point at what the writer inserted", () => {
  const doc = docWith("alpha\nbravo\n");
  const report = mergeText(textOf(doc), "alpha\nbravo\n", "alpha\nBRAVO\n");

  const text = textOf(doc).toString();
  const range = report.inserted[0]!;
  assert.equal(text.slice(range.at, range.at + range.length), "BRAVO");
});

test("a merge carries its origin so peers can tell who wrote it", () => {
  const doc = docWith("x\n");
  const origins: unknown[] = [];
  doc.on("update", (_u: Uint8Array, origin: unknown) => origins.push(origin));

  mergeText(textOf(doc), "x\n", "y\n");
  assert.deepEqual(origins, [AGENT_ORIGIN]);
});

test("a whole merge arrives as one transaction", () => {
  const doc = docWith("a\nb\nc\nd\ne\nf\ng\n");
  let updates = 0;
  doc.on("update", () => updates++);

  const report = mergeText(
    textOf(doc),
    "a\nb\nc\nd\ne\nf\ng\n",
    "a\nB\nc\nd\ne\nF\ng\n",
  );

  assert.equal(report.applied, 2);
  assert.equal(updates, 1, "two hunks, one update — peers see it land at once");
});

test("setText reconciles a document to a target", () => {
  const doc = docWith("hello\nworld\n");
  setText(textOf(doc), "hello\nthere\nworld\n");
  assert.equal(textOf(doc).toString(), "hello\nthere\nworld\n");
});

// ---- transport -------------------------------------------------------------

test("a peer syncing by state vector receives only what it is missing", () => {
  const server = docWith("shared line\n");
  const client = new Y.Doc();

  applyUpdate(client, stateSince(server, stateVector(client)), "remote");
  assert.equal(textOf(client).toString(), "shared line\n");

  textOf(server).insert(0, "prepended\n");
  applyUpdate(client, stateSince(server, stateVector(client)), "remote");
  assert.equal(textOf(client).toString(), "prepended\nshared line\n");
});

test("two peers typing in the same file converge", () => {
  // Neither the relay nor either editor does any merging here — this is the
  // property that makes it a CRDT rather than a broadcast channel.
  const alice = docWith("shared\n");
  const bob = new Y.Doc();
  applyUpdate(bob, stateSince(alice), "remote");

  textOf(alice).insert(0, "alice: ");
  textOf(bob).insert(bob.getText("content").length, "bob was here\n");

  const fromAlice = stateSince(alice, stateVector(bob));
  const fromBob = stateSince(bob, stateVector(alice));
  applyUpdate(bob, fromAlice, "remote");
  applyUpdate(alice, fromBob, "remote");

  assert.equal(textOf(alice).toString(), textOf(bob).toString());
  assert.ok(textOf(alice).toString().includes("alice: "));
  assert.ok(textOf(alice).toString().includes("bob was here"));
});
