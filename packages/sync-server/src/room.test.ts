import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventDraft } from "@mpa/protocol";
import { Room } from "./room.js";

const agent: EventDraft["actor"] = { kind: "agent" };

function draft(text: string): EventDraft {
  return {
    actor: agent,
    body: { type: "assistant.message", turnId: "t1", messageId: "m1", text },
  };
}

test("append assigns monotonic seq starting at zero", () => {
  const room = new Room("r");
  assert.equal(room.append(draft("a")).seq, 0);
  assert.equal(room.append(draft("b")).seq, 1);
  assert.equal(room.append(draft("c")).seq, 2);
  assert.equal(room.latestSeq, 2);
});

test("since(-1) replays the entire history", () => {
  const room = new Room("r");
  room.append(draft("a"));
  room.append(draft("b"));

  const replay = room.since(-1);
  assert.equal(replay.length, 2);
  assert.deepEqual(
    replay.map((e) => e.seq),
    [0, 1],
  );
});

test("since(n) returns events strictly after n", () => {
  const room = new Room("r");
  for (const t of ["a", "b", "c", "d"]) room.append(draft(t));

  // A client that has folded up to seq 1 must receive exactly 2 and 3 —
  // re-delivering 1 would double-apply a delta.
  const tail = room.since(1);
  assert.deepEqual(
    tail.map((e) => e.seq),
    [2, 3],
  );
});

test("since beyond the head yields nothing", () => {
  const room = new Room("r");
  room.append(draft("a"));
  assert.deepEqual(room.since(Number.MAX_SAFE_INTEGER), []);
  assert.deepEqual(room.since(0), []);
});

test("an empty room has latestSeq -1 so a first join replays nothing", () => {
  const room = new Room("r");
  assert.equal(room.latestSeq, -1);
  assert.deepEqual(room.since(-1), []);
});

test("events carry the room id and the publisher's actor", () => {
  const room = new Room("room-42");
  const event = room.append({
    actor: { kind: "user", userId: "u1", name: "Alice" },
    body: { type: "prompt.submitted", promptId: "p1", text: "hi" },
  });
  assert.equal(event.roomId, "room-42");
  assert.deepEqual(event.actor, { kind: "user", userId: "u1", name: "Alice" });
  assert.ok(event.ts > 0);
});

test("compaction drops deltas superseded by a final message", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: { type: "turn.started", turnId: "t1", promptId: "p1" },
  });
  for (const chunk of ["He", "llo", " world"]) {
    room.append({
      actor: agent,
      body: {
        type: "assistant.delta",
        turnId: "t1",
        messageId: "m1",
        text: chunk,
      },
    });
  }
  room.append({
    actor: agent,
    body: {
      type: "assistant.message",
      turnId: "t1",
      messageId: "m1",
      text: "Hello world",
    },
  });

  const full = room.since(-1);
  const compact = room.compactedSince(-1);

  assert.equal(full.length, 5);
  // turn.started + the authoritative message; the three deltas are redundant.
  assert.equal(compact.length, 2);
  assert.deepEqual(
    compact.map((e) => e.body.type),
    ["turn.started", "assistant.message"],
  );
});

test("compaction keeps deltas of a message that is still streaming", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: {
      type: "assistant.delta",
      turnId: "t1",
      messageId: "m1",
      text: "partial",
    },
  });

  // Joining mid-turn must still show text in flight.
  assert.equal(room.compactedSince(-1).length, 1);
});

test("compaction preserves seq so client dedupe still works", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: { type: "assistant.delta", turnId: "t", messageId: "m", text: "a" },
  });
  room.append({
    actor: agent,
    body: { type: "assistant.message", turnId: "t", messageId: "m", text: "a" },
  });

  const compact = room.compactedSince(-1);
  assert.deepEqual(
    compact.map((e) => e.seq),
    [1],
  );
  // Gaps are expected; the surviving events keep their original numbering.
  assert.equal(room.latestSeq, 1);
});

test("compaction only drops deltas for the finalized message", () => {
  const room = new Room("r");
  const delta = (messageId: string, text: string): EventDraft => ({
    actor: agent,
    body: { type: "assistant.delta", turnId: "t", messageId, text },
  });
  room.append(delta("m1", "x"));
  room.append(delta("m2", "y"));
  room.append({
    actor: agent,
    body: { type: "assistant.message", turnId: "t", messageId: "m1", text: "x" },
  });

  const compact = room.compactedSince(-1);
  // m2 is still streaming, so its delta survives.
  assert.deepEqual(
    compact.map((e) => e.body.type),
    ["assistant.delta", "assistant.message"],
  );
});

test("tracks participants and detects a single agent-host", () => {
  const room = new Room("r");
  assert.equal(room.hasAgentHost(), false);
  assert.equal(room.isEmpty(), true);

  room.addParticipant({ userId: "u1", name: "Alice", role: "editor" });
  room.addParticipant({ userId: "agent-host", name: "Agent", role: "agent-host" });

  assert.equal(room.hasAgentHost(), true);
  assert.equal(room.listParticipants().length, 2);

  room.removeParticipant("agent-host");
  assert.equal(room.hasAgentHost(), false);
  assert.equal(room.isEmpty(), false);
});

test("the log survives every participant leaving", () => {
  const room = new Room("r");
  room.addParticipant({ userId: "u1", name: "Alice", role: "editor" });
  room.append(draft("a"));
  room.removeParticipant("u1");

  // A room that empties out is still resumable — the history is the asset.
  assert.equal(room.isEmpty(), true);
  assert.equal(room.since(-1).length, 1);
});
