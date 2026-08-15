import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventDraft, Identity } from "@mpa/protocol";
import { Room } from "./room.js";
import { MemoryEventStore, SqliteEventStore, type EventStore } from "./store.js";

/**
 * Checkpoints, rewind and fork (M4).
 *
 * The property under test throughout is that rewinding *supersedes* rather than
 * deletes. The log stays append-only, so "what the room is working from" and
 * "what actually happened" remain separately answerable — the first from the
 * compacted replay, the second from the raw log the audit export reads.
 */

const alice: Identity = { userId: "u-alice", name: "alice" };
const agent: EventDraft["actor"] = { kind: "agent" };
const user = (who: Identity): EventDraft["actor"] => ({
  kind: "user",
  userId: who.userId,
  name: who.name,
});

function prompt(promptId: string, text: string): EventDraft {
  return {
    actor: user(alice),
    body: { type: "prompt.submitted", promptId, text },
  };
}

function turnStarted(turnId: string, promptId: string): EventDraft {
  return { actor: agent, body: { type: "turn.started", turnId, promptId } };
}

function checkpoint(
  checkpointId: string,
  turnId: string,
  promptId: string,
  resumeAt: string | null,
): EventDraft {
  return {
    actor: agent,
    body: {
      type: "checkpoint.created",
      checkpointId,
      turnId,
      promptId,
      label: `label for ${promptId}`,
      userMessageId: checkpointId,
      resumeAt,
    },
  };
}

function said(text: string, turnId = "t1"): EventDraft {
  return {
    actor: agent,
    body: { type: "assistant.message", turnId, messageId: `m-${text}`, text },
  };
}

function turnDone(turnId: string): EventDraft {
  return {
    actor: agent,
    body: {
      type: "turn.completed",
      turnId,
      isError: false,
      usage: {
        costUsd: 0.01,
        sessionTotalCostUsd: 0.01,
        durationMs: 10,
        inputTokens: 1,
        outputTokens: 1,
      },
    },
  };
}

function restored(checkpointId: string, fromSeq: number): EventDraft {
  return {
    actor: user(alice),
    body: {
      type: "checkpoint.restored",
      checkpointId,
      label: "back",
      fromSeq,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      skippedLinks: 0,
      sessionId: "session-forked",
    },
  };
}

/** A room with one completed turn, checkpointed. Returns the checkpoint. */
function roomWithOneTurn(room: Room): { fromSeq: number } {
  const promptSeq = room.append(prompt("p1", "do the thing")).seq;
  room.append(turnStarted("t1", "p1"));
  room.append(checkpoint("c1", "t1", "p1", null));
  room.append(said("done"));
  room.append(turnDone("t1"));
  return { fromSeq: promptSeq };
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

test("a checkpoint starts at the prompt, not at its own event", () => {
  const room = new Room("r");
  const { fromSeq } = roomWithOneTurn(room);

  const cp = room.getCheckpoint("c1");
  assert.ok(cp);
  // Rewinding has to take back the prompt as well as the answer, or the room
  // returns to a state where it is about to ask something it already asked.
  assert.equal(cp.fromSeq, fromSeq);
  assert.ok(cp.seq > cp.fromSeq);
});

test("checkpoints are listed oldest first", () => {
  const room = new Room("r");
  roomWithOneTurn(room);
  room.append(prompt("p2", "again"));
  room.append(turnStarted("t2", "p2"));
  room.append(checkpoint("c2", "t2", "p2", "entry-1"));

  assert.deepEqual(
    room.listCheckpoints().map((c) => c.checkpointId),
    ["c1", "c2"],
  );
});

test("an open turn is visible, and closes on completion", () => {
  const room = new Room("r");
  room.append(prompt("p1", "x"));
  room.append(turnStarted("t1", "p1"));
  assert.equal(room.openTurnId, "t1");

  room.append(turnDone("t1"));
  assert.equal(room.openTurnId, null);
});

test("an interrupted turn also counts as closed", () => {
  const room = new Room("r");
  room.append(turnStarted("t1", "p1"));
  room.append({
    actor: agent,
    body: { type: "turn.interrupted", turnId: "t1", byUserId: "u-alice" },
  });
  assert.equal(room.openTurnId, null);
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

test("rewinding supersedes the turn without deleting it", () => {
  const room = new Room("r");
  const { fromSeq } = roomWithOneTurn(room);
  const before = room.since(-1).length;

  room.append(restored("c1", fromSeq));

  // The log only ever grew.
  assert.equal(room.since(-1).length, before + 1);
  // But the abandoned range no longer counts.
  assert.ok(room.isSuperseded(fromSeq));
  assert.ok(!room.isSuperseded(fromSeq - 1));
});

test("a late joiner never receives a turn that was rewound", () => {
  const room = new Room("r");
  const { fromSeq } = roomWithOneTurn(room);
  room.append(restored("c1", fromSeq));

  const replay = room.compactedSince(-1);
  const types = replay.map((e) => e.body.type);
  assert.ok(!types.includes("prompt.submitted"));
  assert.ok(!types.includes("assistant.message"));
  // The rewind itself stays: it is the record that the turn was taken back.
  assert.ok(types.includes("checkpoint.restored"));
});

test("the raw log still holds what a rewind abandoned", () => {
  const room = new Room("r");
  const { fromSeq } = roomWithOneTurn(room);
  room.append(restored("c1", fromSeq));

  // This is the difference between the transcript and the audit trail, and the
  // reason the audit export reads `since` rather than `compactedSince`.
  const raw = room.since(-1).map((e) => e.body.type);
  assert.ok(raw.includes("prompt.submitted"));
  assert.ok(raw.includes("assistant.message"));
});

test("work before the checkpoint survives the rewind", () => {
  const room = new Room("r");
  room.append(said("earlier answer", "t0"));
  const { fromSeq } = roomWithOneTurn(room);
  room.append(restored("c1", fromSeq));

  const kept = room
    .compactedSince(-1)
    .filter((e) => e.body.type === "assistant.message")
    .map((e) => (e.body as { text: string }).text);
  assert.deepEqual(kept, ["earlier answer"]);
});

test("a rewound checkpoint stops being offered", () => {
  const room = new Room("r");
  const { fromSeq } = roomWithOneTurn(room);
  room.append(restored("c1", fromSeq));

  // Its turn is no longer in the transcript, so rewinding to it again would
  // aim at a point the room can no longer see.
  assert.equal(room.getCheckpoint("c1"), undefined);
  assert.deepEqual(room.listCheckpoints(), []);
});

test("earlier checkpoints survive a rewind past them", () => {
  const room = new Room("r");
  roomWithOneTurn(room);

  const secondPrompt = room.append(prompt("p2", "second")).seq;
  room.append(turnStarted("t2", "p2"));
  room.append(checkpoint("c2", "t2", "p2", "entry-1"));
  room.append(said("second answer", "t2"));
  room.append(turnDone("t2"));

  room.append(restored("c2", secondPrompt));

  assert.equal(room.getCheckpoint("c2"), undefined);
  assert.ok(room.getCheckpoint("c1"), "the first turn is still rewindable");
});

test("a rewind closes whatever turn was open", () => {
  const room = new Room("r");
  const promptSeq = room.append(prompt("p1", "x")).seq;
  room.append(turnStarted("t1", "p1"));
  room.append(checkpoint("c1", "t1", "p1", null));
  assert.equal(room.openTurnId, "t1");

  // The query that turn belonged to is gone, so nothing will ever complete it.
  room.append(restored("c1", promptSeq));
  assert.equal(room.openTurnId, null);
});

test("rewinding twice supersedes both ranges", () => {
  const room = new Room("r");
  const first = room.append(prompt("p1", "one")).seq;
  room.append(turnStarted("t1", "p1"));
  room.append(checkpoint("c1", "t1", "p1", null));
  room.append(said("a", "t1"));
  room.append(turnDone("t1"));

  const second = room.append(prompt("p2", "two")).seq;
  room.append(turnStarted("t2", "p2"));
  room.append(checkpoint("c2", "t2", "p2", "e1"));
  room.append(said("b", "t2"));
  room.append(turnDone("t2"));

  room.append(restored("c2", second));
  room.append(restored("c1", first));

  assert.ok(room.isSuperseded(first));
  assert.ok(room.isSuperseded(second));
  const kept = room.compactedSince(-1).map((e) => e.body.type);
  assert.ok(!kept.includes("prompt.submitted"));
  assert.ok(!kept.includes("assistant.message"));
});

test("supersession survives a restart, because it is folded from the log", () => {
  const store = new MemoryEventStore();
  const room = new Room("r", store);
  const { fromSeq } = roomWithOneTurn(room);
  room.append(restored("c1", fromSeq));

  // Nothing about a rewind is stored beside the log, so a fresh Room folding
  // the same history has to reach the same conclusion.
  const reloaded = new Room("r", store);
  assert.ok(reloaded.isSuperseded(fromSeq));
  assert.equal(reloaded.getCheckpoint("c1"), undefined);
  assert.equal(
    reloaded.compactedSince(-1).filter((e) => e.body.type === "prompt.submitted")
      .length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Forking the log
// ---------------------------------------------------------------------------

function withStores(fn: (make: () => EventStore, label: string) => void): void {
  fn(() => new MemoryEventStore(), "memory");

  const dir = mkdtempSync(join(tmpdir(), "mpa-fork-"));
  const stores: SqliteEventStore[] = [];
  try {
    let n = 0;
    fn(() => {
      const s = new SqliteEventStore(join(dir, `fork-${n++}.db`));
      stores.push(s);
      return s;
    }, "sqlite");
  } finally {
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a fork copies the prefix and leaves the source untouched", () => {
  withStores((make, label) => {
    const store = make();
    const source = new Room("a", store);
    const { fromSeq } = roomWithOneTurn(source);
    const sourceLength = source.since(-1).length;

    const copied = store.copyRoom("a", "b", fromSeq);

    assert.equal(copied, fromSeq, `${label}: copies everything below the point`);
    assert.equal(
      source.since(-1).length,
      sourceLength,
      `${label}: the source room keeps running`,
    );

    const forked = new Room("b", store);
    // Sequence numbers carry over, so a checkpoint means the same thing in both
    // logs and the branch point is comparable across them.
    assert.deepEqual(
      forked.since(-1).map((e) => e.seq),
      source
        .since(-1)
        .filter((e) => e.seq < fromSeq)
        .map((e) => e.seq),
      `${label}: seq numbers are preserved, not renumbered`,
    );
    // And the new room continues numbering rather than colliding.
    assert.equal(forked.append(said("first in the fork")).seq, fromSeq);
  });
});

test("forking onto a room that already has history is refused", () => {
  withStores((make, label) => {
    const store = make();
    new Room("a", store).append(said("a"));
    new Room("b", store).append(said("b"));

    // Interleaving two sessions' sequence numbers would be unrecoverable, so
    // this fails loudly rather than producing a subtly corrupt log.
    assert.throws(
      () => store.copyRoom("a", "b", 10),
      /already has history/,
      `${label}: refuses a non-empty target`,
    );
  });
});

test("the forked room replays its copied history on construction", () => {
  withStores((make, label) => {
    const store = make();
    const source = new Room("a", store);
    roomWithOneTurn(source);
    const second = source.append(prompt("p2", "second")).seq;
    source.append(turnStarted("t2", "p2"));
    source.append(checkpoint("c2", "t2", "p2", "e1"));

    store.copyRoom("a", "b", second);

    const forked = new Room("b", store);
    // The first turn's checkpoint came across and is rewindable in the fork;
    // the second one was past the branch point and did not.
    assert.ok(forked.getCheckpoint("c1"), `${label}: prefix checkpoint copied`);
    assert.equal(
      forked.getCheckpoint("c2"),
      undefined,
      `${label}: nothing past the branch point came across`,
    );
  });
});
