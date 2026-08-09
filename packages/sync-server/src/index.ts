import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_RELAY_PORT,
  decodeClient,
  encode,
  type EventDraft,
  type Participant,
  type ServerMessage,
} from "@mpa/protocol";
import { Room } from "./room.js";

interface Peer {
  socket: WebSocket;
  roomId: string;
  participant: Participant;
}

const rooms = new Map<string, Room>();
const peers = new Map<WebSocket, Peer>();

function getRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId);
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

const port = Number(process.env.MPA_RELAY_PORT ?? DEFAULT_RELAY_PORT);
const wss = new WebSocketServer({ port });

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const msg = decodeClient(raw.toString());
    if (!msg) {
      send(socket, { type: "error", message: "malformed frame" });
      return;
    }

    // Every message except `hello` requires an established peer.
    const peer = peers.get(socket);
    if (msg.type !== "hello" && !peer) {
      send(socket, { type: "error", message: "send hello first" });
      return;
    }

    switch (msg.type) {
      case "hello": {
        const room = getRoom(msg.roomId);
        if (msg.role === "agent-host" && room.hasAgentHost()) {
          send(socket, {
            type: "error",
            message: "room already has an agent-host",
          });
          socket.close();
          return;
        }

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
        }
        broadcastParticipants(msg.roomId);
        console.log(
          `[relay] ${msg.name} (${msg.role}) joined ${msg.roomId} — ${room.size} events`,
        );
        return;
      }

      case "publish": {
        publish(peer!.roomId, msg.draft);
        return;
      }

      case "submitPrompt": {
        const { roomId, participant } = peer!;
        const host = agentHostIn(roomId);
        if (!host) {
          send(socket, {
            type: "error",
            message: "no agent-host connected to this room",
          });
          return;
        }
        const promptId = randomUUID();
        // Log first, then dispatch: the prompt is part of the shared history
        // whether or not the agent-host manages to run it.
        publish(roomId, {
          actor: {
            kind: "user",
            userId: participant.userId,
            name: participant.name,
          },
          body: { type: "prompt.submitted", promptId, text: msg.text },
        });
        send(host.socket, {
          type: "runPrompt",
          promptId,
          text: msg.text,
          requestedBy: {
            userId: participant.userId,
            name: participant.name,
          },
        });
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

    if (peer.participant.role === "editor") {
      publish(peer.roomId, {
        actor: { kind: "system" },
        body: {
          type: "room.left",
          userId: peer.participant.userId,
          name: peer.participant.name,
        },
      });
    }
    broadcastParticipants(peer.roomId);
    console.log(`[relay] ${peer.participant.name} left ${peer.roomId}`);

    // Keep the log after the last peer leaves: the room is resumable within
    // the process lifetime. M1 persists it properly.
  });

  socket.on("error", (err) => {
    console.error("[relay] socket error:", err.message);
  });
});

wss.on("listening", () => {
  console.log(`[relay] listening on ws://127.0.0.1:${port}`);
});
