import { isAbsolute, resolve } from "node:path";

/**
 * Which tool calls touch a file, and which file.
 *
 * The agent writes straight to disk, with no idea that four people have the
 * project open and one of them has unsaved changes in the very file it is
 * about to rewrite. Nothing in the SDK knows about those buffers, so the check
 * has to happen here, before the write is allowed to proceed.
 */

/** Tools whose effect is to replace or modify a file's contents. */
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/**
 * The file a write tool is aimed at, as an absolute path, or null if it cannot
 * be determined.
 *
 * Returning null means "cannot tell", and callers must not treat that as
 * "safe" — it is only safe here because an undeterminable path also cannot
 * match anyone's dirty buffer, so the call still goes to a human either way.
 */
export function targetPath(
  toolName: string,
  input: unknown,
  cwd: string,
): string | null {
  if (!isWriteTool(toolName) || !input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const raw = record["file_path"] ?? record["notebook_path"] ?? record["path"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
}

/**
 * Dirty buffers, per room, per participant.
 *
 * Deliberately not in the event log: which files someone has unsaved is
 * presence, true only while they are connected, and replaying it after a
 * restart would block writes on behalf of people who left hours ago.
 */
export class DirtyBufferIndex {
  private readonly byUser = new Map<string, Map<string, Set<string>>>();

  /** Replaces everything known about one participant's unsaved files. */
  set(roomId: string, userId: string, paths: string[]): void {
    let room = this.byUser.get(roomId);
    if (!room) {
      room = new Map();
      this.byUser.set(roomId, room);
    }
    room.set(userId, new Set(paths.map((p) => resolve(p))));
  }

  clear(roomId: string, userId: string): void {
    this.byUser.get(roomId)?.delete(userId);
  }

  /** Everyone holding unsaved changes to `path`. */
  holders(roomId: string, path: string): string[] {
    const room = this.byUser.get(roomId);
    if (!room) return [];
    const target = resolve(path);
    return [...room.entries()]
      .filter(([, paths]) => paths.has(target))
      .map(([userId]) => userId);
  }
}
