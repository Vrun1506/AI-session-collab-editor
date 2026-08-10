import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyUpdate, stateVector, textOf, Y } from "@mpa/crdt";
import { DocHub } from "./docs.js";

/** A stand-in for an editor: a Y.Doc kept in step with the hub by hand. */
function attach(
  hub: DocHub,
  roomId: string,
  path: string,
  userId: string,
  text: string,
): Y.Doc {
  const doc = new Y.Doc();
  const { update } = hub.open(roomId, path, userId, text, stateVector(doc));
  applyUpdate(doc, update, "remote");
  return doc;
}

test("the first editor to open a file seeds the shared document", () => {
  const hub = new DocHub();
  const { seeded } = hub.open("r", "/w/a.ts", "alice", "hello\n", "");
  assert.equal(seeded, true);
  assert.equal(hub.text("r", "/w/a.ts"), "hello\n");
});

test("a second opener adopts the shared copy rather than imposing its own", () => {
  // Alice has unsaved edits. Bob opens the same file and his disk copy is
  // older. Letting his text win would erase work he cannot even see.
  const hub = new DocHub();
  attach(hub, "r", "/w/a.ts", "alice", "line\nalice was here\n");

  const result = hub.open("r", "/w/a.ts", "bob", "line\n", "");
  assert.equal(result.seeded, false);

  const bob = new Y.Doc();
  applyUpdate(bob, result.update, "remote");
  assert.equal(textOf(bob).toString(), "line\nalice was here\n");
});

test("relative and absolute paths address the same document", () => {
  const hub = new DocHub();
  hub.open("r", `${process.cwd()}/x.ts`, "alice", "x\n", "");
  assert.equal(hub.isLive("r", "x.ts"), true);
});

test("a document lives exactly as long as someone holds it open", () => {
  const hub = new DocHub();
  hub.open("r", "/w/a.ts", "alice", "x\n", "");
  hub.open("r", "/w/a.ts", "bob", "x\n", "");

  assert.equal(hub.close("r", "/w/a.ts", "alice"), false);
  assert.equal(hub.isLive("r", "/w/a.ts"), true);

  assert.equal(hub.close("r", "/w/a.ts", "bob"), true);
  assert.equal(hub.isLive("r", "/w/a.ts"), false);
});

test("a disconnecting peer drops only the documents nobody else holds", () => {
  const hub = new DocHub();
  hub.open("r", "/w/shared.ts", "alice", "", "");
  hub.open("r", "/w/shared.ts", "bob", "", "");
  hub.open("r", "/w/alice-only.ts", "alice", "", "");

  assert.deepEqual(hub.closeAll("r", "alice"), [DocHub.key("/w/alice-only.ts")]);
  assert.equal(hub.isLive("r", "/w/shared.ts"), true);
});

test("an editor's update reaches the hub's copy", () => {
  const hub = new DocHub();
  const alice = attach(hub, "r", "/w/a.ts", "alice", "start\n");

  textOf(alice).insert(0, "typed ");
  const update = Buffer.from(
    Y.encodeStateAsUpdate(alice, Y.encodeStateVector(new Y.Doc())),
  ).toString("base64");

  assert.equal(hub.apply("r", "/w/a.ts", update), true);
  assert.equal(hub.text("r", "/w/a.ts"), "typed start\n");
});

test("an agent write merges around what someone is typing", () => {
  const hub = new DocHub();
  const before = "export function login() {\n  return null;\n}\n";
  const alice = attach(hub, "r", "/w/login.ts", "alice", before);

  // Alice adds a line at the end while the agent's tool call is running.
  textOf(alice).insert(before.length, "// alice\n");
  hub.apply(
    "r",
    "/w/login.ts",
    Buffer.from(
      Y.encodeStateAsUpdate(alice, Y.encodeStateVector(new Y.Doc())),
    ).toString("base64"),
  );

  const outcome = hub.merge(
    "r",
    "/w/login.ts",
    before,
    "export function login() {\n  validate();\n  return null;\n}\n",
  );

  assert.ok(outcome);
  assert.equal(outcome!.report.conflicts, 0);
  assert.ok(outcome!.update, "there is an update to fan out");

  const text = hub.text("r", "/w/login.ts")!;
  assert.ok(text.includes("validate();"));
  assert.ok(text.includes("// alice"));

  // And the editor converges on exactly the same thing.
  applyUpdate(alice, outcome!.update!, "remote");
  assert.equal(textOf(alice).toString(), text);
});

test("a write to a file nobody has open is not the hub's business", () => {
  const hub = new DocHub();
  assert.equal(hub.merge("r", "/w/cold.ts", "a", "b"), null);
});

test("locking is reported only for documents that exist", () => {
  const hub = new DocHub();
  assert.equal(hub.setLock("r", "/w/nothing.ts", true), false);
  hub.open("r", "/w/a.ts", "alice", "", "");
  assert.equal(hub.setLock("r", "/w/a.ts", true), true);
  assert.equal(hub.get("r", "/w/a.ts")!.locked, true);
});
