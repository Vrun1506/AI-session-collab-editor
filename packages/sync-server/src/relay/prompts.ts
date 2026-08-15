import { randomUUID } from "node:crypto";
import type { Identity } from "@mpa/protocol";
import {
  identityOf,
  type Msg,
  type Peer,
  type RelayContext,
} from "./context.js";

/**
 * Prompts and the suggestion queue.
 *
 * The concurrency rule lives in `onSubmitPrompt`, in one place: the driver
 * prompts, everyone else suggests. Clients send the same message either way,
 * which is what stops a stale idea of who is driving from producing a prompt
 * that should have been a suggestion.
 */

/**
 * Log a prompt and hand it to the agent.
 *
 * `author` is whoever had the idea, which for a promoted suggestion is not the
 * person who pressed the button. Attribution is decided here, once, so cost and
 * audit both read from the same fact.
 */
export function dispatchPrompt(
  ctx: RelayContext,
  roomId: string,
  text: string,
  author: Identity,
  promotedBy: Identity | null,
  suggestionId: string | null,
): void {
  const promptId = randomUUID();

  if (suggestionId) {
    ctx.publish(roomId, {
      actor: promotedBy
        ? { kind: "user", userId: promotedBy.userId, name: promotedBy.name }
        : { kind: "system" },
      body: { type: "suggestion.promoted", suggestionId, promptId },
    });
  }

  // Log first, then dispatch: the prompt is part of the shared history whether
  // or not the agent-host manages to run it.
  ctx.publish(roomId, {
    actor: { kind: "user", userId: author.userId, name: author.name },
    body: {
      type: "prompt.submitted",
      promptId,
      text,
      ...(promotedBy ? { promotedBy } : {}),
      ...(suggestionId ? { suggestionId } : {}),
    },
  });

  const host = ctx.agentHostIn(roomId);
  if (host) {
    ctx.send(host.conn, {
      type: "runPrompt",
      promptId,
      text,
      requestedBy: author,
    });
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function onSubmitPrompt(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"submitPrompt">,
): void {
  const { roomId } = peer;
  const room = ctx.getRoom(roomId);
  const me = identityOf(peer);

  // The concurrency rule, in one place.
  if (!room.isDriver(me.userId)) {
    ctx.publish(roomId, {
      actor: { kind: "user", userId: me.userId, name: me.name },
      body: {
        type: "suggestion.queued",
        suggestionId: randomUUID(),
        text: msg.text,
      },
    });
    return;
  }

  if (!ctx.agentHostIn(roomId)) {
    ctx.refuse(peer.conn, "no agent-host connected to this room");
    return;
  }
  room.markDriverActive();
  dispatchPrompt(ctx, roomId, msg.text, me, null, null);
}

export function onPromoteSuggestion(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"promoteSuggestion">,
): void {
  const { roomId } = peer;
  const room = ctx.getRoom(roomId);
  const me = identityOf(peer);
  if (!room.isDriver(me.userId)) {
    ctx.refuse(peer.conn, "only the driver can run a suggestion");
    return;
  }
  const suggestion = room.getSuggestion(msg.suggestionId);
  if (!suggestion) {
    ctx.refuse(peer.conn, "that suggestion is no longer queued");
    return;
  }
  if (!ctx.agentHostIn(roomId)) {
    ctx.refuse(peer.conn, "no agent-host connected to this room");
    return;
  }
  room.markDriverActive();
  dispatchPrompt(
    ctx,
    roomId,
    suggestion.text,
    suggestion.author,
    me,
    suggestion.suggestionId,
  );
}

export function onDismissSuggestion(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"dismissSuggestion">,
): void {
  const { roomId } = peer;
  const room = ctx.getRoom(roomId);
  if (!room.isDriver(peer.participant.userId)) {
    ctx.refuse(peer.conn, "only the driver can dismiss a suggestion");
    return;
  }
  if (!room.getSuggestion(msg.suggestionId)) return;
  room.markDriverActive();
  ctx.publish(roomId, {
    actor: {
      kind: "user",
      userId: peer.participant.userId,
      name: peer.participant.name,
    },
    body: { type: "suggestion.dismissed", suggestionId: msg.suggestionId },
  });
}

export function onInterrupt(ctx: RelayContext, peer: Peer): void {
  // Available to everyone regardless of the token, by design: a deadlocked
  // room is worse than a cancelled turn.
  const host = ctx.agentHostIn(peer.roomId);
  if (host) {
    ctx.send(host.conn, {
      type: "doInterrupt",
      byUserId: peer.participant.userId,
    });
  }
}
