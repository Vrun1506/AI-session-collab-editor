import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import type { EventDraft, ServerMessage } from "@mpa/protocol";
import { FileBridge, readOrEmpty } from "./files.js";
import type { RelayLink } from "./relay-link.js";
import type { AgentSession } from "./session.js";
import type { TurnTranslator } from "./translate.js";

/**
 * Checkpoint rewind and session fork (M4).
 *
 * The relay decides *whether* either may happen; this decides *how*, because
 * everything that can actually move — the SDK's pre-write file backups and its
 * session transcript — lives behind the SDK on this machine.
 *
 * None of the hard part is ours, which is the point: `rewindFiles` restores
 * from the SDK's own backups and `resumeSessionAt` truncates its own
 * transcript. `probe-rewind.mjs` checks both still behave after an upgrade.
 */

export interface RewindDeps {
  link: RelayLink;
  session: AgentSession;
  files: FileBridge;
  translator: TurnTranslator;
  cwd: string;
}

/**
 * Take the room back to a checkpoint.
 *
 * Three things have to move together or the rewind is a lie: the files on disk,
 * the agent's memory, and the transcript. This owns the first two — the third
 * is the `checkpoint.restored` event at the end, which tells the room to stop
 * counting the range it just abandoned.
 */
export async function performRewind(
  deps: RewindDeps,
  msg: Extract<ServerMessage, { type: "doRewind" }>,
): Promise<void> {
  const { link, session, files } = deps;
  const actor: EventDraft["actor"] = {
    kind: "user",
    userId: msg.requestedBy.userId,
    name: msg.requestedBy.name,
  };
  const fail = (reason: string): void => {
    console.error(`[agent-host] rewind failed: ${reason}`);
    link.publishAs(actor, {
      type: "checkpoint.failed",
      checkpointId: msg.checkpointId,
      reason,
    });
  };

  if (!session.running) {
    fail("the agent is not running");
    return;
  }

  try {
    // Ask what would move before anything moves. The dry run is the only way to
    // learn which files are involved, and knowing that is what lets the restore
    // reach people's open buffers rather than only disk.
    const preview = await session.rewindFiles(msg.userMessageId, {
      dryRun: true,
    });
    if (!preview.canRewind) {
      fail(preview.error ?? "the SDK will not rewind to that point");
      return;
    }
    const paths = preview.filesChanged ?? [];

    // The same courtesy as any other write: unsaved work goes to disk first,
    // and the paths are marked as being written so an editor does not mistake
    // the restore arriving on its file watcher for somebody's edit.
    await files.flush(paths, true);

    const before = new Map<string, string>();
    for (const path of paths) before.set(path, readOrEmpty(path));

    const result = await session.rewindFiles(msg.userMessageId);
    if (!result.canRewind) {
      fail(result.error ?? "the rewind was refused");
      return;
    }

    // Each restored file goes through the ordinary merge path. From the room's
    // point of view a rewind is a write like any other, and reusing M3 here
    // means open buffers receive the old text as a merge instead of quietly
    // disagreeing with the file underneath them.
    for (const path of paths) {
      await files.reportWrite(
        path,
        before.get(path) ?? "",
        readOrEmpty(path),
        deps.translator.openTurnId,
      );
    }

    deps.translator.resetTo(msg.resumeAt);
    const sessionId = await session.restart(msg.resumeAt);

    link.publishAs(actor, {
      type: "checkpoint.restored",
      checkpointId: msg.checkpointId,
      label: msg.label,
      fromSeq: msg.fromSeq,
      filesChanged: result.filesChanged ?? [],
      insertions: result.insertions ?? 0,
      deletions: result.deletions ?? 0,
      skippedLinks: result.skippedLinks ?? 0,
      sessionId,
    });

    const restored = (result.filesChanged ?? []).length;
    console.log(
      `[agent-host] rewound to "${msg.label}" — ${restored} file(s) restored` +
        (result.skippedLinks
          ? `, ${result.skippedLinks} refused as unsafe links`
          : ""),
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Branch this session for a room of its own.
 *
 * Unlike a rewind this leaves the running query completely alone — the whole
 * point is that both sides of the decision keep going. Note the SDK does not
 * copy file-history snapshots into a fork, so the new room can rewind to its
 * own turns but not back past the branch.
 */
export async function performFork(
  deps: RewindDeps,
  msg: Extract<ServerMessage, { type: "doFork" }>,
): Promise<void> {
  const { link, session } = deps;
  const report = (sessionId: string | null, error?: string): void => {
    link.send({
      type: "forkedSession",
      checkpointId: msg.checkpointId,
      toRoomId: msg.toRoomId,
      sessionId,
      ...(error ? { error } : {}),
    });
  };

  // Branching from before the first turn: there is no conversation to copy, so
  // the new room gets a fresh agent rather than an empty fork of this one.
  if (!msg.upToMessageId || !session.sessionId) {
    report(null);
    return;
  }

  try {
    const forked = await forkSession(session.sessionId, {
      upToMessageId: msg.upToMessageId,
      dir: deps.cwd,
    });
    report(forked.sessionId);
    console.log(
      `[agent-host] forked ${session.sessionId} -> ${forked.sessionId} for room ${msg.toRoomId}`,
    );
  } catch (err) {
    report(null, err instanceof Error ? err.message : String(err));
  }
}
