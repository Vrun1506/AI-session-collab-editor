import type { EventDraft } from "@mpa/protocol";
import { buildAudit, renderMarkdown } from "../audit.js";
import {
  identityOf,
  type Msg,
  type Peer,
  type RelayContext,
} from "./context.js";

/**
 * Checkpoint rewind, session fork and audit export (M4).
 *
 * The relay decides *whether* a rewind may happen; the agent-host decides
 * *how*, because everything that can actually move — the SDK's file backups and
 * its session transcript — lives behind the SDK on the host's machine. So both
 * handlers here are mostly guards, and the interesting work happens in the
 * round trip.
 */

export function forkKey(
  roomId: string,
  checkpointId: string,
  toRoomId: string,
): string {
  return `${roomId}\0${checkpointId}\0${toRoomId}`;
}

/**
 * Guards shared by rewind and fork.
 *
 * Both refuse across a running turn for the same reason: they would race the
 * agent's own writes, and there is no correct winner, so the caller is made to
 * interrupt first rather than have one picked for them.
 */
function checkpointFor(
  ctx: RelayContext,
  peer: Peer,
  checkpointId: string,
  verb: string,
) {
  const room = ctx.getRoom(peer.roomId);
  if (!room.isDriver(peer.participant.userId)) {
    ctx.refuse(peer.conn, `only the driver can ${verb} the session`);
    return undefined;
  }
  const checkpoint = room.getCheckpoint(checkpointId);
  if (!checkpoint) {
    ctx.refuse(peer.conn, "that checkpoint is no longer available");
    return undefined;
  }
  if (room.openTurnId) {
    ctx.refuse(
      peer.conn,
      `the agent is mid-turn — interrupt it first, then ${verb}`,
    );
    return undefined;
  }
  if (!ctx.agentHostIn(peer.roomId)) {
    ctx.refuse(peer.conn, "no agent-host connected to this room");
    return undefined;
  }
  room.markDriverActive();
  return checkpoint;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function onRewindTo(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"rewindTo">,
): void {
  const checkpoint = checkpointFor(ctx, peer, msg.checkpointId, "rewind");
  if (!checkpoint) return;

  const me = identityOf(peer);
  const host = ctx.agentHostIn(peer.roomId)!;
  ctx.send(host.conn, {
    type: "doRewind",
    checkpointId: checkpoint.checkpointId,
    label: checkpoint.label,
    userMessageId: checkpoint.userMessageId,
    resumeAt: checkpoint.resumeAt,
    fromSeq: checkpoint.fromSeq,
    requestedBy: me,
  });
  ctx.log(
    `[relay] ${peer.roomId}: ${me.name} rewinding to "${checkpoint.label}" (seq ${checkpoint.fromSeq})`,
  );
}

export function onForkRoom(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"forkRoom">,
): void {
  if (msg.toRoomId === peer.roomId) {
    ctx.refuse(peer.conn, "a room cannot be forked onto itself");
    return;
  }
  // Copying a prefix into a room that already has history would interleave two
  // sessions' sequence numbers irrecoverably.
  if (ctx.hasRoom(msg.toRoomId) || ctx.store.latestSeq(msg.toRoomId) >= 0) {
    ctx.refuse(peer.conn, `room "${msg.toRoomId}" already exists`);
    return;
  }
  const checkpoint = checkpointFor(ctx, peer, msg.checkpointId, "fork");
  if (!checkpoint) return;

  const host = ctx.agentHostIn(peer.roomId)!;
  ctx.pendingForks.set(
    forkKey(peer.roomId, msg.checkpointId, msg.toRoomId),
    identityOf(peer),
  );
  ctx.send(host.conn, {
    type: "doFork",
    checkpointId: msg.checkpointId,
    toRoomId: msg.toRoomId,
    // Branch just *before* the checkpoint's turn, so the new room is the
    // session as it stood when that prompt was about to run — the same point a
    // rewind would take this room back to.
    upToMessageId: checkpoint.resumeAt,
  });
}

export function onForkedSession(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"forkedSession">,
): void {
  const { roomId } = peer;
  if (peer.participant.role !== "agent-host") {
    ctx.refuse(peer.conn, "only the agent-host may report a fork");
    return;
  }
  const room = ctx.getRoom(roomId);
  const key = forkKey(roomId, msg.checkpointId, msg.toRoomId);
  const requestedBy = ctx.pendingForks.get(key) ?? null;
  ctx.pendingForks.delete(key);

  const checkpoint = room.getCheckpoint(msg.checkpointId);
  if (!checkpoint) return;

  const actor: EventDraft["actor"] = requestedBy
    ? { kind: "user", userId: requestedBy.userId, name: requestedBy.name }
    : { kind: "system" };

  const fail = (reason: string): void => {
    ctx.publish(roomId, {
      actor,
      body: { type: "checkpoint.failed", checkpointId: msg.checkpointId, reason },
    });
  };

  if (msg.error) {
    fail(`could not fork the session — ${msg.error}`);
    return;
  }

  // Re-checked rather than trusted from the request: forking the session is a
  // round trip through the agent-host, and somebody can walk into the target
  // room while it is in flight. A cached Room built before the copy would be
  // convinced the copied history is not there.
  if (ctx.hasRoom(msg.toRoomId) || ctx.store.latestSeq(msg.toRoomId) >= 0) {
    fail(
      `room "${msg.toRoomId}" was created while the fork was in flight — pick another name`,
    );
    return;
  }

  try {
    const copied = ctx.store.copyRoom(roomId, msg.toRoomId, checkpoint.fromSeq);
    if (msg.sessionId) {
      ctx.store.setAgentSessionId(msg.toRoomId, msg.sessionId);
    }
    // Constructed only after the copy: a Room caches its sequence numbering on
    // construction, so building it first would leave it convinced the copied
    // history is not there.
    ctx.getRoom(msg.toRoomId).append({
      actor,
      body: {
        type: "room.forked",
        checkpointId: msg.checkpointId,
        label: checkpoint.label,
        fromRoomId: roomId,
        atSeq: checkpoint.fromSeq,
        sessionId: msg.sessionId,
      },
    });
    ctx.publish(roomId, {
      actor,
      body: {
        type: "room.forked",
        checkpointId: msg.checkpointId,
        label: checkpoint.label,
        toRoomId: msg.toRoomId,
        atSeq: checkpoint.fromSeq,
        sessionId: msg.sessionId,
      },
    });
    ctx.log(
      `[relay] ${roomId}: forked ${copied} events into "${msg.toRoomId}" at seq ${checkpoint.fromSeq}`,
    );
  } catch (err) {
    fail(
      `could not fork the log — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function onRequestAudit(ctx: RelayContext, peer: Peer): void {
  // The raw log, not the compacted one: work a rewind abandoned still happened
  // and still cost money.
  const report = buildAudit(peer.roomId, ctx.getRoom(peer.roomId).since(-1));
  ctx.send(peer.conn, {
    type: "auditReport",
    roomId: peer.roomId,
    markdown: renderMarkdown(report),
  });
}
