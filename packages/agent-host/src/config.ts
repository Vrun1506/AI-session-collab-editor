import { DEFAULT_RELAY_URL } from "@mpa/protocol";
import { readLocalToken } from "@mpa/protocol/token";

/**
 * Everything this process reads from the environment, resolved once.
 *
 * Gathered here so the knobs are readable as a set, and so nothing deeper in
 * the process reaches for `process.env` at import time — which is what made the
 * old single-file version impossible to exercise with different settings.
 */

const splitList = (v: string): string[] =>
  v.split(",").map((t) => t.trim()).filter(Boolean);

export interface HostConfig {
  roomId: string;
  relayUrl: string;
  cwd: string;
  relayToken: string | undefined;
  /**
   * Tools that run without asking anyone. Reading is safe enough to be worth
   * the latency saved; everything else goes to the room.
   *
   * Applied by *our* hook, not passed to the SDK as `allowedTools`. A bare name
   * there auto-approves the tool before any callback runs, which is precisely
   * the shadowing the gate has to avoid.
   */
  autoApproved: Set<string>;
  /**
   * Tools nobody may authorise, however much they want to. Empty by default now
   * that every other tool goes to a human first — it remains as an escape hatch
   * for anyone wanting a harder guarantee than "a human said yes".
   */
  disallowedTools: string[];
  /**
   * How long a suspended tool call waits for a human before it gives up.
   * Without this an unattended room wedges the agent forever: a promise nobody
   * resolves is indistinguishable from a hang.
   */
  approvalTimeoutMs: number;
  /**
   * Whether file tools are routed through the room's shared documents. Off, the
   * agent reads and writes disk directly and the relay falls back to refusing
   * writes to files anyone has unsaved.
   */
  sharedBuffers: boolean;
  /** How long to wait for the room to write its buffers out before reading. */
  flushTimeoutMs: number;
}

export function configFromEnv(env = process.env): HostConfig {
  return {
    roomId: env.MPA_ROOM ?? "demo",
    relayUrl: env.MPA_RELAY_URL ?? DEFAULT_RELAY_URL,
    cwd: env.MPA_CWD ?? process.cwd(),
    // MPA_TOKEN if given, otherwise whatever the relay on this machine minted.
    relayToken: readLocalToken(),
    autoApproved: new Set(splitList(env.MPA_ALLOWED_TOOLS ?? "Read,Glob,Grep")),
    disallowedTools: splitList(env.MPA_DISALLOWED_TOOLS ?? ""),
    approvalTimeoutMs: Number(env.MPA_APPROVAL_TIMEOUT_MS ?? 300_000),
    sharedBuffers: env.MPA_SHARED_BUFFERS !== "0",
    flushTimeoutMs: Number(env.MPA_FLUSH_TIMEOUT_MS ?? 5_000),
  };
}

/** A short label for a checkpoint, taken from the prompt that opened its turn. */
export function labelFor(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 72 ? flat : `${flat.slice(0, 72)}…`;
}
