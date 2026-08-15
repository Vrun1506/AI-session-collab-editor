import type { Identity } from "@mpa/protocol";
import {
  decideDriverRequest,
  type DriverAction,
  type GrantReason,
} from "../policy.js";
import {
  identityOf,
  type Msg,
  type Peer,
  type RelayContext,
} from "./context.js";

/**
 * The driver token, at the relay's edge.
 *
 * The *rules* are not here — they are in `policy.ts`, deliberately, because
 * they are the product decision and everything below is the plumbing that
 * carries them out. This module turns a decision into log events.
 */

export function grantDriver(
  ctx: RelayContext,
  roomId: string,
  to: Identity,
  reason: GrantReason,
  from: Identity | null,
): void {
  ctx.publish(roomId, {
    actor: { kind: "system" },
    body: { type: "driver.granted", userId: to.userId, name: to.name, reason, from },
  });
  ctx.log(`[relay] ${roomId}: ${to.name} is driving (${reason})`);
}

/** Carry out whatever `policy.ts` decided. */
export function applyDriverAction(
  ctx: RelayContext,
  roomId: string,
  action: DriverAction,
): void {
  switch (action.kind) {
    case "grant":
      grantDriver(ctx, roomId, action.to, action.reason, action.from);
      break;
    case "queue":
      ctx.publish(roomId, {
        actor: { kind: "user", userId: action.who.userId, name: action.who.name },
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
// Handlers
// ---------------------------------------------------------------------------

export function onRequestDriver(ctx: RelayContext, peer: Peer): void {
  applyDriverAction(
    ctx,
    peer.roomId,
    decideDriverRequest(
      ctx.getRoom(peer.roomId),
      identityOf(peer),
      ctx.config.driverIdleMs,
    ),
  );
}

export function onGrantDriver(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"grantDriver">,
): void {
  const { roomId } = peer;
  const room = ctx.getRoom(roomId);
  const me = identityOf(peer);
  if (!room.isDriver(me.userId)) {
    ctx.refuse(peer.conn, "only the driver can hand over the token");
    return;
  }
  const target = room.listEditors().find((p) => p.userId === msg.userId);
  if (!target) {
    ctx.refuse(peer.conn, "that participant is not in the room");
    return;
  }
  grantDriver(
    ctx,
    roomId,
    { userId: target.userId, name: target.name },
    "handoff",
    me,
  );
}

export function onReleaseDriver(ctx: RelayContext, peer: Peer): void {
  const { roomId } = peer;
  const room = ctx.getRoom(roomId);
  const me = identityOf(peer);
  if (!room.isDriver(me.userId)) return;

  ctx.publish(roomId, {
    actor: { kind: "user", userId: me.userId, name: me.name },
    body: { type: "driver.released", userId: me.userId, name: me.name },
  });
  const next = room
    .pendingDriverRequests()
    .find((r) => room.isConnected(r.userId));
  if (next) grantDriver(ctx, roomId, next, "initial", me);
}
