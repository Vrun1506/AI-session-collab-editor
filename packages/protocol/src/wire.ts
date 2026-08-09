import { z } from "zod";
import { EventDraft, SessionEvent } from "./events.js";

/**
 * Wire protocol between the relay and everything else. Two kinds of peer
 * connect to a room over the same socket:
 *
 *  - "editor"     a participant's VS Code window
 *  - "agent-host" the process driving the Agent SDK (exactly one per room)
 *
 * The agent-host deliberately speaks only to the relay, never to an editor.
 * That seam is what lets it move to a cloud sandbox later without any client
 * change.
 */

export const PeerRole = z.enum(["editor", "agent-host"]);
export type PeerRole = z.infer<typeof PeerRole>;

export const Participant = z.object({
  userId: z.string(),
  name: z.string(),
  role: PeerRole,
});
export type Participant = z.infer<typeof Participant>;

// ---------------------------------------------------------------------------
// Peer -> relay
// ---------------------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    roomId: z.string(),
    userId: z.string(),
    name: z.string(),
    role: PeerRole,
    /** Replay cursor: send everything strictly after this seq. -1 = full history. */
    sinceSeq: z.number().int().default(-1),
  }),
  /** Append to the shared log. The relay stamps seq/ts and fans out. */
  z.object({
    type: z.literal("publish"),
    draft: EventDraft,
  }),
  /**
   * Ask the agent to run this text.
   *
   * Deliberately one message for everyone: the relay decides whether the
   * sender holds the driver token and so whether this becomes a prompt or a
   * queued suggestion. Clients never need to know, which means a stale idea of
   * who is driving cannot produce a prompt that should have been a suggestion.
   */
  z.object({
    type: z.literal("submitPrompt"),
    text: z.string().min(1),
  }),
  /** Anyone may interrupt, by design — a deadlocked room is worse than a
   *  cancelled turn. */
  z.object({ type: z.literal("interrupt") }),

  // ---- driver token (M2) ---------------------------------------------------
  /** Ask to drive. Granted at once if nobody is driving, or if the current
   *  driver is disconnected or has gone idle; otherwise it waits on them. */
  z.object({ type: z.literal("requestDriver") }),
  /** Current driver hands the token to a specific participant. */
  z.object({ type: z.literal("grantDriver"), userId: z.string() }),
  /** Current driver gives up the token; the longest-waiting requester takes it. */
  z.object({ type: z.literal("releaseDriver") }),

  // ---- suggestion queue (M2) -----------------------------------------------
  z.object({ type: z.literal("promoteSuggestion"), suggestionId: z.string() }),
  z.object({ type: z.literal("dismissSuggestion"), suggestionId: z.string() }),

  // ---- approval gate (M2) --------------------------------------------------
  /** agent-host -> relay: a tool call is suspended pending a human decision.
   *  Re-sending the same `requestId` is safe and is how the host recovers a
   *  pending gate after reconnecting. */
  z.object({
    type: z.literal("requestApproval"),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    turnId: z.string().nullable(),
  }),
  /** Driver -> relay: allow or deny a suspended tool call. */
  z.object({
    type: z.literal("decideApproval"),
    requestId: z.string(),
    allow: z.boolean(),
    reason: z.string().optional(),
  }),

  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------------------------------------------------------------------------
// Relay -> peer
// ---------------------------------------------------------------------------

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    roomId: z.string(),
    you: Participant,
    participants: z.array(Participant),
    /** Backlog since the requested cursor — this is what makes late-join free. */
    backlog: z.array(SessionEvent),
    latestSeq: z.number().int(),
    /**
     * The Agent SDK session this room was last served by, if any. Sent to a
     * starting agent-host so it can resume with the context it already built
     * instead of rereading the world. Persisting the log restores the
     * transcript; this restores the agent's memory of it.
     */
    agentSessionId: z.string().nullable(),
  }),
  z.object({ type: z.literal("event"), event: SessionEvent }),
  z.object({
    type: z.literal("participants"),
    participants: z.array(Participant),
  }),
  /** Relay -> agent-host only: run this prompt. */
  z.object({
    type: z.literal("runPrompt"),
    promptId: z.string(),
    text: z.string(),
    requestedBy: z.object({ userId: z.string(), name: z.string() }),
  }),
  /** Relay -> agent-host only. */
  z.object({
    type: z.literal("doInterrupt"),
    byUserId: z.string(),
  }),
  /** Relay -> agent-host only: releases a suspended `canUseTool` call. */
  z.object({
    type: z.literal("toolDecision"),
    requestId: z.string(),
    allow: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Parse an untrusted frame. Returns null rather than throwing so a malformed
 *  frame from one peer can never take down the relay. */
export function decodeClient(raw: string): ClientMessage | null {
  try {
    return ClientMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function decodeServer(raw: string): ServerMessage | null {
  try {
    return ServerMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
