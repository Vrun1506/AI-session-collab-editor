import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventBody } from "@mpa/protocol";
import { TurnTranslator } from "./translate.js";

/**
 * The SDK-message-to-log-event fold.
 *
 * Pure, and therefore cheap to pin down — which matters more since M4, because
 * this is where a checkpoint learns the SDK message uuid it will later be
 * rewound to. Get that wrong and a rewind aims at the wrong point in the
 * conversation, which no test further downstream would catch.
 *
 * The SDK message types are wide and mostly irrelevant here, so fixtures are
 * built as the minimum each branch reads and cast at the boundary.
 */

const msg = (m: unknown): SDKMessage => m as SDKMessage;

const init = (sessionId = "s1") =>
  msg({ type: "system", subtype: "init", session_id: sessionId });

/** The prompt coming back through the stream, which is what anchors a turn. */
const promptEcho = (uuid: string, content: unknown = "do the thing") =>
  msg({ type: "user", uuid, message: { role: "user", content } });

const assistantSaid = (uuid: string, text: string, id = "m1") =>
  msg({
    type: "assistant",
    uuid,
    message: { id, content: [{ type: "text", text }] },
  });

const assistantCalled = (uuid: string, name: string, input: unknown, id = "m1") =>
  msg({
    type: "assistant",
    uuid,
    message: {
      id,
      content: [{ type: "tool_use", id: "tu1", name, input }],
    },
  });

const toolResult = (uuid: string, content: string, isError = false) =>
  msg({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", is_error: isError, content },
      ],
    },
  });

const result = (totalCost: number) =>
  msg({
    type: "result",
    total_cost_usd: totalCost,
    duration_ms: 100,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 20 },
  });

const delta = (text: string) =>
  msg({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

const messageStart = (id: string) =>
  msg({ type: "stream_event", event: { type: "message_start", message: { id } } });

function only<T extends EventBody["type"]>(
  bodies: EventBody[],
  type: T,
): Extract<EventBody, { type: T }>[] {
  return bodies.filter(
    (b): b is Extract<EventBody, { type: T }> => b.type === type,
  );
}

// ---------------------------------------------------------------------------
// The turn cycle
// ---------------------------------------------------------------------------

test("init reports the session id so the room can resume it later", () => {
  const t = new TurnTranslator();
  const out = t.translate(init("session-abc"));
  const status = only(out, "agent.status")[0];
  assert.equal(status?.state, "ready");
  assert.equal(status?.sessionId, "session-abc");
});

test("deltas are anchored to the message they belong to", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  t.translate(messageStart("msg-7"));
  const out = [...t.translate(delta("Hel")), ...t.translate(delta("lo"))];

  const deltas = only(out, "assistant.delta");
  assert.deepEqual(
    deltas.map((d) => d.text),
    ["Hel", "lo"],
  );
  // Several messages can share a turn, so clients need this to append into the
  // right bubble rather than concatenating everything.
  assert.ok(deltas.every((d) => d.messageId === "msg-7"));
  assert.ok(deltas.every((d) => d.turnId === "t1"));
});

test("the authoritative message and its tool calls both come through", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  const said = t.translate(assistantSaid("a1", "Here you go"));
  assert.equal(only(said, "assistant.message")[0]?.text, "Here you go");

  const called = t.translate(assistantCalled("a2", "Bash", { command: "ls" }));
  const tool = only(called, "tool.requested")[0];
  assert.equal(tool?.name, "Bash");
  assert.deepEqual(tool?.input, { command: "ls" });
});

test("an empty assistant message is not published as one", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  // A message carrying only a tool_use has no text worth a bubble.
  const out = t.translate(assistantCalled("a1", "Read", { file_path: "/x" }));
  assert.equal(only(out, "assistant.message").length, 0);
  assert.equal(only(out, "tool.requested").length, 1);
});

test("tool results arrive as user messages and are reported as results", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  t.translate(promptEcho("u1"));
  const out = t.translate(toolResult("r1", "total 4", true));

  const res = only(out, "tool.result")[0];
  assert.equal(res?.toolUseId, "tu1");
  assert.equal(res?.isError, true);
  assert.match(res?.preview ?? "", /total 4/);
});

test("a long tool result is truncated rather than sent whole", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  t.translate(promptEcho("u1"));
  const out = t.translate(toolResult("r1", "x".repeat(5_000)));
  const preview = only(out, "tool.result")[0]!.preview;
  assert.ok(preview.length < 1_000);
  assert.match(preview, /chars\)$/);
});

test("cost is reported per turn, not as the session running total", () => {
  const t = new TurnTranslator();

  t.startTurn("t1");
  const first = only(t.translate(result(0.10)), "turn.completed")[0]!;
  assert.equal(first.usage.costUsd, 0.10);

  t.startTurn("t2");
  const second = only(t.translate(result(0.25)), "turn.completed")[0]!;
  // `total_cost_usd` is cumulative across a streaming-input session, so the
  // per-turn figure is the delta — otherwise every turn re-bills the last.
  assert.ok(Math.abs(second.usage.costUsd! - 0.15) < 1e-9);
  assert.equal(second.usage.sessionTotalCostUsd, 0.25);
});

test("a completed turn closes, so later output is not attributed to it", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  assert.equal(t.openTurnId, "t1");
  t.translate(result(0.01));
  assert.equal(t.openTurnId, null);
});

// ---------------------------------------------------------------------------
// Checkpoint anchoring (M4)
// ---------------------------------------------------------------------------

test("the prompt echo becomes the turn's checkpoint", () => {
  const t = new TurnTranslator();
  t.startTurn("t1", "p1", "make it blue");
  const out = t.translate(promptEcho("uuid-prompt-1"));

  const cp = only(out, "checkpoint.created")[0];
  assert.ok(cp, "a checkpoint was recorded");
  assert.equal(cp.userMessageId, "uuid-prompt-1");
  assert.equal(cp.turnId, "t1");
  assert.equal(cp.promptId, "p1");
  assert.equal(cp.label, "make it blue");
  // Nothing preceded this turn, so a rewind to it starts a clean session.
  assert.equal(cp.resumeAt, null);
});

test("resumeAt names the last entry before the turn, not inside it", () => {
  const t = new TurnTranslator();

  t.startTurn("t1", "p1", "first");
  t.translate(promptEcho("u1"));
  t.translate(assistantSaid("a1", "done"));
  t.translate(result(0.01));

  t.startTurn("t2", "p2", "second");
  const cp = only(t.translate(promptEcho("u2")), "checkpoint.created")[0]!;

  // Rewinding the second turn must keep the first one whole, so the fork point
  // is the first turn's last entry.
  assert.equal(cp.resumeAt, "a1");
  assert.equal(cp.userMessageId, "u2");
});

test("a tool result does not open a second checkpoint in the same turn", () => {
  const t = new TurnTranslator();
  t.startTurn("t1", "p1", "go");

  const fromPrompt = t.translate(promptEcho("u1"));
  const fromResult = t.translate(toolResult("r1", "ok"));

  // Tool results are user messages too — anchoring to one would put the
  // checkpoint in the middle of the turn it is meant to undo.
  assert.equal(only(fromPrompt, "checkpoint.created").length, 1);
  assert.equal(only(fromResult, "checkpoint.created").length, 0);
});

test("a user message with no uuid cannot anchor a checkpoint", () => {
  const t = new TurnTranslator();
  t.startTurn("t1", "p1", "go");
  const out = t.translate(
    msg({ type: "user", message: { role: "user", content: "no uuid here" } }),
  );
  // Better no checkpoint than one aimed at nothing — probe-rewind.mjs is what
  // verifies the uuid is actually there in practice.
  assert.equal(only(out, "checkpoint.created").length, 0);
});

test("only the first prompt echo of a turn anchors it", () => {
  const t = new TurnTranslator();
  t.startTurn("t1", "p1", "go");
  const first = t.translate(promptEcho("u1"));
  const second = t.translate(promptEcho("u2", "queued follow-up"));

  assert.equal(only(first, "checkpoint.created").length, 1);
  assert.equal(only(second, "checkpoint.created").length, 0);
});

test("a rewind resets the fork point and the cost baseline together", () => {
  const t = new TurnTranslator();

  t.startTurn("t1", "p1", "first");
  t.translate(promptEcho("u1"));
  t.translate(assistantSaid("a1", "done"));
  t.translate(result(0.40));

  // The session was forked at u1 and everything after it is gone.
  t.resetTo("u1");

  t.startTurn("t2", "p2", "second attempt");
  const cp = only(t.translate(promptEcho("u2")), "checkpoint.created")[0]!;
  assert.equal(cp.resumeAt, "u1", "anchors into the forked transcript");

  // The fork is a new session, so its running total restarts at zero. Keeping
  // the old baseline would make the next turn look free.
  const done = only(t.translate(result(0.05)), "turn.completed")[0]!;
  assert.equal(done.usage.costUsd, 0.05);
});

test("resetTo(null) means the room rewound to before its first turn", () => {
  const t = new TurnTranslator();
  t.startTurn("t1", "p1", "first");
  t.translate(promptEcho("u1"));
  t.translate(assistantSaid("a1", "done"));

  t.resetTo(null);

  t.startTurn("t2", "p2", "starting over");
  const cp = only(t.translate(promptEcho("u2")), "checkpoint.created")[0]!;
  assert.equal(cp.resumeAt, null, "nothing to resume into — a clean session");
});

test("unknown message kinds are ignored rather than guessed at", () => {
  const t = new TurnTranslator();
  t.startTurn("t1");
  // The SDKMessage union is broad and grows; a new kind must not throw.
  assert.deepEqual(t.translate(msg({ type: "task_started", uuid: "x" })), []);
});
