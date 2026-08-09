/**
 * Headless editor peer. Joins a room, optionally submits a prompt, and prints
 * every event it receives from the shared log.
 *
 * Two of these against one relay reproduce the whole scenario without VS Code,
 * which makes it the fastest way to check ordering, streaming, late-join and —
 * from M2 — the driver token, the suggestion queue and the approval gate.
 *
 *   node dist/test-client.js <name> [prompt]
 *
 * Environment switches, so one peer can play the driver in a scripted run:
 *   MPA_DRIVE=1        ask for the driver token on join
 *   MPA_AUTOPROMOTE=1  run other people's suggestions as they arrive
 *   MPA_AUTOAPPROVE=1  approve suspended tool calls (MPA_AUTODENY=1 to refuse)
 */
import WebSocket from "ws";
import {
  DEFAULT_RELAY_URL,
  decodeServer,
  encode,
  isEvent,
  type ClientMessage,
  type SessionEvent,
} from "@mpa/protocol";

const name = process.argv[2] ?? "tester";
const prompt = process.argv[3];
const roomId = process.env.MPA_ROOM ?? "demo";
const relayUrl = process.env.MPA_RELAY_URL ?? DEFAULT_RELAY_URL;

const flag = (key: string) => process.env[key] === "1";
const wantsDriver = flag("MPA_DRIVE");
const autoPromote = flag("MPA_AUTOPROMOTE");
const autoApprove = flag("MPA_AUTOAPPROVE");
const autoDeny = flag("MPA_AUTODENY");

let driving = false;

const socket = new WebSocket(relayUrl);
const send = (msg: ClientMessage) => socket.send(encode(msg));

// Accumulates streamed text per message so the output reads like a transcript
// rather than a token firehose.
const buffers = new Map<string, string>();
let roomCostUsd = 0;

function render(event: SessionEvent, replay: boolean): void {
  const tag = replay ? "replay" : "live";
  const who =
    event.actor.kind === "user" ? event.actor.name : event.actor.kind;

  if (isEvent(event, "assistant.delta")) {
    const id = event.body.messageId;
    const next = (buffers.get(id) ?? "") + event.body.text;
    buffers.set(id, next);
    if (!replay) process.stdout.write(event.body.text);
    return;
  }
  if (isEvent(event, "assistant.message")) {
    buffers.set(event.body.messageId, event.body.text);
    if (replay) console.log(`[${tag}] ${who}: ${event.body.text}`);
    else process.stdout.write("\n");
    return;
  }
  if (isEvent(event, "tool.requested")) {
    console.log(
      `\n[${tag}] 🔧 ${event.body.name} ${JSON.stringify(event.body.input).slice(0, 160)}`,
    );
    return;
  }
  if (isEvent(event, "tool.result")) {
    const status = event.body.isError ? "error" : "ok";
    console.log(
      `[${tag}] ↳ ${status}: ${event.body.preview.replace(/\n/g, " ").slice(0, 120)}`,
    );
    return;
  }
  if (isEvent(event, "turn.completed")) {
    const u = event.body.usage;
    // Room total is folded from per-turn deltas: the agent's own running total
    // restarts at zero whenever the session is resumed.
    roomCostUsd += u.costUsd ?? 0;
    console.log(
      `[${tag}] ✅ turn done — cost $${(u.costUsd ?? 0).toFixed(4)} (room $${roomCostUsd.toFixed(4)}), ${u.durationMs}ms`,
    );
    return;
  }
  if (isEvent(event, "prompt.submitted")) {
    const via = event.body.promotedBy ? ` (run by ${event.body.promotedBy.name})` : "";
    console.log(`[${tag}] 💬 ${who}${via}: ${event.body.text}`);
    return;
  }

  // ---- concurrency control ------------------------------------------------
  if (isEvent(event, "driver.granted")) {
    driving = event.body.userId === name;
    console.log(
      `[${tag}] 🎧 ${event.body.name} is driving (${event.body.reason})`,
    );
    return;
  }
  if (isEvent(event, "driver.released")) {
    if (event.body.userId === name) driving = false;
    console.log(`[${tag}] 🎧 ${event.body.name} released the wheel`);
    return;
  }
  if (isEvent(event, "driver.requested")) {
    console.log(`[${tag}] ✋ ${event.body.name} asked to drive`);
    // A scripted driver hands over rather than sitting on the token.
    if (driving && !replay && event.body.userId !== name) {
      send({ type: "grantDriver", userId: event.body.userId });
    }
    return;
  }
  if (isEvent(event, "suggestion.queued")) {
    console.log(`[${tag}] 📝 ${who} suggested: ${event.body.text}`);
    if (driving && autoPromote && !replay) {
      send({ type: "promoteSuggestion", suggestionId: event.body.suggestionId });
    }
    return;
  }
  if (isEvent(event, "suggestion.promoted")) {
    console.log(`[${tag}] ▶️  suggestion promoted`);
    return;
  }
  if (isEvent(event, "tool.approval.requested")) {
    console.log(
      `[${tag}] ⏸  approval needed: ${event.body.toolName} ${JSON.stringify(event.body.input).slice(0, 160)}`,
    );
    if (driving && !replay && (autoApprove || autoDeny)) {
      send({
        type: "decideApproval",
        requestId: event.body.requestId,
        allow: autoApprove,
        ...(autoDeny ? { reason: "Denied by the scripted driver." } : {}),
      });
    }
    return;
  }
  if (isEvent(event, "tool.approval.decided")) {
    console.log(
      `[${tag}] ${event.body.allow ? "✅" : "⛔"} ${who} ${event.body.allow ? "approved" : "denied"} the tool call`,
    );
    return;
  }
  if (isEvent(event, "agent.status")) {
    console.log(
      `[${tag}] agent: ${event.body.state}${event.body.detail ? ` — ${event.body.detail}` : ""}`,
    );
    return;
  }
  console.log(`[${tag}] ${event.body.type} (${who})`);
}

socket.on("open", () => {
  send({
    type: "hello",
    roomId,
    userId: name,
    name,
    role: "editor",
    sinceSeq: -1,
  });
});

socket.on("message", (raw) => {
  const msg = decodeServer(raw.toString());
  if (!msg) return;

  if (msg.type === "welcome") {
    console.log(
      `[${name}] joined ${msg.roomId} — ${msg.backlog.length} events replayed, ${msg.participants.length} participants`,
    );
    for (const event of msg.backlog) render(event, true);
    if (wantsDriver && !driving) send({ type: "requestDriver" });
    if (prompt) {
      // Whether this lands as a prompt or a suggestion is the relay's call.
      console.log(`[${name}] submitting: ${prompt}`);
      send({ type: "submitPrompt", text: prompt });
    }
    return;
  }
  if (msg.type === "event") {
    render(msg.event, false);
    return;
  }
  if (msg.type === "participants") {
    console.log(
      `\n[${name}] participants: ${msg.participants.map((p) => p.name).join(", ")}`,
    );
    return;
  }
  if (msg.type === "error") {
    console.error(`[${name}] relay error: ${msg.message}`);
  }
});

socket.on("error", (err) => {
  console.error(`[${name}] socket error:`, err.message);
  process.exit(1);
});
