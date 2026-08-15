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
 *   MPA_DIRTY=a.ts,b.ts
 *                      pretend to be holding these files with unsaved changes,
 *                      which is how the write-conflict guard gets exercised
 *                      without opening an editor
 *
 * Shared buffers (M3). These make it a real editor peer rather than a viewer:
 *   MPA_OPEN=src/a.ts,src/b.ts
 *                      hold these files open as shared documents
 *   MPA_UNSAVED=text    type this into every open document without saving, so
 *                      disk and the room disagree the way they do when someone
 *                      is mid-edit
 *   MPA_TYPE_ON_LOCK=text
 *                      type this the instant the agent starts writing a file —
 *                      the race the whole milestone is about
 *   MPA_REPLACE_ON_LOCK=old>>new
 *                      rewrite this text the instant the agent starts writing.
 *                      Aim it at the lines the agent is about to change and the
 *                      merge should report a conflict rather than overwrite you
 *
 * Checkpoints, rewind and fork (M4):
 *   MPA_REWIND_AFTER=1 rewind to the checkpoint that opened the turn as soon as
 *                      that turn completes — the whole undo cycle in one run
 *   MPA_FORK_AFTER=name
 *                      fork that same checkpoint into a new room instead
 *   MPA_AUDIT=1        ask for the audit log and print it before exiting
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  DEFAULT_RELAY_URL,
  decodeServer,
  encode,
  isEvent,
  type ClientMessage,
  type SessionEvent,
} from "@mpa/protocol";
import { readLocalToken } from "@mpa/protocol/token";
import { applyUpdate, encodeUpdate, stateVector, textOf, Y } from "@mpa/crdt";

const name = process.argv[2] ?? "tester";
const prompt = process.argv[3];
const roomId = process.env.MPA_ROOM ?? "demo";
const relayUrl = process.env.MPA_RELAY_URL ?? DEFAULT_RELAY_URL;

const flag = (key: string) => process.env[key] === "1";
const wantsDriver = flag("MPA_DRIVE");
const autoPromote = flag("MPA_AUTOPROMOTE");
const autoApprove = flag("MPA_AUTOAPPROVE");
const autoDeny = flag("MPA_AUTODENY");
const dirty = (process.env.MPA_DIRTY ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const openPaths = (process.env.MPA_OPEN ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => resolve(p));
const unsavedText = process.env.MPA_UNSAVED;
const typeOnLock = process.env.MPA_TYPE_ON_LOCK;
const replaceOnLock = (process.env.MPA_REPLACE_ON_LOCK ?? "").split(">>");
const rewindAfter = flag("MPA_REWIND_AFTER");
const forkAfter = process.env.MPA_FORK_AFTER?.trim();
const wantsAudit = flag("MPA_AUDIT");

let driving = false;
/**
 * The most recent checkpoint, which is the one a scripted run wants: rewinding
 * "the turn that just happened" is the case worth being able to reproduce in
 * one command.
 */
let lastCheckpointId: string | null = null;

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
    // Rewind and fork are both refused while a turn is in flight, so this is
    // the first moment either can be asked for.
    if (!replay && driving && lastCheckpointId) {
      if (rewindAfter) {
        console.log(`[${name}] ⏪ rewinding to ${lastCheckpointId}`);
        send({ type: "rewindTo", checkpointId: lastCheckpointId });
      } else if (forkAfter) {
        console.log(`[${name}] 🌿 forking into ${forkAfter}`);
        send({
          type: "forkRoom",
          checkpointId: lastCheckpointId,
          toRoomId: forkAfter,
        });
      }
    }
    // With a rewind or fork pending, the interesting audit is the one *after*
    // it, so those request it themselves once their event lands.
    if (!replay && wantsAudit && !rewindAfter && !forkAfter) {
      send({ type: "requestAudit" });
    }
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
  if (isEvent(event, "doc.merged")) {
    const b = event.body;
    console.log(
      `[${tag}] 🔀 merged into ${b.path} — ${b.applied} change(s)` +
        `${b.moved ? `, ${b.moved} relocated` : ""}` +
        `${b.conflicts ? `, ${b.conflicts} SKIPPED as conflicts` : ""}` +
        `${b.holders.length ? ` · open by ${b.holders.join(", ")}` : ""}`,
    );
    return;
  }
  if (isEvent(event, "file.changed")) {
    console.log(`[${tag}] 📝 ${event.body.tool} wrote ${event.body.path}`);
    return;
  }
  if (isEvent(event, "agent.status")) {
    console.log(
      `[${tag}] agent: ${event.body.state}${event.body.detail ? ` — ${event.body.detail}` : ""}`,
    );
    return;
  }

  // ---- checkpoints, rewind and fork ---------------------------------------
  if (isEvent(event, "checkpoint.created")) {
    lastCheckpointId = event.body.checkpointId;
    console.log(`[${tag}] 📍 checkpoint: ${event.body.label}`);
    return;
  }
  if (isEvent(event, "checkpoint.restored")) {
    const b = event.body;
    console.log(
      `[${tag}] ⏪ ${who} rewound to "${b.label}" — ` +
        `${b.filesChanged.length} file(s) restored (+${b.insertions}/-${b.deletions})` +
        (b.skippedLinks
          ? `, ⚠️ ${b.skippedLinks} refused as unsafe links`
          : "") +
        `, now in session ${b.sessionId ?? "(fresh)"}`,
    );
    // Everything from fromSeq up to here is superseded — this is where a
    // client's transcript drops the turn it just watched happen.
    console.log(`[${tag}]    superseded seq ${b.fromSeq}..${event.seq - 1}`);
    if (wantsAudit) send({ type: "requestAudit" });
    return;
  }
  if (isEvent(event, "checkpoint.failed")) {
    console.log(`[${tag}] ⚠️  rewind failed — ${event.body.reason}`);
    return;
  }
  if (isEvent(event, "room.forked")) {
    const b = event.body;
    console.log(
      `[${tag}] 🌿 ${who} forked "${b.label}" at seq ${b.atSeq} ` +
        (b.toRoomId
          ? `into room "${b.toRoomId}" (this room carries on)`
          : `from room "${b.fromRoomId}"`) +
        ` — session ${b.sessionId ?? "(fresh)"}`,
    );
    if (wantsAudit) send({ type: "requestAudit" });
    return;
  }

  console.log(`[${tag}] ${event.body.type} (${who})`);
}

// ---------------------------------------------------------------------------
// Shared documents — a stand-in for an editor holding files open
// ---------------------------------------------------------------------------

const shared = new Map<string, Y.Doc>();

function openShared(path: string): void {
  const doc = new Y.Doc();
  shared.set(path, doc);

  doc.on("update", (update: Uint8Array, _origin: unknown, _doc, tr) => {
    if (tr.local) send({ type: "docUpdate", path, update: encodeUpdate(update) });
  });

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Holding a file open that does not exist yet is a fair thing to do.
  }
  send({ type: "docOpen", path, text, sv: stateVector(doc) });
}

/** Type into a document without writing it out, the way a person does. */
function typeInto(doc: Y.Doc, text: string): void {
  const ytext = textOf(doc);
  doc.transact(() => ytext.insert(ytext.length, text), "local");
}

function dumpShared(): void {
  for (const [path, doc] of shared) {
    const text = textOf(doc).toString();
    console.log(
      `\n[${name}] ${path} — ${text.length} chars in the shared document:\n${text}`,
    );
  }
}

socket.on("open", () => {
  const token = readLocalToken();
  send({
    type: "hello",
    roomId,
    userId: name,
    name,
    role: "editor",
    sinceSeq: -1,
    ...(token ? { token } : {}),
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
    if (dirty.length > 0) {
      console.log(`[${name}] holding unsaved: ${dirty.join(", ")}`);
      send({ type: "bufferState", dirty });
    }
    for (const path of openPaths) openShared(path);
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
  if (msg.type === "docState") {
    const doc = shared.get(msg.path);
    if (!doc) return;
    applyUpdate(doc, msg.update, "remote");
    console.log(
      `[${name}] 📄 ${msg.path} ${msg.seeded ? "seeded from disk" : "adopted from the room"} — ${textOf(doc).length} chars`,
    );
    // Unsaved work: the room's copy now says something disk does not.
    if (unsavedText) {
      typeInto(doc, unsavedText);
      console.log(`[${name}] ✍️  typed (unsaved): ${unsavedText.trim()}`);
      send({ type: "bufferState", dirty: [...shared.keys()] });
    }
    return;
  }
  if (msg.type === "docUpdate") {
    const doc = shared.get(msg.path);
    if (!doc) return;
    applyUpdate(doc, msg.update, msg.by === "agent" ? "agent" : "remote");
    console.log(
      `[${name}] 📄 ${msg.by} changed ${msg.path} — now ${textOf(doc).length} chars`,
    );
    return;
  }
  if (msg.type === "docSave") {
    // A real editor writes its buffer; so do we, or the agent reads a file
    // that disagrees with what everyone is looking at.
    const doc = shared.get(msg.path);
    if (doc) {
      writeFileSync(msg.path, textOf(doc).toString());
      console.log(`[${name}] 💾 saved ${msg.path} for the agent`);
    }
    send({ type: "docSaved", path: msg.path });
    return;
  }
  if (msg.type === "docLock") {
    console.log(
      `[${name}] ${msg.locked ? "🔒 agent is writing" : "🔓 agent finished"} ${msg.path}`,
    );
    const doc = shared.get(msg.path);
    if (msg.locked && doc && typeOnLock) {
      typeInto(doc, typeOnLock);
      console.log(`[${name}] ✍️  typed while the agent was writing`);
    }
    if (msg.locked && doc && replaceOnLock.length === 2) {
      const [from, to] = replaceOnLock as [string, string];
      const ytext = textOf(doc);
      const at = ytext.toString().indexOf(from);
      if (at === -1) {
        console.log(`[${name}] ⚠️  nothing matching "${from}" to rewrite`);
      } else {
        doc.transact(() => {
          ytext.delete(at, from.length);
          ytext.insert(at, to);
        }, "local");
        console.log(`[${name}] ✍️  rewrote "${from}" while the agent was writing`);
      }
    }
    return;
  }
  if (msg.type === "auditReport") {
    console.log(`\n===== audit log for ${msg.roomId} =====`);
    console.log(msg.markdown);
    console.log(`===== end of audit log =====\n`);
    return;
  }
  if (msg.type === "error") {
    console.error(`[${name}] relay error: ${msg.message}`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    dumpShared();
    process.exit(0);
  });
}

socket.on("error", (err) => {
  console.error(`[${name}] socket error:`, err.message);
  process.exit(1);
});
