import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EventDraft } from "@mpa/protocol";
import { Room } from "./room.js";
import { MemoryEventStore, SqliteEventStore, type EventStore } from "./store.js";

const agent: EventDraft["actor"] = { kind: "agent" };

function message(text: string): EventDraft {
  return {
    actor: agent,
    body: { type: "assistant.message", turnId: "t1", messageId: "m1", text },
  };
}

function withTempDb(fn: (store: SqliteEventStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mpa-store-"));
  const store = new SqliteEventStore(join(dir, "test.db"));
  try {
    fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same contract must hold for both implementations. */
function sharedBehaviour(name: string, make: (fn: (s: EventStore) => void) => void) {
  test(`${name}: round-trips events in sequence order`, () => {
    make((store) => {
      const room = new Room("r", store);
      room.append(message("one"));
      room.append(message("two"));

      const events = store.since("r", -1);
      assert.deepEqual(
        events.map((e) => e.seq),
        [0, 1],
      );
      assert.equal(events[0]!.body.type, "assistant.message");
      assert.deepEqual(events[0]!.actor, { kind: "agent" });
      assert.equal(events[0]!.roomId, "r");
    });
  });

  test(`${name}: since(n) excludes n itself`, () => {
    make((store) => {
      const room = new Room("r", store);
      for (const t of ["a", "b", "c"]) room.append(message(t));
      assert.deepEqual(
        store.since("r", 0).map((e) => e.seq),
        [1, 2],
      );
    });
  });

  test(`${name}: rooms are isolated from one another`, () => {
    make((store) => {
      new Room("alpha", store).append(message("a"));
      const beta = new Room("beta", store);
      beta.append(message("b"));

      assert.equal(store.since("alpha", -1).length, 1);
      assert.equal(store.since("beta", -1).length, 1);
      // Numbering is per-room, so beta starts at zero regardless of alpha.
      assert.equal(beta.latestSeq, 0);
    });
  });

  test(`${name}: a new Room continues the stored sequence`, () => {
    make((store) => {
      const first = new Room("r", store);
      first.append(message("a"));
      first.append(message("b"));
      assert.equal(first.latestSeq, 1);

      // Simulates a relay restart: same store, fresh Room instance.
      const revived = new Room("r", store);
      assert.equal(revived.latestSeq, 1);

      const next = revived.append(message("c"));
      assert.equal(next.seq, 2, "must not collide with pre-restart events");
      assert.equal(store.since("r", -1).length, 3);
    });
  });

  test(`${name}: remembers the agent session id per room`, () => {
    make((store) => {
      const room = new Room("r", store);
      assert.equal(room.agentSessionId, null);

      room.rememberAgentSession("sess-abc");
      assert.equal(room.agentSessionId, "sess-abc");
      // Survives into a fresh Room, which is the point of storing it.
      assert.equal(new Room("r", store).agentSessionId, "sess-abc");

      room.rememberAgentSession("sess-def");
      assert.equal(room.agentSessionId, "sess-def");
    });
  });

  test(`${name}: latestSeq is -1 for an unknown room`, () => {
    make((store) => {
      assert.equal(store.latestSeq("never-used"), -1);
      assert.deepEqual(store.since("never-used", -1), []);
    });
  });
}

sharedBehaviour("memory", (fn) => fn(new MemoryEventStore()));
sharedBehaviour("sqlite", (fn) => withTempDb(fn));

test("sqlite: history survives reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mpa-store-"));
  const path = join(dir, "persist.db");

  try {
    const first = new SqliteEventStore(path);
    const room = new Room("r", first);
    room.append(message("before restart"));
    room.rememberAgentSession("sess-1");
    first.close();

    // A brand new process opening the same file is the real failure mode M1
    // exists to fix.
    const second = new SqliteEventStore(path);
    const revived = new Room("r", second);

    assert.equal(revived.latestSeq, 0);
    assert.equal(revived.agentSessionId, "sess-1");

    const replayed = revived.since(-1);
    assert.equal(replayed.length, 1);
    assert.equal(
      replayed[0]!.body.type === "assistant.message" &&
        replayed[0]!.body.text,
      "before restart",
    );

    assert.equal(revived.append(message("after restart")).seq, 1);
    assert.deepEqual(second.listRooms(), ["r"]);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite: compaction works against stored history", () => {
  withTempDb((store) => {
    const room = new Room("r", store);
    for (const chunk of ["He", "llo"]) {
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
    room.append(message("Hello"));

    assert.equal(room.since(-1).length, 3);
    assert.equal(room.compactedSince(-1).length, 1);
  });
});
