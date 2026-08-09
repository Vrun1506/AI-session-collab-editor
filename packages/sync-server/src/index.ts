import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_RELAY_PORT,
  decodeClient,
  encode,
  type EventDraft,
  type Identity,
  type Participant,
  type ServerMessage,
} from "@mpa/protocol";
import {
  decideAfterLeave,
  decideDriverRequest,
  type DriverAction,
  type GrantReason,
} from "./policy.js";
import { authenticatorFromEnv, tokenFilePath } from "./auth.js";
import { Room } from "./room.js";
import { MemoryEventStore, SqliteEventStore, type EventStore } from "./store.js";
import { DirtyBufferIndex, isWriteTool, targetPath } from "./writes.js";

interface Peer {
  socket: WebSocket;
  roomId: string;
  participant: Participant;
}

// `:memory:` keeps the old ephemeral behaviour for throwaway runs and tests.
const dbPath = process.env.MPA_DB ?? "mpa-sessions.db";
const store: EventStore =
  dbPath === ":memory:" ? new MemoryEventStore() : new SqliteEventStore(dbPath);

/**
 * How long a driver may go without doing anything before someone else can take
 * the token without asking. The token exists to stop two people talking over
 * each other, not to let one person lock the room by walking away.
 */
const driverIdleMs = Number(process.env.MPA_DRIVER_IDLE_MS ?? 120_000);

const rooms = new Map<string, Room>();
const peers = new Map<WebSocket, Peer>();
const dirtyBuffers = new DirtyBufferIndex();
const authenticator = authenticatorFromEnv();
/** Workspace root per room, reported by the agent-host on hello. */
const roomCwd = new Map<string, string>();

function getRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    // Constructing a Room replays the stored log: sequence numbering, the
    // driver token, the suggestion queue and any undecided approvals all come
    // back with it.
    room = new Room(roomId, store);
    rooms.set(roomId, room);
  }
  return room;
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(encode(msg));
}

function peersIn(roomId: string): Peer[] {
  return [...peers.values()].filter((p) => p.roomId === roomId);
}

/** Append to the room log and fan out to every peer, including the publisher
 *  so that all clients converge on the relay's ordering rather than optimistic
 *  local guesses. */
function publish(roomId: string, draft: EventDraft): void {
  const event = getRoom(roomId).append(draft);
  for (const peer of peersIn(roomId)) {
    send(peer.socket, { type: "event", event });
  }
}

function broadcastParticipants(roomId: string): void {
  const participants = getRoom(roomId).listParticipants();
  for (const peer of peersIn(roomId)) {
    send(peer.socket, { type: "participants", participants });
  }
}

function agentHostIn(roomId: string): Peer | undefined {
  return peersIn(roomId).find((p) => p.participant.role === "agent-host");
}

function identityOf(peer: Peer): Identity {
  return { userId: peer.participant.userId, name: peer.participant.name };
}

function refuse(socket: WebSocket, message: string): void {
  send(socket, { type: "error", message });
}

// ---------------------------------------------------------------------------
// Driver token
// ---------------------------------------------------------------------------

function grantDriver(
  roomId: string,
  to: Identity,
  reason: GrantReason,
  from: Identity | null,
): void {
  publish(roomId, {
    actor: { kind: "system" },
    body: {
      type: "driver.granted",
      userId: to.userId,
      name: to.name,
      reason,
      from,
    },
  });
  console.log(`[relay] ${roomId}: ${to.name} is driving (${reason})`);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * Record a decision and release the suspended tool call.
 *
 * Shared by the driver's click and by the relay's own refusals, so both end up
 * in the transcript the same way. A decision the room cannot see afterwards is
 * not much of a shared approval gate.
 */
function decideApproval(
  roomId: string,
  actor: EventDraft["actor"],
  requestId: string,
  allow: boolean,
  reason: string | undefined,
): void {
  publish(roomId, {
    actor,
    body: {
      type: "tool.approval.decided",
      requestId,
      allow,
      ...(reason ? { reason } : {}),
    },
  });
  const host = agentHostIn(roomId);
  if (host) {
    send(host.socket, {
      type: "toolDecision",
      requestId,
      allow,
      ...(reason ? { reason } : {}),
    });
  }
}

/** Display names of anyone whose unsaved work this tool call would destroy. */
function whoWouldLoseWork(
  roomId: string,
  toolName: string,
  input: unknown,
): string[] {
  if (!isWriteTool(toolName)) return [];
  const path = targetPath(toolName, input, roomCwd.get(roomId) ?? process.cwd());
  if (!path) return [];

  const room = getRoom(roomId);
  return dirtyBuffers
    .holders(roomId, path)
    .map(
      (userId) =>
        room.listParticipants().find((p) => p.userId === userId)?.name ??
        userId,
    );
}

/** Carry out whatever `policy.ts` decided. */
function applyDriverAction(roomId: string, action: DriverAction): void {
  switch (action.kind) {
    case "grant":
      grantDriver(roomId, action.to, action.reason, action.from);
      break;
    case "queue":
      publish(roomId, {
        actor: {
          kind: "user",
          userId: action.who.userId,
          name: action.who.name,
        },
        body: {
          type: "driver.requested",
          userId: action.who.userId,
          name: action.who.name,
        },
      });
      break;
    case "none":
      break;
  }
}

// ---------------------------------------------------------------------------

const port = Number(process.env.MPA_RELAY_PORT ?? DEFAULT_RELAY_PORT);

/**
 * Loopback unless someone deliberately opens it up.
 *
 * `ws` binds every interface by default, which put an unauthenticated socket on
 * the local network — and through it, an agent that can write files and run
 * shell commands on this machine. That was survivable while the agent was
 * read-only. It is not now.
 *
 * Set `MPA_HOST=0.0.0.0` to share a room across machines, and read the auth
 * section of the README before doing so.
 */
const host = process.env.MPA_HOST ?? "127.0.0.1";
const wss = new WebSocketServer({ port, host });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = decodeClient(raw.toString());
    if (!msg) {
      refuse(socket, "malformed frame");
      return;
    }

    // Every message except `hello` requires an established peer.
    const peer = peers.get(socket);
    if (msg.type !== "hello" && !peer) {
      refuse(socket, "send hello first");
      return;
    }

    switch (msg.type) {
      case "hello": {
        // Checked before anything else touches room state, so an unauthorised
        // socket cannot create a room, publish, or appear in presence.
        const auth = authenticator.authenticate({
          token: msg.token,
          userId: msg.userId,
          name: msg.name,
          roomId: msg.roomId,
        });
        if (!auth.ok) {
          console.warn(
            `[relay] rejected ${msg.name} for ${msg.roomId}: ${auth.reason}`,
          );
          refuse(socket, `not authorised — ${auth.reason}`);
          socket.close();
          return;
        }
        // The verified identity wins over whatever was asked for; today they
        // are the same, but that is what makes real accounts a drop-in later.
        msg.userId = auth.userId;
        msg.name = auth.name;

        const room = getRoom(msg.roomId);
        if (msg.role === "agent-host" && room.hasAgentHost()) {
          refuse(socket, "room already has an agent-host");
          socket.close();
          return;
        }

        // A returning identity replaces its own stale socket. Reconnects are
        // routine, and letting a ghost linger would corrupt presence and hold
        // the driver token against a live participant.
        for (const existing of peersIn(msg.roomId)) {
          if (existing.participant.userId === msg.userId) {
            peers.delete(existing.socket);
            existing.socket.close();
          }
        }

        if (msg.role === "agent-host" && msg.cwd) roomCwd.set(msg.roomId, msg.cwd);

        const participant: Participant = {
          userId: msg.userId,
          name: msg.name,
          role: msg.role,
        };
        // Capture the backlog before the join event so the joiner does not
        // receive its own arrival twice (once in backlog, once in fan-out).
        const backlog = room.compactedSince(msg.sinceSeq);
        const latestSeq = room.latestSeq;

        peers.set(socket, { socket, roomId: msg.roomId, participant });
        room.addParticipant(participant);

        send(socket, {
          type: "welcome",
          roomId: msg.roomId,
          you: participant,
          participants: room.listParticipants(),
          backlog,
          latestSeq,
          agentSessionId: room.agentSessionId,
        });

        if (msg.role === "editor") {
          publish(msg.roomId, {
            actor: { kind: "system" },
            body: {
              type: "room.joined",
              userId: msg.userId,
              name: msg.name,
            },
          });
          // Somebody has to be able to prompt. The first editor into an
          // undriven room takes the token automatically; everyone after that
          // suggests until it is handed over.
          if (!room.driver) {
            grantDriver(
              msg.roomId,
              { userId: msg.userId, name: msg.name },
              "initial",
              null,
            );
          }
        }
        broadcastParticipants(msg.roomId);
        console.log(
          `[relay] ${msg.name} (${msg.role}) joined ${msg.roomId} — ${room.size} events`,
        );
        return;
      }

      case "publish": {
        // The agent reports its SDK session id when it initialises; remember
        // it so the room can be resumed with context after a restart.
        const body = msg.draft.body;
        if (body.type === "agent.status" && body.sessionId) {
          getRoom(peer!.roomId).rememberAgentSession(body.sessionId);
        }
        publish(peer!.roomId, msg.draft);
        return;
      }

      case "submitPrompt": {
        const { roomId } = peer!;
        const room = getRoom(roomId);
        const me = identityOf(peer!);

        // The concurrency rule, in one place: the driver prompts, everyone
        // else suggests. Clients send the same message either way, so nobody
        // can prompt by holding a stale idea of who is driving.
        if (!room.isDriver(me.userId)) {
          publish(roomId, {
            actor: { kind: "user", userId: me.userId, name: me.name },
            body: {
              type: "suggestion.queued",
              suggestionId: randomUUID(),
              text: msg.text,
            },
          });
          return;
        }

        if (!agentHostIn(roomId)) {
          refuse(socket, "no agent-host connected to this room");
          return;
        }
        room.markDriverActive();
        dispatchPrompt(roomId, msg.text, me, null, null);
        return;
      }

      case "promoteSuggestion": {
        const { roomId } = peer!;
        const room = getRoom(roomId);
        const me = identityOf(peer!);
        if (!room.isDriver(me.userId)) {
          refuse(socket, "only the driver can run a suggestion");
          return;
        }
        const suggestion = room.getSuggestion(msg.suggestionId);
        if (!suggestion) {
          refuse(socket, "that suggestion is no longer queued");
          return;
        }
        if (!agentHostIn(roomId)) {
          refuse(socket, "no agent-host connected to this room");
          return;
        }
        room.markDriverActive();
        dispatchPrompt(
          roomId,
          suggestion.text,
          suggestion.author,
          me,
          suggestion.suggestionId,
        );
        return;
      }

      case "dismissSuggestion": {
        const { roomId } = peer!;
        const room = getRoom(roomId);
        if (!room.isDriver(peer!.participant.userId)) {
          refuse(socket, "only the driver can dismiss a suggestion");
          return;
        }
        if (!room.getSuggestion(msg.suggestionId)) return;
        room.markDriverActive();
        publish(roomId, {
          actor: {
            kind: "user",
            userId: peer!.participant.userId,
            name: peer!.participant.name,
          },
          body: {
            type: "suggestion.dismissed",
            suggestionId: msg.suggestionId,
          },
        });
        return;
      }

      case "requestDriver": {
        const room = getRoom(peer!.roomId);
        applyDriverAction(
          peer!.roomId,
          decideDriverRequest(room, identityOf(peer!), driverIdleMs),
        );
        return;
      }

      case "grantDriver": {
        const { roomId } = peer!;
        const room = getRoom(roomId);
        const me = identityOf(peer!);
        if (!room.isDriver(me.userId)) {
          refuse(socket, "only the driver can hand over the token");
          return;
        }
        const target = room
          .listEditors()
          .find((p) => p.userId === msg.userId);
        if (!target) {
          refuse(socket, "that participant is not in the room");
          return;
        }
        grantDriver(
          roomId,
          { userId: target.userId, name: target.name },
          "handoff",
          me,
        );
        return;
      }

      case "releaseDriver": {
        const { roomId } = peer!;
        const room = getRoom(roomId);
        const me = identityOf(peer!);
        if (!room.isDriver(me.userId)) return;

        publish(roomId, {
          actor: { kind: "user", userId: me.userId, name: me.name },
          body: { type: "driver.released", userId: me.userId, name: me.name },
        });
        const next = room
          .pendingDriverRequests()
          .find((r) => room.isConnected(r.userId));
        if (next) grantDriver(roomId, next, "initial", me);
        return;
      }

      case "requestApproval": {
        // agent-host only, and idempotent on requestId: re-asking after a
        // reconnect must not log the request twice, and must not strand a call
        // that was already decided while the host was away.
        const { roomId } = peer!;
        if (peer!.participant.role !== "agent-host") {
          refuse(socket, "only the agent-host may request approval");
          return;
        }
        const room = getRoom(roomId);
        const existing = room.getApproval(msg.requestId);
        if (existing?.decision) {
          send(socket, {
            type: "toolDecision",
            requestId: msg.requestId,
            allow: existing.decision.allow,
            ...(existing.decision.reason
              ? { reason: existing.decision.reason }
              : {}),
          });
          return;
        }
        if (existing) return;

        // Decided before the request goes out, and applied in the same tick,
        // so no participant's approval can be processed in between. A human
        // clicking Approve is consenting to the change, not to destroying a
        // colleague's unsaved work — and they have no way of knowing about it,
        // so this must not be a race they can win.
        const blocked = whoWouldLoseWork(roomId, msg.toolName, msg.input);

        // Published even when refused: the room should see what the agent
        // tried to do, not just that something was blocked.
        publish(roomId, {
          actor: { kind: "agent" },
          body: {
            type: "tool.approval.requested",
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            turnId: msg.turnId,
          },
        });

        if (blocked.length > 0) {
          const names = blocked.join(" and ");
          decideApproval(
            roomId,
            { kind: "system" },
            msg.requestId,
            false,
            `${names} ${blocked.length === 1 ? "has" : "have"} unsaved changes in that file. Ask them to save, or come back to it.`,
          );
        }
        return;
      }

      case "decideApproval": {
        const { roomId } = peer!;
        const room = getRoom(roomId);
        const me = identityOf(peer!);
        if (!room.isDriver(me.userId)) {
          refuse(socket, "only the driver can approve a tool call");
          return;
        }
        const approval = room.getApproval(msg.requestId);
        if (!approval || approval.decision) return;

        room.markDriverActive();
        decideApproval(
          roomId,
          { kind: "user", userId: me.userId, name: me.name },
          msg.requestId,
          msg.allow,
          msg.reason,
        );
        return;
      }

      case "bufferState": {
        dirtyBuffers.set(peer!.roomId, peer!.participant.userId, msg.dirty);
        return;
      }

      case "interrupt": {
        const host = agentHostIn(peer!.roomId);
        if (host) {
          send(host.socket, {
            type: "doInterrupt",
            byUserId: peer!.participant.userId,
          });
        }
        return;
      }

      case "ping": {
        send(socket, { type: "pong" });
        return;
      }
    }
  });

  socket.on("close", () => {
    const peer = peers.get(socket);
    if (!peer) return;
    peers.delete(socket);

    const room = getRoom(peer.roomId);
    room.removeParticipant(peer.participant.userId);
    room.dropRequest(peer.participant.userId);
    // Their unsaved buffers left with them; holding the lock open would block
    // writes on behalf of somebody who is no longer here.
    dirtyBuffers.clear(peer.roomId, peer.participant.userId);

    if (peer.participant.role === "editor") {
      publish(peer.roomId, {
        actor: { kind: "system" },
        body: {
          type: "room.left",
          userId: peer.participant.userId,
          name: peer.participant.name,
        },
      });
      // A token held by nobody is the one state that genuinely breaks a room,
      // so it is resolved here rather than left for a human to notice.
      applyDriverAction(
        peer.roomId,
        decideAfterLeave(room, {
          userId: peer.participant.userId,
          name: peer.participant.name,
        }),
      );
    }
    broadcastParticipants(peer.roomId);
    console.log(`[relay] ${peer.participant.name} left ${peer.roomId}`);
  });

  socket.on("error", (err) => {
    console.error("[relay] socket error:", err.message);
  });
});

/**
 * Log a prompt and hand it to the agent.
 *
 * `author` is whoever had the idea, which for a promoted suggestion is not the
 * person who pressed the button. Attribution is decided here, once, so cost and
 * audit both read from the same fact.
 */
function dispatchPrompt(
  roomId: string,
  text: string,
  author: Identity,
  promotedBy: Identity | null,
  suggestionId: string | null,
): void {
  const promptId = randomUUID();

  if (suggestionId) {
    publish(roomId, {
      actor: promotedBy
        ? { kind: "user", userId: promotedBy.userId, name: promotedBy.name }
        : { kind: "system" },
      body: { type: "suggestion.promoted", suggestionId, promptId },
    });
  }

  // Log first, then dispatch: the prompt is part of the shared history whether
  // or not the agent-host manages to run it.
  publish(roomId, {
    actor: { kind: "user", userId: author.userId, name: author.name },
    body: {
      type: "prompt.submitted",
      promptId,
      text,
      ...(promotedBy ? { promotedBy } : {}),
      ...(suggestionId ? { suggestionId } : {}),
    },
  });

  const host = agentHostIn(roomId);
  if (host) {
    send(host.socket, {
      type: "runPrompt",
      promptId,
      text,
      requestedBy: author,
    });
  }
}

wss.on("listening", () => {
  console.log(`[relay] listening on ws://${host}:${port}`);
  console.log(`[relay] auth: ${authenticator.describe()} — ${tokenFilePath()}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      `[relay] WARNING: reachable from the network on ${host}:${port}. ` +
        "Anyone who can connect can drive an agent that writes files and runs " +
        "commands on the agent-host's machine.",
    );
  }
});
