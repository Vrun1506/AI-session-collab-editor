import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideAdoption,
  inReverseOrder,
  isSyncable,
  judgeLocalChange,
  planEdits,
} from "./buffer-rules.js";

/**
 * The buffer-binding rules.
 *
 * Every case here was previously reachable only by opening two VS Code windows
 * and racing them by hand — which is why the trickiest logic in the repo was
 * also the least covered. The three that matter most are the reload guard, the
 * echo guard and the refusal, because each one silently corrupts a file when it
 * is wrong rather than throwing.
 */

// ---------------------------------------------------------------------------
// What may be shared
// ---------------------------------------------------------------------------

const file = {
  scheme: "file",
  isUntitled: false,
  inWorkspace: true,
};

test("an ordinary workspace file is shareable", () => {
  assert.equal(isSyncable(file), true);
});

test("untitled buffers, foreign schemes and outside files are not", () => {
  // No path to agree on.
  assert.equal(isSyncable({ ...file, isUntitled: true }), false);
  // Diff views, git blobs, output panes.
  assert.equal(isSyncable({ ...file, scheme: "git" }), false);
  assert.equal(isSyncable({ ...file, scheme: "untitled" }), false);
  // Not part of the project the room is working on.
  assert.equal(isSyncable({ ...file, inWorkspace: false }), false);
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

test("seeding pushes whatever was typed during the round trip", () => {
  const decision = decideAdoption({
    seeded: true,
    shared: "hello",
    buffer: "hello world",
    isDirty: true,
  });
  // Our text created the shared copy, so nothing of anyone else's is at risk.
  assert.equal(decision.kind, "push-drift");
});

test("identical copies just mark the document synced", () => {
  const decision = decideAdoption({
    seeded: false,
    shared: "same",
    buffer: "same",
    isDirty: false,
  });
  assert.equal(decision.kind, "already-in-sync");
});

test("a clean buffer gives way to somebody else's live copy", () => {
  const decision = decideAdoption({
    seeded: false,
    shared: "theirs, with unsaved work in it",
    buffer: "what disk says",
    isDirty: false,
  });
  // Nothing is lost: our copy is just the file, and theirs may hold edits we
  // have never seen.
  assert.equal(decision.kind, "adopt-shared");
});

test("a dirty buffer that differs from the shared copy refuses to join", () => {
  const decision = decideAdoption({
    seeded: false,
    shared: "their unsaved work",
    buffer: "our unsaved work",
    isDirty: true,
  });
  // Adopting theirs destroys ours; imposing ours destroys theirs. The two texts
  // have no common history to merge from, so there is no correct answer and the
  // honest move is to stay out and say why.
  assert.equal(decision.kind, "refuse");
  assert.match(
    decision.kind === "refuse" ? decision.reason : "",
    /unsaved changes/,
  );
});

test("dirtiness alone does not refuse — only a genuine disagreement does", () => {
  const decision = decideAdoption({
    seeded: false,
    shared: "identical",
    buffer: "identical",
    isDirty: true,
  });
  // Someone typing in a file that already agrees is not a conflict, and
  // refusing here would keep people out of rooms for no reason.
  assert.equal(decision.kind, "already-in-sync");
});

// ---------------------------------------------------------------------------
// Which local changes to push
// ---------------------------------------------------------------------------

const typing = {
  synced: true,
  changeCount: 1,
  applying: 0,
  locked: false,
  isDirty: true,
};

test("a person typing is pushed", () => {
  assert.deepEqual(judgeLocalChange(typing), { push: true });
});

test("our own application of a remote change is not echoed back", () => {
  // Applying a remote change produces a change event of its own; sent back it
  // would loop forever.
  assert.deepEqual(judgeLocalChange({ ...typing, applying: 1 }), {
    push: false,
    because: "our-own-edit",
  });
});

test("a disk reload during an agent write is not mistaken for typing", () => {
  // VS Code silently rereads an unmodified file when it changes on disk. During
  // an agent write that reload IS the agent's change arriving by a second
  // route, and the merge is about to deliver it properly. Pushing it would
  // apply the same edit twice.
  assert.deepEqual(
    judgeLocalChange({ ...typing, locked: true, isDirty: false }),
    { push: false, because: "disk-reload" },
  );
});

test("typing during an agent write still goes — this is the whole point", () => {
  // The buffer stays dirty because a person is editing it, which is exactly the
  // race shared buffers exist to survive. Dropping it would lose their work.
  assert.deepEqual(
    judgeLocalChange({ ...typing, locked: true, isDirty: true }),
    { push: true },
  );
});

test("nothing is pushed before the shared document has arrived", () => {
  // Offsets before that are relative to a text the room does not have.
  assert.deepEqual(judgeLocalChange({ ...typing, synced: false }), {
    push: false,
    because: "not-synced",
  });
});

test("an event carrying no content changes is ignored", () => {
  assert.deepEqual(judgeLocalChange({ ...typing, changeCount: 0 }), {
    push: false,
    because: "no-changes",
  });
});

test("the echo guard outranks the reload guard", () => {
  // Both could apply at once; the reason reported should be the real one.
  assert.deepEqual(
    judgeLocalChange({ ...typing, applying: 1, locked: true, isDirty: false }),
    { push: false, because: "our-own-edit" },
  );
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("content changes are applied last first", () => {
  const changes = [
    { rangeOffset: 0, id: "a" },
    { rangeOffset: 50, id: "b" },
    { rangeOffset: 20, id: "c" },
  ];
  // Every change is positioned against the document as it was before any of
  // them, so applying front-to-back would shift every later offset.
  assert.deepEqual(
    inReverseOrder(changes).map((c) => c.id),
    ["b", "c", "a"],
  );
});

test("ordering does not mutate the editor's array", () => {
  const changes = [{ rangeOffset: 0 }, { rangeOffset: 9 }];
  inReverseOrder(changes);
  assert.deepEqual(
    changes.map((c) => c.rangeOffset),
    [0, 9],
  );
});

// ---------------------------------------------------------------------------
// Planning edits
// ---------------------------------------------------------------------------

test("identical texts produce no edits at all", () => {
  // Idempotence is the property that makes diffing safe where replaying the
  // CRDT delta is not: a buffer that already contains the change is left alone.
  const plan = planEdits("same\n", "same\n");
  assert.deepEqual(plan.edits, []);
  assert.deepEqual(plan.written, []);
});

test("a plan turns the current text into the target", () => {
  const current = "one\ntwo\nthree\n";
  const target = "one\nTWO\nthree\nfour\n";
  const { edits } = planEdits(current, target);
  assert.ok(edits.length > 0);

  // Applying against the original offsets, as a whole-document edit does.
  let result = "";
  let read = 0;
  for (const edit of edits) {
    result += current.slice(read, edit.at) + edit.insert;
    read = edit.at + edit.removeLength;
  }
  result += current.slice(read);
  assert.equal(result, target);
});

test("finalAt tracks where text lands once earlier hunks are applied", () => {
  const current = "a\nb\nc\n";
  const target = "INSERTED\na\nb\nCHANGED\n";
  const { edits } = planEdits(current, target);

  // Applying one at a time, the way a CRDT text is edited.
  let text = current;
  for (const edit of edits) {
    text =
      text.slice(0, edit.finalAt) +
      edit.insert +
      text.slice(edit.finalAt + edit.removeLength);
  }
  assert.equal(text, target);
});

test("written ranges point at the new text in the finished document", () => {
  const current = "keep\n";
  const target = "keep\nadded line\n";
  const { written } = planEdits(current, target);

  assert.equal(written.length, 1);
  const range = written[0]!;
  assert.equal(target.slice(range.at, range.at + range.length), "added line\n");
});

test("a pure deletion highlights nothing", () => {
  // There is no new text to point a reader at.
  const { edits, written } = planEdits("one\ntwo\nthree\n", "one\nthree\n");
  assert.ok(edits.length > 0);
  assert.deepEqual(written, []);
});

test("written ranges survive an earlier hunk changing the length", () => {
  const current = "aaa\nkeep\nccc\n";
  const target = "a\nkeep\nccc\nNEW\n";
  const { written } = planEdits(current, target);

  // The first hunk shortens the text, so a range computed from the original
  // offsets would point two characters past where the new text actually is.
  for (const range of written) {
    const slice = target.slice(range.at, range.at + range.length);
    assert.ok(
      target.includes(slice),
      `highlighted range ${range.at}..${range.at + range.length} is inside the result`,
    );
  }
  const newLine = written.find(
    (r) => target.slice(r.at, r.at + r.length) === "NEW\n",
  );
  assert.ok(newLine, "the added line is highlighted at its real position");
});
