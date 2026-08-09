import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Identity } from "@mpa/protocol";
import { decideAfterLeave, decideDriverRequest } from "./policy.js";
import { Room } from "./room.js";
import { SqliteEventStore } from "./store.js";

const alice: Identity = { userId: "u-alice", name: "Alice" };
const bob: Identity = { userId: "u-bob", name: "Bob" };
const carol: Identity = { userId: "u-carol", name: "Carol" };

const IDLE = 120_000;

/** A room with the given people connected, nobody driving yet. */
function roomWith(...people: Identity[]): Room {
  const room = new Room("r");
  for (const p of people) {
    room.addParticipant({ userId: p.userId, name: p.name, role: "editor" });
  }
  return room;
}

function grant(room: Room, to: Identity, from: Identity | null = null): void {
  room.append({
    actor: { kind: "system" },
    body: {
      type: "driver.granted",
      userId: to.userId,
      name: to.name,
      reason: from ? "handoff" : "initial",
      from,
    },
  });
}

function request(room: Room, who: Identity): void {
  room.append({
    actor: { kind: "user", ...who },
    body: { type: "driver.requested", userId: who.userId, name: who.name },
  });
}

// ---------------------------------------------------------------------------
// Driver requests
// ---------------------------------------------------------------------------

test("an undriven room grants the token to whoever asks", () => {
  const room = roomWith(alice);
  assert.deepEqual(decideDriverRequest(room, alice, IDLE), {
    kind: "grant",
    to: alice,
    reason: "initial",
    from: null,
  });
});

test("a request from an active driver waits on them", () => {
  const room = roomWith(alice, bob);
  grant(room, alice);

  // This is the case the whole token exists for: Bob does not get to take it.
  assert.deepEqual(decideDriverRequest(room, bob, IDLE), {
    kind: "queue",
    who: bob,
  });
});

test("the driver asking for the token they already hold is a no-op", () => {
  const room = roomWith(alice);
  grant(room, alice);
  assert.deepEqual(decideDriverRequest(room, alice, IDLE), { kind: "none" });
});

test("a disconnected driver cannot hold the room hostage", () => {
  const room = roomWith(alice, bob);
  grant(room, alice);
  room.removeParticipant(alice.userId);

  assert.deepEqual(decideDriverRequest(room, bob, IDLE), {
    kind: "grant",
    to: bob,
    reason: "offline",
    from: alice,
  });
});

test("an idle driver loses the token to someone who is actually working", () => {
  const room = roomWith(alice, bob);
  grant(room, alice);

  // Still connected, just gone quiet. A negative threshold means "any gap
  // counts", which keeps the test off the clock.
  assert.deepEqual(decideDriverRequest(room, bob, -1), {
    kind: "grant",
    to: bob,
    reason: "idle",
    from: alice,
  });
});

test("marking the driver active defends the token again", () => {
  const room = roomWith(alice, bob);
  grant(room, alice);
  room.markDriverActive();

  assert.equal(decideDriverRequest(room, bob, IDLE).kind, "queue");
});

// ---------------------------------------------------------------------------
// Disconnects
// ---------------------------------------------------------------------------

test("a non-driver leaving changes nothing", () => {
  const room = roomWith(alice, bob);
  grant(room, alice);
  room.removeParticipant(bob.userId);

  assert.deepEqual(decideAfterLeave(room, bob), { kind: "none" });
});

test("the driver leaving hands the token to whoever was waiting", () => {
  const room = roomWith(alice, bob, carol);
  grant(room, alice);
  request(room, bob);
  room.removeParticipant(alice.userId);

  assert.deepEqual(decideAfterLeave(room, alice), {
    kind: "grant",
    to: bob,
    reason: "offline",
    from: alice,
  });
});

test("a lone survivor is given the token without having to ask", () => {
  const room = roomWith(alice, bob);
  grant(room, alice);
  room.removeParticipant(alice.userId);

  assert.deepEqual(decideAfterLeave(room, alice), {
    kind: "grant",
    to: bob,
    reason: "offline",
    from: alice,
  });
});

test("with several left and nobody waiting, the token stays put", () => {
  const room = roomWith(alice, bob, carol);
  grant(room, alice);
  room.removeParticipant(alice.userId);

  // Alice may be back in ten seconds; anyone who needs it can take it under
  // the offline rule rather than having it reassigned arbitrarily.
  assert.deepEqual(decideAfterLeave(room, alice), { kind: "none" });
  assert.equal(room.driver?.userId, alice.userId);
});

test("a queued request from someone who also left is skipped", () => {
  const room = roomWith(alice, bob, carol);
  grant(room, alice);
  request(room, bob);
  room.removeParticipant(bob.userId);
  room.removeParticipant(alice.userId);

  // Only carol is connected, and she never asked — but she is alone.
  assert.deepEqual(decideAfterLeave(room, alice), {
    kind: "grant",
    to: carol,
    reason: "offline",
    from: alice,
  });
});

// ---------------------------------------------------------------------------
// The token is folded state, so it outlives the process
// ---------------------------------------------------------------------------

test("the driver token survives a relay restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "mpa-policy-"));
  try {
    const path = join(dir, "policy.db");
    const first = new SqliteEventStore(path);
    const room = new Room("r", first);
    grant(room, alice);
    request(room, bob);
    first.close();

    const second = new SqliteEventStore(path);
    const revived = new Room("r", second);
    assert.deepEqual(revived.driver, alice);
    assert.deepEqual(revived.pendingDriverRequests(), [bob]);

    // Nobody is connected after a restart, so the offline rule applies and the
    // room is immediately usable by whoever turns up first.
    revived.addParticipant({ userId: bob.userId, name: bob.name, role: "editor" });
    assert.deepEqual(decideDriverRequest(revived, bob, 120_000), {
      kind: "grant",
      to: bob,
      reason: "offline",
      from: alice,
    });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
