/**
 * Headless editor peer. Joins a room, optionally submits a prompt, and prints
 * every event it receives from the shared log.
 *
 * Two of these against one relay reproduce the M0 scenario without VS Code,
 * which makes it the fastest way to check ordering, streaming and late-join.
 *
 *   node --experimental-strip-types src/test-client.ts <name> [prompt]
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

const socket = new WebSocket(relayUrl);
const send = (msg: ClientMessage) => socket.send(encode(msg));

// Accumulates streamed text per message so the output reads like a transcript
// rather than a token firehose.
const buffers = new Map<string, string>();

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
    console.log(
      `[${tag}] ✅ turn done — cost $${(u.costUsd ?? 0).toFixed(4)} (session $${(u.sessionTotalCostUsd ?? 0).toFixed(4)}), ${u.durationMs}ms`,
    );
    return;
  }
  if (isEvent(event, "prompt.submitted")) {
    console.log(`[${tag}] 💬 ${who}: ${event.body.text}`);
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
    if (prompt) {
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
