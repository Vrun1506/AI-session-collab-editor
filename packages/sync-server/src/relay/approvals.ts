import type { EventDraft } from "@mpa/protocol";
import { isWriteTool, targetPath } from "../writes.js";
import {
  identityOf,
  type Msg,
  type Peer,
  type RelayContext,
} from "./context.js";

/**
 * The shared approval gate.
 *
 * The agent is genuinely suspended while this runs — the pause is real, not a
 * notification after the fact — so everything here is on the critical path of a
 * stopped agent and none of it may wait on anything slow.
 */

/**
 * Record a decision and release the suspended tool call.
 *
 * Shared by the driver's click and by the relay's own refusals, so both end up
 * in the transcript the same way. A decision the room cannot see afterwards is
 * not much of a shared approval gate.
 */
export function decideApproval(
  ctx: RelayContext,
  roomId: string,
  actor: EventDraft["actor"],
  requestId: string,
  allow: boolean,
  reason: string | undefined,
): void {
  ctx.publish(roomId, {
    actor,
    body: {
      type: "tool.approval.decided",
      requestId,
      allow,
      ...(reason ? { reason } : {}),
    },
  });
  const host = ctx.agentHostIn(roomId);
  if (host) {
    ctx.send(host.conn, {
      type: "toolDecision",
      requestId,
      allow,
      ...(reason ? { reason } : {}),
    });
  }
}

/**
 * Display names of anyone whose unsaved work this tool call would destroy.
 *
 * A live document is not at risk: the write is merged into the text people are
 * actually typing in rather than dropped on top of it, so refusing it would be
 * protecting them from nothing. This is the M2 guard narrowed to exactly the
 * case shared buffers do not cover — a file someone has unsaved changes to
 * while document sync is off or has not caught up.
 */
export function whoWouldLoseWork(
  ctx: RelayContext,
  roomId: string,
  toolName: string,
  input: unknown,
): string[] {
  if (!isWriteTool(toolName)) return [];
  const path = targetPath(
    toolName,
    input,
    ctx.roomCwd.get(roomId) ?? process.cwd(),
  );
  if (!path) return [];
  if (ctx.docs.isLive(roomId, path)) return [];

  return ctx.dirtyBuffers
    .holders(roomId, path)
    .map((userId) => ctx.nameOf(roomId, userId));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function onRequestApproval(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"requestApproval">,
): void {
  const { roomId } = peer;
  if (peer.participant.role !== "agent-host") {
    ctx.refuse(peer.conn, "only the agent-host may request approval");
    return;
  }
  const room = ctx.getRoom(roomId);

  // Idempotent on requestId: re-asking after a reconnect must not log the
  // request twice, and must not strand a call decided while the host was away.
  const existing = room.getApproval(msg.requestId);
  if (existing?.decision) {
    ctx.send(peer.conn, {
      type: "toolDecision",
      requestId: msg.requestId,
      allow: existing.decision.allow,
      ...(existing.decision.reason ? { reason: existing.decision.reason } : {}),
    });
    return;
  }
  if (existing) return;

  // Decided before the request goes out, and applied in the same tick, so no
  // participant's approval can be processed in between. A human clicking
  // Approve is consenting to the change, not to destroying a colleague's
  // unsaved work — and they have no way of knowing about it, so this must not
  // be a race an eager approver can win.
  const blocked = whoWouldLoseWork(ctx, roomId, msg.toolName, msg.input);

  // Published even when refused: the room should see what the agent tried to
  // do, not just that something was blocked.
  ctx.publish(roomId, {
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
      ctx,
      roomId,
      { kind: "system" },
      msg.requestId,
      false,
      `${names} ${blocked.length === 1 ? "has" : "have"} unsaved changes in that file. Ask them to save, or come back to it.`,
    );
  }
}

export function onDecideApproval(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"decideApproval">,
): void {
  const { roomId } = peer;
  const room = ctx.getRoom(roomId);
  const me = identityOf(peer);
  if (!room.isDriver(me.userId)) {
    ctx.refuse(peer.conn, "only the driver can approve a tool call");
    return;
  }
  const approval = room.getApproval(msg.requestId);
  if (!approval || approval.decision) return;

  room.markDriverActive();
  decideApproval(
    ctx,
    roomId,
    { kind: "user", userId: me.userId, name: me.name },
    msg.requestId,
    msg.allow,
    msg.reason,
  );
}
