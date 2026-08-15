import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RelayLink } from "./relay-link.js";

/** Tools whose effect is a file on disk changing. */
export const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/** Tools that read one named file. */
export const READ_TOOLS = new Set(["Read", "NotebookRead"]);

/**
 * Tools that could touch anything.
 *
 * A shell command may read the whole tree, and a test run that sees the last
 * saved version of a file somebody has been editing for ten minutes produces a
 * result about a project that does not exist. So these flush every live
 * document, not one path.
 */
export const BROAD_TOOLS = new Set(["Bash", "Grep"]);

export interface MergeResult {
  live: boolean;
  applied: number;
  moved: number;
  conflicts: number;
}

export function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A Write that creates a file has no before-text, which is not an error.
    return "";
  }
}

/**
 * The agent's side of shared buffers: making disk tell the truth before a read,
 * and handing a write to the room rather than leaving it on disk.
 *
 * Both directions are round trips with deadlines, and the deadlines matter more
 * than they look — a room that has gone quiet must never stall the agent, and
 * an agent that never hears back must fall back to disk rather than hang.
 */
export class FileBridge {
  private readonly pendingFlushes = new Map<string, () => void>();
  private readonly pendingWrites = new Map<
    string,
    (result: MergeResult | null) => void
  >();

  /**
   * What a file said just before the agent changed it.
   *
   * Keyed by path because the SDK runs a tool to completion before the next one
   * starts, so a path can only be mid-write once. Holding the before-text is
   * what lets the relay merge the change into somebody's open buffer rather
   * than replacing it — without it all we could offer the room is the finished
   * file.
   */
  private readonly beforeText = new Map<string, string>();

  constructor(
    private readonly link: RelayLink,
    private readonly cwd: string,
    private readonly sharedBuffers: boolean,
    private readonly timeoutMs: number,
  ) {}

  /** The single file a tool names, resolved against the workspace root. */
  toolPath(toolName: string, input: unknown): string | null {
    if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) return null;
    if (!input || typeof input !== "object") return null;
    const record = input as Record<string, unknown>;
    const raw = record["file_path"] ?? record["notebook_path"] ?? record["path"];
    return typeof raw === "string" && raw.length > 0
      ? resolve(this.cwd, raw)
      : null;
  }

  rememberBefore(path: string): void {
    this.beforeText.set(path, readOrEmpty(path));
  }

  takeBefore(path: string): string | undefined {
    const before = this.beforeText.get(path);
    this.beforeText.delete(path);
    return before;
  }

  /**
   * Ask the room to write its unsaved buffers to disk, and wait.
   *
   * The editors do the saving rather than this process writing their files for
   * them, which matters: VS Code reloading a file that changed underneath a
   * dirty buffer means a conflict prompt, and nobody wants one of those every
   * time the agent reads something. Their own save is silent and leaves the
   * buffer clean.
   */
  flush(paths: string[] | null, write: boolean): Promise<void> {
    if (!this.sharedBuffers) return Promise.resolve();

    const requestId = randomUUID();
    return new Promise<void>((done) => {
      const timer = setTimeout(() => {
        this.pendingFlushes.delete(requestId);
        console.warn("[agent-host] no flush reply; reading disk as it stands");
        done();
      }, this.timeoutMs);
      timer.unref?.();

      this.pendingFlushes.set(requestId, () => {
        clearTimeout(timer);
        done();
      });
      this.link.send({ type: "docFlush", requestId, paths, write });
    });
  }

  onFlushed(requestId: string): void {
    this.pendingFlushes.get(requestId)?.();
    this.pendingFlushes.delete(requestId);
  }

  /**
   * Hand a write to the relay and wait to hear how it landed.
   *
   * Waiting at all is a deliberate cost: the alternative is finishing the tool
   * call before anyone knows whether the change survived contact with the
   * people editing the file.
   */
  reportWrite(
    path: string,
    before: string,
    after: string,
    turnId: string | null,
  ): Promise<MergeResult | null> {
    const writeId = randomUUID();
    return new Promise<MergeResult | null>((done) => {
      const timer = setTimeout(() => {
        this.pendingWrites.delete(writeId);
        done(null);
      }, this.timeoutMs);
      timer.unref?.();

      this.pendingWrites.set(writeId, (result) => {
        clearTimeout(timer);
        done(result);
      });
      this.link.send({
        type: "docWrote",
        writeId,
        path,
        before,
        after,
        turnId,
      });
    });
  }

  onMerged(writeId: string, result: MergeResult): void {
    this.pendingWrites.get(writeId)?.(result);
    this.pendingWrites.delete(writeId);
  }
}
