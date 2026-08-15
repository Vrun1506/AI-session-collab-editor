import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "./queue.js";

/** How long to wait for a restarted query to announce its session id. */
const SESSION_ANNOUNCE_TIMEOUT_MS = 30_000;

export interface AgentSessionOptions {
  /** Everything passed straight to `query()` that never changes between runs. */
  baseOptions: Omit<Options, "resume" | "resumeSessionAt" | "forkSession">;
  onMessage(msg: SDKMessage): void;
  /** The agent loop ended for good — not merely swapped during a rewind. */
  onStopped(): void;
  onError(detail: string): void;
}

/**
 * The Agent SDK session, and the one genuinely stateful thing in this process.
 *
 * It exists because a rewind cannot move a live session backwards: the only way
 * is to end the running query and start another one resumed at an earlier
 * point. Doing that safely means coordinating five things — draining the prompt
 * queue, waiting for the old loop to finish, suppressing the "stopped" it would
 * otherwise announce, starting the replacement, and waiting for it to report
 * its new session id — and those used to be five module-level `let`s that any
 * part of the file could reach.
 *
 * Keeping them behind one object is what makes the ordering reviewable, and
 * makes it obvious that nothing else may touch them mid-swap.
 */
export class AgentSession {
  private prompts = new AsyncQueue<SDKUserMessage>();
  private active: ReturnType<typeof query> | undefined;
  private loopDone: Promise<void> = Promise.resolve();

  /** The session the agent is in right now — it moves when a rewind forks it. */
  private currentSessionId: string | null = null;
  private announce: ((id: string | null) => void) | null = null;

  /** Suppresses `onStopped` while one query is being swapped for another. */
  private restarting = false;

  constructor(private readonly options: AgentSessionOptions) {}

  get sessionId(): string | null {
    return this.currentSessionId;
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  start(resume: string | null): void {
    this.loopDone = this.run(resume, null, false);
  }

  /** Queue a prompt for the running turn. */
  submit(text: string): void {
    this.prompts.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage);
  }

  async interrupt(): Promise<void> {
    await this.active?.interrupt();
  }

  /** Restore tracked files to their state at a user message. */
  async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }) {
    if (!this.active) throw new Error("the agent is not running");
    return this.active.rewindFiles(userMessageId, options);
  }

  /**
   * Swap the running query for one resumed at an earlier point.
   *
   * Forking rather than truncating in place is deliberate: the abandoned branch
   * stays on disk, so a rewind somebody regrets is still recoverable by hand.
   *
   * @returns the new session id, or null if it never announced one
   */
  async restart(resumeAt: string | null): Promise<string | null> {
    const previous = this.currentSessionId;
    this.restarting = true;
    try {
      await this.active?.interrupt();
    } catch {
      // Interrupting a query that was already idle is not worth failing a
      // rewind over.
    }
    this.prompts.close();
    await this.loopDone;
    this.restarting = false;

    this.prompts = new AsyncQueue<SDKUserMessage>();
    const ready = new Promise<string | null>((resolve) => {
      this.announce = resolve;
    });

    // Rewinding to before the room's first turn leaves nothing to resume into,
    // so the agent starts clean rather than forking an empty transcript.
    const resume = resumeAt && previous ? previous : null;
    this.loopDone = this.run(resume, resumeAt, resume !== null);

    const id = await Promise.race([
      ready,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), SESSION_ANNOUNCE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    this.announce = null;
    return id;
  }

  close(): void {
    this.prompts.close();
  }

  private async run(
    resume: string | null,
    resumeSessionAt: string | null,
    fork: boolean,
  ): Promise<void> {
    try {
      this.active = query({
        prompt: this.prompts,
        options: {
          ...this.options.baseOptions,
          // Resuming restores what the agent already knows about this room, so
          // a relay or host restart does not send it back to a blank slate. The
          // session file is local to this machine; if it has gone, the SDK
          // starts fresh and the transcript still replays from the log.
          ...(resume ? { resume } : {}),
          // Set only by a rewind: keep the transcript up to this entry and drop
          // everything after it, into a fork so the abandoned branch survives.
          //
          // `resumeDropsTurn` is deliberately not passed alongside. It exists
          // to catch a caller discarding entries it had not observed — a queued
          // message the session absorbed mid-turn, say — but a rewind here only
          // ever runs with no turn in flight, against a fork point taken from
          // our own log, which is the authority on what is being discarded. Its
          // refusal is documented as deterministic and permanent, so arming a
          // guard we would only have to recover from adds a failure mode
          // without covering one.
          ...(resumeSessionAt ? { resumeSessionAt } : {}),
          ...(fork ? { forkSession: true } : {}),
        },
      });

      for await (const message of this.active) {
        if (message.type === "system" && message.subtype === "init") {
          this.currentSessionId = message.session_id;
          this.announce?.(message.session_id);
          this.announce = null;
        }
        this.options.onMessage(message);
      }
      // A rewind ends one query and starts another; announcing "stopped" in
      // between would tell the room the shared agent had gone away.
      if (!this.restarting) this.options.onStopped();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[agent-host] agent loop failed:", detail);
      if (!this.restarting) this.options.onError(detail);
    }
  }
}
