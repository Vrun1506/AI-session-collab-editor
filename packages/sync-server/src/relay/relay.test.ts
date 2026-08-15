import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientMessage, ServerMessage, SessionEvent } from "@mpa/protocol";
import { OpenAuth, SharedTokenAuth } from "../auth.js";
import { MemoryEventStore } from "../store.js";
import type { Conn } from "./conn.js";
import { RelayContext } from "./context.js";
import { dispatch } from "./dispatch.js";
import { onDisconnect } from "./session.js";

/**
 * The relay's message handling.
 *
 * These used to be reachable only by spawning the process and opening real
 * sockets, which is why the largest file in the repo had no tests. `Conn` is
 * the seam that fixed that: a peer is now anything that can be handed a string,
 * so a whole room can be built, driven and inspected in a few lines.
 */

class FakeConn implements Conn {
  readonly sent: ServerMessage[] = [];
  open = true;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  close(): void {
    this.open = false;
  }

  /** Log events this peer received, in order. */
  events(): SessionEvent[] {
    const out: SessionEvent[] = [];
    for (const msg of this.sent) {
      if (msg.type === "welcome") out.push(...msg.backlog);
      if (msg.type === "event") out.push(msg.event);
    }
    return out;
  }

  eventTypes(): string[] {
    return this.events().map((e) => e.body.type);
  }

  bodies<T extends string>(type: T) {
    return this.events()
      .filter((e) => e.body.type === type)
      .map((e) => e.body as Extract<SessionEvent["body"], { type: T }>);
  }

  /** Server messages of one kind — `runPrompt`, `doRewind`, `error`… */
  of<T extends ServerMessage["type"]>(type: T) {
    return this.sent.filter(
      (m): m is Extract<ServerMessage, { type: T }> => m.type === type,
    );
  }

  lastError(): string | undefined {
    return this.of("error").at(-1)?.message;
  }
}

function newContext(auth = new OpenAuth()): RelayContext {
  const ctx = new RelayContext({
    store: new MemoryEventStore(),
    authenticator: auth,
  });
  // A test should not print a session's worth of relay chatter.
  ctx.log = () => {};
  ctx.warn = () => {};
  return ctx;
}

function say(ctx: RelayContext, conn: Conn, msg: ClientMessage): void {
  dispatch(ctx, conn, JSON.stringify(msg));
}

function join(
  ctx: RelayContext,
  name: string,
  role: "editor" | "agent-host" = "editor",
  roomId = "r",
  extra: Record<string, unknown> = {},
): FakeConn {
  const conn = new FakeConn();
  dispatch(
    ctx,
    conn,
    JSON.stringify({
      type: "hello",
      roomId,
      userId: name,
      name,
      role,
      sinceSeq: -1,
      ...extra,
    }),
  );
  return conn;
}

/** Publish a log event as the agent-host would. */
function agentPublishes(
  ctx: RelayContext,
  host: FakeConn,
  body: SessionEvent["body"],
): void {
  say(ctx, host, { type: "publish", draft: { actor: { kind: "agent" }, body } });
}

/** A room with an agent-host, alice driving, and bob along for the ride. */
function room() {
  const ctx = newContext();
  const host = join(ctx, "agent-host", "agent-host", "r", { cwd: "/w" });
  const alice = join(ctx, "alice");
  const bob = join(ctx, "bob");
  return { ctx, host, alice, bob };
}

/** Run one complete turn and return the checkpoint id it recorded. */
function runTurn(
  ctx: RelayContext,
  host: FakeConn,
  driver: FakeConn,
  text: string,
  checkpointId: string,
  turnId: string,
): string {
  say(ctx, driver, { type: "submitPrompt", text });
  const promptId = host.of("runPrompt").at(-1)!.promptId;
  agentPublishes(ctx, host, { type: "turn.started", turnId, promptId });
  agentPublishes(ctx, host, {
    type: "checkpoint.created",
    checkpointId,
    turnId,
    promptId,
    label: text,
    userMessageId: `uuid-${checkpointId}`,
    resumeAt: null,
  });
  agentPublishes(ctx, host, {
    type: "assistant.message",
    turnId,
    messageId: `m-${turnId}`,
    text: "done",
  });
  agentPublishes(ctx, host, {
    type: "turn.completed",
    turnId,
    isError: false,
    usage: {
      costUsd: 0.01,
      sessionTotalCostUsd: 0.01,
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 1,
    },
  });
  return checkpointId;
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

test("the first editor into an undriven room takes the token", () => {
  const ctx = newContext();
  const alice = join(ctx, "alice");
  assert.equal(ctx.getRoom("r").driver?.name, "alice");
  assert.ok(alice.eventTypes().includes("driver.granted"));
});

test("a second editor does not take the token", () => {
  const ctx = newContext();
  join(ctx, "alice");
  join(ctx, "bob");
  assert.equal(ctx.getRoom("r").driver?.name, "alice");
});

test("a welcome carries the backlog, the roster and the session id", () => {
  const { ctx, alice } = room();
  const carol = join(ctx, "carol");
  const welcome = carol.of("welcome")[0]!;
  assert.equal(welcome.you.name, "carol");
  assert.ok(welcome.participants.length >= 3);
  // Alice's arrival is already history by the time carol joins.
  assert.ok(carol.eventTypes().includes("room.joined"));
  assert.ok(alice.events().length > 0);
});

test("only one agent-host may serve a room", () => {
  const ctx = newContext();
  join(ctx, "agent-host", "agent-host");
  const second = join(ctx, "impostor", "agent-host");
  assert.match(second.lastError() ?? "", /already has an agent-host/);
  assert.equal(second.open, false, "the socket is closed, not just refused");
});

test("a returning identity replaces its own stale socket", () => {
  const ctx = newContext();
  const first = join(ctx, "alice");
  const second = join(ctx, "alice");
  // A lingering ghost would corrupt presence and hold the token against a live
  // participant.
  assert.equal(first.open, false);
  assert.equal(second.open, true);
  assert.equal(ctx.getRoom("r").listParticipants().length, 1);
});

test("an unauthorised peer is refused before it can touch room state", () => {
  const ctx = newContext(new SharedTokenAuth("the-real-token"));
  const conn = join(ctx, "mallory", "editor", "r", { token: "wrong" });
  assert.match(conn.lastError() ?? "", /not authorised/);
  assert.equal(conn.open, false);
  // Crucially: no room was created and nobody appears in presence.
  assert.equal(ctx.getRoom("r").listParticipants().length, 0);
  assert.equal(ctx.getRoom("r").size, 0);
});

test("anything before hello is refused", () => {
  const ctx = newContext();
  const conn = new FakeConn();
  say(ctx, conn, { type: "submitPrompt", text: "hello?" });
  assert.match(conn.lastError() ?? "", /send hello first/);
});

test("a malformed frame is refused rather than taking the relay down", () => {
  const ctx = newContext();
  const conn = new FakeConn();
  dispatch(ctx, conn, "{not json");
  assert.match(conn.lastError() ?? "", /malformed frame/);
});

// ---------------------------------------------------------------------------
// Prompts and the suggestion queue
// ---------------------------------------------------------------------------

test("the driver's text becomes a prompt and reaches the agent", () => {
  const { ctx, host, alice } = room();
  say(ctx, alice, { type: "submitPrompt", text: "do the thing" });

  assert.equal(host.of("runPrompt").length, 1);
  assert.equal(host.of("runPrompt")[0]!.text, "do the thing");
  assert.equal(alice.bodies("prompt.submitted").length, 1);
});

test("a non-driver's text becomes a suggestion, not a prompt", () => {
  const { ctx, host, bob } = room();
  say(ctx, bob, { type: "submitPrompt", text: "my idea" });

  // The client sent the same message either way; the relay decided.
  assert.equal(host.of("runPrompt").length, 0);
  assert.equal(bob.bodies("suggestion.queued").length, 1);
});

test("a promoted suggestion is attributed to its author, not the promoter", () => {
  const { ctx, host, alice, bob } = room();
  say(ctx, bob, { type: "submitPrompt", text: "bob's idea" });
  const suggestionId = bob.bodies("suggestion.queued")[0]!.suggestionId;

  say(ctx, alice, { type: "promoteSuggestion", suggestionId });

  const prompt = alice.events().find((e) => e.body.type === "prompt.submitted")!;
  // The log credits whoever had the idea; `promotedBy` records who let it run.
  assert.equal(
    prompt.actor.kind === "user" ? prompt.actor.name : null,
    "bob",
  );
  assert.equal(
    (prompt.body as { promotedBy?: { name: string } }).promotedBy?.name,
    "alice",
  );
});

test("only the driver can promote or dismiss", () => {
  const { ctx, alice, bob } = room();
  say(ctx, bob, { type: "submitPrompt", text: "idea" });
  const suggestionId = bob.bodies("suggestion.queued")[0]!.suggestionId;

  say(ctx, bob, { type: "promoteSuggestion", suggestionId });
  assert.match(bob.lastError() ?? "", /only the driver/);
  say(ctx, bob, { type: "dismissSuggestion", suggestionId });
  assert.match(bob.lastError() ?? "", /only the driver/);
  assert.ok(ctx.getRoom("r").getSuggestion(suggestionId), "still queued");

  say(ctx, alice, { type: "dismissSuggestion", suggestionId });
  assert.equal(ctx.getRoom("r").getSuggestion(suggestionId), undefined);
});

test("a prompt with no agent-host is refused rather than lost", () => {
  const ctx = newContext();
  const alice = join(ctx, "alice");
  say(ctx, alice, { type: "submitPrompt", text: "anyone there?" });
  assert.match(alice.lastError() ?? "", /no agent-host/);
});

test("anyone may interrupt, driver or not", () => {
  const { ctx, host, bob } = room();
  say(ctx, bob, { type: "interrupt" });
  // A deadlocked room is worse than a cancelled turn.
  assert.equal(host.of("doInterrupt").length, 1);
  assert.equal(host.of("doInterrupt")[0]!.byUserId, "bob");
});

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

test("a tool call asks the room and the decision reaches the agent", () => {
  const { ctx, host, alice } = room();
  say(ctx, host, {
    type: "requestApproval",
    requestId: "a1",
    toolName: "Bash",
    input: { command: "ls" },
    turnId: null,
  });
  assert.equal(alice.bodies("tool.approval.requested").length, 1);

  say(ctx, alice, { type: "decideApproval", requestId: "a1", allow: true });
  assert.equal(host.of("toolDecision").length, 1);
  assert.equal(host.of("toolDecision")[0]!.allow, true);
});

test("re-asking after a reconnect is idempotent and replays the decision", () => {
  const { ctx, host, alice } = room();
  const ask = () =>
    say(ctx, host, {
      type: "requestApproval",
      requestId: "a1",
      toolName: "Bash",
      input: { command: "ls" },
      turnId: null,
    });

  ask();
  say(ctx, alice, { type: "decideApproval", requestId: "a1", allow: false });
  ask();

  // Logged once; answered twice, so a host that reconnected mid-gate is not
  // left suspended forever.
  assert.equal(alice.bodies("tool.approval.requested").length, 1);
  assert.equal(host.of("toolDecision").length, 2);
});

test("only the driver decides", () => {
  const { ctx, host, bob } = room();
  say(ctx, host, {
    type: "requestApproval",
    requestId: "a1",
    toolName: "Bash",
    input: {},
    turnId: null,
  });
  say(ctx, bob, { type: "decideApproval", requestId: "a1", allow: true });
  assert.match(bob.lastError() ?? "", /only the driver/);
  assert.equal(host.of("toolDecision").length, 0);
});

test("a write to a file someone is still editing is refused before anyone is asked", () => {
  const { ctx, host, alice, bob } = room();
  say(ctx, bob, { type: "bufferState", dirty: ["/w/login.ts"] });

  say(ctx, host, {
    type: "requestApproval",
    requestId: "a1",
    toolName: "Write",
    input: { file_path: "/w/login.ts" },
    turnId: null,
  });

  // Decided in the same tick as the request, so it is not a race an eager
  // approver can win.
  const decision = alice.bodies("tool.approval.decided")[0];
  assert.ok(decision);
  assert.equal(decision.allow, false);
  assert.match(decision.reason ?? "", /bob has unsaved changes/);
  // The room still sees what the agent wanted to do.
  assert.equal(alice.bodies("tool.approval.requested").length, 1);
});

test("only the agent-host may request approval", () => {
  const { ctx, alice } = room();
  say(ctx, alice, {
    type: "requestApproval",
    requestId: "a1",
    toolName: "Bash",
    input: {},
    turnId: null,
  });
  assert.match(alice.lastError() ?? "", /only the agent-host/);
});

// ---------------------------------------------------------------------------
// Checkpoints, rewind and fork
// ---------------------------------------------------------------------------

test("a rewind sends the agent both SDK anchors and the log range", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "make it blue", "cp1", "t1");

  say(ctx, alice, { type: "rewindTo", checkpointId: "cp1" });

  const rewind = host.of("doRewind")[0];
  assert.ok(rewind);
  assert.equal(rewind.userMessageId, "uuid-cp1");
  assert.equal(rewind.requestedBy.name, "alice");
  // The range starts at the prompt, so the turn is taken back whole.
  const promptSeq = alice
    .events()
    .find((e) => e.body.type === "prompt.submitted")!.seq;
  assert.equal(rewind.fromSeq, promptSeq);
});

test("a rewind is refused mid-turn", () => {
  const { ctx, host, alice } = room();
  say(ctx, alice, { type: "submitPrompt", text: "go" });
  const promptId = host.of("runPrompt")[0]!.promptId;
  agentPublishes(ctx, host, { type: "turn.started", turnId: "t1", promptId });
  agentPublishes(ctx, host, {
    type: "checkpoint.created",
    checkpointId: "cp1",
    turnId: "t1",
    promptId,
    label: "go",
    userMessageId: "uuid-cp1",
    resumeAt: null,
  });

  say(ctx, alice, { type: "rewindTo", checkpointId: "cp1" });

  // Restoring files underneath a running agent races its own writes.
  assert.match(alice.lastError() ?? "", /mid-turn/);
  assert.equal(host.of("doRewind").length, 0);
});

test("only the driver can rewind or fork", () => {
  const { ctx, host, alice, bob } = room();
  runTurn(ctx, host, alice, "go", "cp1", "t1");

  say(ctx, bob, { type: "rewindTo", checkpointId: "cp1" });
  assert.match(bob.lastError() ?? "", /only the driver/);
  say(ctx, bob, { type: "forkRoom", checkpointId: "cp1", toRoomId: "alt" });
  assert.match(bob.lastError() ?? "", /only the driver/);
  assert.equal(host.of("doRewind").length, 0);
  assert.equal(host.of("doFork").length, 0);
});

test("an unknown checkpoint is refused", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "go", "cp1", "t1");
  say(ctx, alice, { type: "rewindTo", checkpointId: "nope" });
  assert.match(alice.lastError() ?? "", /no longer available/);
  assert.equal(host.of("doRewind").length, 0);
});

test("a late joiner is never sent a turn that was rewound", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "make it blue", "cp1", "t1");
  const fromSeq = alice
    .events()
    .find((e) => e.body.type === "prompt.submitted")!.seq;

  say(ctx, alice, { type: "rewindTo", checkpointId: "cp1" });
  agentPublishes(ctx, host, {
    type: "checkpoint.restored",
    checkpointId: "cp1",
    label: "make it blue",
    fromSeq,
    filesChanged: ["/w/a.ts"],
    insertions: 0,
    deletions: 4,
    skippedLinks: 0,
    sessionId: "session-2",
  });

  const carol = join(ctx, "carol");
  assert.ok(!carol.eventTypes().includes("prompt.submitted"));
  assert.ok(!carol.eventTypes().includes("assistant.message"));
  // But the rewind itself is still on the record.
  assert.ok(carol.eventTypes().includes("checkpoint.restored"));
});

test("a rewind records the forked session as the one to resume from", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "go", "cp1", "t1");
  agentPublishes(ctx, host, {
    type: "checkpoint.restored",
    checkpointId: "cp1",
    label: "go",
    fromSeq: 0,
    filesChanged: [],
    insertions: 0,
    deletions: 0,
    skippedLinks: 0,
    sessionId: "session-after-rewind",
  });
  // A crash before the fork's own `init` must not resume the abandoned branch.
  assert.equal(ctx.getRoom("r").agentSessionId, "session-after-rewind");
});

test("a fork copies the prefix and announces itself in both rooms", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "try it green", "cp1", "t1");

  say(ctx, alice, { type: "forkRoom", checkpointId: "cp1", toRoomId: "alt" });
  assert.equal(host.of("doFork").length, 1);

  say(ctx, host, {
    type: "forkedSession",
    checkpointId: "cp1",
    toRoomId: "alt",
    sessionId: "session-forked",
  });

  const announced = alice.bodies("room.forked")[0];
  assert.ok(announced);
  assert.equal(announced.toRoomId, "alt");
  assert.equal(announced.sessionId, "session-forked");

  // The new room holds the prefix and opens with its own fork marker.
  const forked = ctx.getRoom("alt");
  assert.equal(forked.agentSessionId, "session-forked");
  const types = forked.since(-1).map((e) => e.body.type);
  assert.ok(types.includes("room.forked"));
  assert.ok(
    !forked
      .since(-1)
      .some(
        (e) =>
          e.body.type === "prompt.submitted" && e.body.text === "try it green",
      ),
    "the branched turn did not come across",
  );
});

test("forking onto an existing room is refused", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "go", "cp1", "t1");
  join(ctx, "dave", "editor", "occupied");

  say(ctx, alice, {
    type: "forkRoom",
    checkpointId: "cp1",
    toRoomId: "occupied",
  });
  assert.match(alice.lastError() ?? "", /already exists/);
  assert.equal(host.of("doFork").length, 0);
});

test("a room cannot be forked onto itself", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "go", "cp1", "t1");
  say(ctx, alice, { type: "forkRoom", checkpointId: "cp1", toRoomId: "r" });
  assert.match(alice.lastError() ?? "", /onto itself/);
});

test("a fork the agent could not carry out is reported, not silently dropped", () => {
  const { ctx, host, alice } = room();
  runTurn(ctx, host, alice, "go", "cp1", "t1");
  say(ctx, alice, { type: "forkRoom", checkpointId: "cp1", toRoomId: "alt" });

  say(ctx, host, {
    type: "forkedSession",
    checkpointId: "cp1",
    toRoomId: "alt",
    sessionId: null,
    error: "session file is gone",
  });

  const failed = alice.bodies("checkpoint.failed")[0];
  assert.ok(failed);
  assert.match(failed.reason, /session file is gone/);
});

test("the audit export comes back as markdown for the asking peer only", () => {
  const { ctx, host, alice, bob } = room();
  runTurn(ctx, host, alice, "do the thing", "cp1", "t1");

  say(ctx, bob, { type: "requestAudit" });

  const report = bob.of("auditReport")[0];
  assert.ok(report);
  assert.equal(report.roomId, "r");
  assert.match(report.markdown, /Session audit/);
  assert.match(report.markdown, /do the thing/);
  assert.equal(alice.of("auditReport").length, 0, "not broadcast");
});

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

test("a lone survivor is handed the token rather than made to ask", () => {
  const { ctx, alice, bob } = room();
  assert.equal(ctx.getRoom("r").driver?.name, "alice");

  onDisconnect(ctx, alice);

  assert.equal(ctx.getRoom("r").driver?.name, "bob");
  assert.ok(bob.eventTypes().includes("room.left"));
});

test("leaving releases the unsaved buffers that peer was holding", () => {
  const { ctx, host, alice, bob } = room();
  say(ctx, bob, { type: "bufferState", dirty: ["/w/login.ts"] });
  onDisconnect(ctx, bob);

  // Bob's claim left with him, so the write is no longer blocked on his behalf.
  say(ctx, host, {
    type: "requestApproval",
    requestId: "a1",
    toolName: "Write",
    input: { file_path: "/w/login.ts" },
    turnId: null,
  });
  assert.equal(alice.bodies("tool.approval.decided").length, 0);
});

test("a closed connection stops receiving, without breaking the fan-out", () => {
  const { ctx, host, alice, bob } = room();
  bob.close();

  runTurn(ctx, host, alice, "go", "cp1", "t1");

  // Alice still got everything; bob's socket simply dropped its share.
  assert.ok(alice.bodies("prompt.submitted").length > 0);
  assert.equal(bob.bodies("prompt.submitted").length, 0);
});
