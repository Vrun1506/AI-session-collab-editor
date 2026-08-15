import type { ServerMessage } from "@mpa/protocol";
import { DocHub } from "../docs.js";
import type { Conn } from "./conn.js";
import type { Msg, Peer, RelayContext } from "./context.js";

/**
 * Shared documents: the flush/lock machinery behind M3.
 *
 * Two problems are solved here and they pull in opposite directions. The agent
 * must not read a file somebody has been editing for ten minutes (so editors
 * are asked to save, and the agent waits), and the agent's write must not
 * overwrite what they are typing (so the write arrives as hunks to be merged).
 * Everything below is bookkeeping for those two round trips.
 */

/** Everyone with this file open, optionally excluding the peer that caused it. */
export function holdersOf(
  ctx: RelayContext,
  roomId: string,
  path: string,
  except?: string,
): Peer[] {
  const holders = new Set(ctx.docs.holders(roomId, path));
  return ctx
    .peersIn(roomId)
    .filter(
      (p) => holders.has(p.participant.userId) && p.participant.userId !== except,
    );
}

export function sendToHolders(
  ctx: RelayContext,
  roomId: string,
  path: string,
  msg: ServerMessage,
  except?: string,
): void {
  for (const peer of holdersOf(ctx, roomId, path, except)) {
    ctx.send(peer.conn, msg);
  }
}

export function setLock(
  ctx: RelayContext,
  roomId: string,
  path: string,
  locked: boolean,
): void {
  if (!ctx.docs.setLock(roomId, path, locked)) return;
  sendToHolders(ctx, roomId, path, { type: "docLock", path, locked });

  const key = `${roomId}\0${path}`;
  clearTimeout(ctx.lockTimers.get(key));
  ctx.lockTimers.delete(key);
  if (!locked) return;

  const timer = setTimeout(() => {
    ctx.lockTimers.delete(key);
    if (ctx.docs.get(roomId, path)?.locked) {
      ctx.warn(`[relay] ${roomId}: releasing stale write lock on ${path}`);
      setLock(ctx, roomId, path, false);
    }
  }, ctx.config.writeLockTimeoutMs);
  timer.unref?.();
  ctx.lockTimers.set(key, timer);
}

/**
 * Release a write lock, but not instantly.
 *
 * The merge and the editor's own reload of the changed file are racing: VS Code
 * notices the disk change on a watcher of its own, which can fire after the
 * merge has already arrived. Holding the lock a moment longer means that late
 * reload is still recognised for what it is instead of being pushed into the
 * document as somebody's edit.
 */
export function releaseLockSoon(
  ctx: RelayContext,
  roomId: string,
  path: string,
): void {
  const timer = setTimeout(
    () => setLock(ctx, roomId, path, false),
    ctx.config.writeGraceMs,
  );
  timer.unref?.();
}

export function finishFlush(ctx: RelayContext, requestId: string): void {
  const pending = ctx.flushes.get(requestId);
  if (!pending) return;
  ctx.flushes.delete(requestId);
  clearTimeout(pending.timer);
  ctx.send(pending.conn, { type: "docFlushed", requestId });
}

export function beginFlush(
  ctx: RelayContext,
  requestId: string,
  roomId: string,
  conn: Conn,
  paths: string[] | null,
  write: boolean,
): void {
  // No paths named means a shell command, which could read anything — so every
  // live document is flushed. Running the tests against files nobody has saved
  // is a confusing way to lose an afternoon.
  const targets = (paths ?? ctx.docs.livePaths(roomId)).map((p) =>
    DocHub.key(p),
  );

  const waiting = new Set<string>();
  for (const path of targets) {
    if (write) setLock(ctx, roomId, path, true);
    for (const peer of holdersOf(ctx, roomId, path)) {
      const userId = peer.participant.userId;
      // Only a peer that actually has unsaved changes has anything to write.
      if (!ctx.dirtyBuffers.holders(roomId, path).includes(userId)) continue;
      waiting.add(`${userId}\0${path}`);
      ctx.send(peer.conn, { type: "docSave", path });
    }
  }

  if (waiting.size === 0) {
    ctx.send(conn, { type: "docFlushed", requestId });
    return;
  }

  const timer = setTimeout(() => {
    ctx.warn(
      `[relay] ${roomId}: ${waiting.size} buffer(s) did not save in time; the agent may read a stale file`,
    );
    finishFlush(ctx, requestId);
  }, ctx.config.flushTimeoutMs);
  timer.unref?.();

  ctx.flushes.set(requestId, { roomId, conn, waiting, timer });
}

export function noteSaved(
  ctx: RelayContext,
  roomId: string,
  userId: string,
  path: string,
): void {
  const key = `${userId}\0${DocHub.key(path)}`;
  for (const [requestId, pending] of ctx.flushes) {
    if (pending.roomId !== roomId) continue;
    if (!pending.waiting.delete(key)) continue;
    if (pending.waiting.size === 0) finishFlush(ctx, requestId);
  }
}

/** Drop a departing peer's documents and stop waiting on their saves. */
export function releaseDocs(
  ctx: RelayContext,
  roomId: string,
  userId: string,
): void {
  ctx.docs.closeAll(roomId, userId);
  for (const [requestId, pending] of ctx.flushes) {
    if (pending.roomId !== roomId) continue;
    for (const key of [...pending.waiting]) {
      if (key.startsWith(`${userId}\0`)) pending.waiting.delete(key);
    }
    if (pending.waiting.size === 0) finishFlush(ctx, requestId);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function onBufferState(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"bufferState">,
): void {
  ctx.dirtyBuffers.set(peer.roomId, peer.participant.userId, msg.dirty);
}

export function onDocOpen(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"docOpen">,
): void {
  if (peer.participant.role !== "editor") return;
  const path = DocHub.key(msg.path);
  const { update, seeded } = ctx.docs.open(
    peer.roomId,
    path,
    peer.participant.userId,
    msg.text,
    msg.sv,
  );
  ctx.send(peer.conn, { type: "docState", path, update, seeded });
  // A late opener may be walking into a write already in progress.
  if (ctx.docs.get(peer.roomId, path)?.locked) {
    ctx.send(peer.conn, { type: "docLock", path, locked: true });
  }
}

export function onDocClose(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"docClose">,
): void {
  ctx.docs.close(peer.roomId, msg.path, peer.participant.userId);
}

export function onDocUpdate(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"docUpdate">,
): void {
  const path = DocHub.key(msg.path);
  // Silently ignored for a document nobody is holding: that means the sender
  // closed it a moment ago, not that anything is wrong.
  if (!ctx.docs.apply(peer.roomId, path, msg.update)) return;
  sendToHolders(
    ctx,
    peer.roomId,
    path,
    { type: "docUpdate", path, update: msg.update, by: "peer" },
    peer.participant.userId,
  );
}

export function onDocSaved(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"docSaved">,
): void {
  noteSaved(ctx, peer.roomId, peer.participant.userId, msg.path);
}

export function onDocFlush(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"docFlush">,
): void {
  if (peer.participant.role !== "agent-host") {
    ctx.refuse(peer.conn, "only the agent-host may ask for a flush");
    return;
  }
  beginFlush(ctx, msg.requestId, peer.roomId, peer.conn, msg.paths, msg.write);
}

export function onDocWrote(
  ctx: RelayContext,
  peer: Peer,
  msg: Msg<"docWrote">,
): void {
  const { roomId } = peer;
  if (peer.participant.role !== "agent-host") {
    ctx.refuse(peer.conn, "only the agent-host may report a write");
    return;
  }
  const path = DocHub.key(msg.path);
  releaseLockSoon(ctx, roomId, path);

  // Nobody has it open, so the write on disk is the whole story and the
  // `file.changed` event the agent already published covers it.
  const outcome = ctx.docs.merge(roomId, path, msg.before, msg.after);
  if (!outcome) {
    ctx.send(peer.conn, {
      type: "docMerged",
      writeId: msg.writeId,
      live: false,
      applied: 0,
      moved: 0,
      conflicts: 0,
    });
    return;
  }

  if (outcome.update) {
    sendToHolders(ctx, roomId, path, {
      type: "docUpdate",
      path,
      update: outcome.update,
      by: "agent",
    });
  }

  const { applied, moved, conflicts } = outcome.report;
  // The agent is waiting on this before it reports what it did.
  ctx.send(peer.conn, {
    type: "docMerged",
    writeId: msg.writeId,
    live: true,
    applied,
    moved,
    conflicts,
  });

  if (applied === 0 && conflicts === 0) return;
  ctx.publish(roomId, {
    actor: { kind: "agent" },
    body: {
      type: "doc.merged",
      path,
      turnId: msg.turnId,
      applied,
      moved,
      conflicts,
      holders: ctx.docs
        .holders(roomId, path)
        .map((id) => ctx.nameOf(roomId, id)),
    },
  });
}
