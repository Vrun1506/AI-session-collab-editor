import type { ClientMessage, Participant } from "@mpa/protocol";
import { decideAfterLeave } from "../policy.js";
import type { Conn } from "./conn.js";
import type { Peer, RelayContext } from "./context.js";
import { releaseDocs } from "./documents.js";
import { applyDriverAction, grantDriver } from "./driver.js";

/**
 * Joining, leaving, and appending to the log.
 *
 * `hello` is the one message handled outside the dispatch table, because it is
 * the message that *creates* the peer every other handler is given.
 */

export function onHello(
  ctx: RelayContext,
  conn: Conn,
  msg: Extract<ClientMessage, { type: "hello" }>,
): void {
  // Checked before anything else touches room state, so an unauthorised socket
  // cannot create a room, publish, or appear in presence.
  const auth = ctx.authenticator.authenticate({
    token: msg.token,
    userId: msg.userId,
    name: msg.name,
    roomId: msg.roomId,
  });
  if (!auth.ok) {
    ctx.warn(`[relay] rejected ${msg.name} for ${msg.roomId}: ${auth.reason}`);
    ctx.refuse(conn, `not authorised — ${auth.reason}`);
    conn.close();
    return;
  }
  // The verified identity wins over whatever was asked for; today they are the
  // same, but that is what makes real accounts a drop-in later.
  const userId = auth.userId;
  const name = auth.name;

  const room = ctx.getRoom(msg.roomId);
  if (msg.role === "agent-host" && room.hasAgentHost()) {
    ctx.refuse(conn, "room already has an agent-host");
    conn.close();
    return;
  }

  // A returning identity replaces its own stale socket. Reconnects are routine,
  // and letting a ghost linger would corrupt presence and hold the driver token
  // against a live participant.
  for (const existing of ctx.peersIn(msg.roomId)) {
    if (existing.participant.userId === userId) {
      ctx.removePeer(existing.conn);
      existing.conn.close();
    }
  }

  if (msg.role === "agent-host" && msg.cwd) ctx.roomCwd.set(msg.roomId, msg.cwd);

  const participant: Participant = { userId, name, role: msg.role };
  // Capture the backlog before the join event so the joiner does not receive
  // its own arrival twice (once in backlog, once in fan-out).
  const backlog = room.compactedSince(msg.sinceSeq);
  const latestSeq = room.latestSeq;

  ctx.addPeer({ conn, roomId: msg.roomId, participant });

  ctx.send(conn, {
    type: "welcome",
    roomId: msg.roomId,
    you: participant,
    participants: room.listParticipants(),
    backlog,
    latestSeq,
    agentSessionId: room.agentSessionId,
  });

  if (msg.role === "editor") {
    ctx.publish(msg.roomId, {
      actor: { kind: "system" },
      body: { type: "room.joined", userId, name },
    });
    // Somebody has to be able to prompt. The first editor into an undriven room
    // takes the token automatically; everyone after that suggests until it is
    // handed over.
    if (!room.driver) {
      grantDriver(ctx, msg.roomId, { userId, name }, "initial", null);
    }
  }
  ctx.broadcastParticipants(msg.roomId);
  ctx.log(
    `[relay] ${name} (${msg.role}) joined ${msg.roomId} — ${room.size} events`,
  );
}

export function onPublish(
  ctx: RelayContext,
  peer: Peer,
  msg: Extract<ClientMessage, { type: "publish" }>,
): void {
  const body = msg.draft.body;
  // The agent reports its SDK session id when it initialises; remember it so
  // the room can be resumed with context after a restart.
  if (body.type === "agent.status" && body.sessionId) {
    ctx.getRoom(peer.roomId).rememberAgentSession(body.sessionId);
  }
  // A rewind leaves the room in a *forked* session, so the id it must be
  // resumed from tomorrow is the new one. Recording it here rather than waiting
  // for the fork's own `init` closes the window in which a crash would resume
  // the session the room just abandoned.
  if (body.type === "checkpoint.restored" && body.sessionId) {
    ctx.getRoom(peer.roomId).rememberAgentSession(body.sessionId);
  }
  ctx.publish(peer.roomId, msg.draft);
}

export function onPing(ctx: RelayContext, peer: Peer): void {
  ctx.send(peer.conn, { type: "pong" });
}

/** A peer's socket closed. Everything it was holding has to be let go. */
export function onDisconnect(ctx: RelayContext, conn: Conn): void {
  const peer = ctx.removePeer(conn);
  if (!peer) return;

  const room = ctx.getRoom(peer.roomId);
  room.removeParticipant(peer.participant.userId);
  room.dropRequest(peer.participant.userId);
  // Their unsaved buffers left with them; holding the lock open would block
  // writes on behalf of somebody who is no longer here.
  ctx.dirtyBuffers.clear(peer.roomId, peer.participant.userId);
  // Same for their open documents. A shared document with no one attached to it
  // is a copy of a file that only disk can now speak for.
  releaseDocs(ctx, peer.roomId, peer.participant.userId);

  if (peer.participant.role === "editor") {
    ctx.publish(peer.roomId, {
      actor: { kind: "system" },
      body: {
        type: "room.left",
        userId: peer.participant.userId,
        name: peer.participant.name,
      },
    });
    // A token held by nobody is the one state that genuinely breaks a room, so
    // it is resolved here rather than left for a human to notice.
    applyDriverAction(
      ctx,
      peer.roomId,
      decideAfterLeave(room, {
        userId: peer.participant.userId,
        name: peer.participant.name,
      }),
    );
  }
  ctx.broadcastParticipants(peer.roomId);
  ctx.log(`[relay] ${peer.participant.name} left ${peer.roomId}`);
}
