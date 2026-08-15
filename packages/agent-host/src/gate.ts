import { randomUUID } from "node:crypto";
import type { RelayLink } from "./relay-link.js";

export interface Decision {
  allow: boolean;
  reason?: string;
}

interface PendingApproval {
  toolName: string;
  input: unknown;
  turnId: string | null;
  settle: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

/**
 * The shared approval gate: tool calls suspended until the room decides.
 *
 * This is M2's whole point. The pause is real — the agent is genuinely stopped,
 * not shown a notification after the fact — and the request, its arguments and
 * the eventual decision all land in the shared log, so every participant sees
 * the same thing and the transcript answers "who approved that?" afterwards.
 *
 * It is driven from a `PreToolUse` hook rather than `canUseTool`, which was the
 * obvious choice and the wrong one: measured against this SDK, `canUseTool` is
 * simply not consulted for `Bash`, so the first version of this gate watched a
 * guest's prompt run a shell command with nobody asked. `probe-gate.mjs`
 * re-checks that before trusting either mechanism on a new SDK version.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly link: RelayLink,
    private readonly timeoutMs: number,
  ) {}

  /** Suspend until someone in the room decides, or the deadline passes. */
  ask(
    toolName: string,
    input: unknown,
    turnId: string | null,
    signal: AbortSignal,
  ): Promise<Decision> {
    const requestId = randomUUID();

    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          allow: false,
          reason: `No one approved this ${toolName} call within ${Math.round(
            this.timeoutMs / 1000,
          )}s.`,
        });
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(requestId, {
        toolName,
        input,
        turnId,
        settle: resolve,
        timer,
      });

      // An interrupt must not leave the room staring at a request that can no
      // longer matter.
      signal.addEventListener("abort", () => {
        this.settle(requestId, false, "Turn was interrupted.");
      });

      this.link.send({
        type: "requestApproval",
        requestId,
        toolName,
        input,
        turnId,
      });
    });
  }

  settle(requestId: string, allow: boolean, reason: string | undefined): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.settle({ allow, reason });
  }

  /**
   * Re-ask everything still suspended, after reconnecting.
   *
   * The relay may have restarted and forgotten them; if it has not, it answers
   * idempotently on the request id, so this is safe either way. Without it a
   * tool call would hang until its own timeout with nobody able to release it.
   */
  resendAll(): void {
    for (const [requestId, pending] of this.pending) {
      this.link.send({
        type: "requestApproval",
        requestId,
        toolName: pending.toolName,
        input: pending.input,
        turnId: pending.turnId,
      });
    }
  }
}
