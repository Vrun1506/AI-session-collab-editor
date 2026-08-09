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

// ---------------------------------------------------------------------------
// Folded state: the queue and the approval gate are derived, never stored
// ---------------------------------------------------------------------------

const bob: EventDraft["actor"] = { kind: "user", userId: "u-bob", name: "Bob" };

function queueSuggestion(room: Room, suggestionId: string, text: string): void {
  room.append({ actor: bob, body: { type: "suggestion.queued", suggestionId, text } });
}

test("suggestions queue in order and carry their author", () => {
  const room = new Room("r");
  queueSuggestion(room, "s1", "use zod, not manual checks");
  queueSuggestion(room, "s2", "and add a test");

  const queued = room.listSuggestions();
  assert.deepEqual(
    queued.map((s) => s.text),
    ["use zod, not manual checks", "and add a test"],
  );
  // Attribution is the point: promotion later credits Bob, not the driver.
  assert.deepEqual(queued[0]!.author, { userId: "u-bob", name: "Bob" });
});

test("promoting or dismissing takes a suggestion out of the queue", () => {
  const room = new Room("r");
  queueSuggestion(room, "s1", "one");
  queueSuggestion(room, "s2", "two");

  room.append({
    actor: agent,
    body: { type: "suggestion.promoted", suggestionId: "s1", promptId: "p1" },
  });
  room.append({
    actor: bob,
    body: { type: "suggestion.dismissed", suggestionId: "s2" },
  });

  assert.deepEqual(room.listSuggestions(), []);
  assert.equal(room.getSuggestion("s1"), undefined);
});

test("an approval stays pending until it is decided", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: {
      type: "tool.approval.requested",
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "npm test" },
      turnId: "t1",
    },
  });

  assert.equal(room.listPendingApprovals().length, 1);
  assert.equal(room.getApproval("req-1")?.decision, null);

  room.append({
    actor: bob,
    body: { type: "tool.approval.decided", requestId: "req-1", allow: true },
  });

  assert.deepEqual(room.listPendingApprovals(), []);
  assert.deepEqual(room.getApproval("req-1")?.decision, {
    allow: true,
    reason: undefined,
  });
});

test("re-requesting the same approval does not duplicate it", () => {
  const room = new Room("r");
  const ask: EventDraft = {
    actor: agent,
    body: {
      type: "tool.approval.requested",
      requestId: "req-1",
      toolName: "Bash",
      input: { command: "ls" },
      turnId: null,
    },
  };
  room.append(ask);
  room.append(ask);

  // The agent-host re-asks after reconnecting; the room must not grow a second
  // pending gate for a single suspended tool call.
  assert.equal(room.listPendingApprovals().length, 1);
});

test("the driver token folds from the log", () => {
  const room = new Room("r");
  assert.equal(room.driver, null);

  room.append({
    actor: { kind: "system" },
    body: {
      type: "driver.granted",
      userId: "u-alice",
      name: "Alice",
      reason: "initial",
      from: null,
    },
  });
  assert.equal(room.isDriver("u-alice"), true);
  assert.equal(room.isDriver("u-bob"), false);

  room.append({
    actor: bob,
    body: { type: "driver.requested", userId: "u-bob", name: "Bob" },
  });
  assert.deepEqual(room.pendingDriverRequests(), [
    { userId: "u-bob", name: "Bob" },
  ]);

  room.append({
    actor: { kind: "system" },
    body: {
      type: "driver.granted",
      userId: "u-bob",
      name: "Bob",
      reason: "handoff",
      from: { userId: "u-alice", name: "Alice" },
    },
  });
  // Being granted the token clears the request that asked for it.
  assert.equal(room.isDriver("u-bob"), true);
  assert.deepEqual(room.pendingDriverRequests(), []);

  room.append({
    actor: bob,
    body: { type: "driver.released", userId: "u-bob", name: "Bob" },
  });
  assert.equal(room.driver, null);
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
