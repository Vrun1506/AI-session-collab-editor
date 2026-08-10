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
    /** agent-host only: the workspace root it is running against, so the relay
     *  can resolve the relative paths a tool call asks to write. */
    cwd: z.string().optional(),
    /**
     * Proof that this peer is allowed in. Optional on the wire so the relay
     * can answer a missing token with a useful message rather than a parse
     * failure — whether one is *required* is the relay's decision, not the
     * schema's.
     */
    token: z.string().optional(),
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

  /**
   * Editor -> relay: absolute paths this participant is holding unsaved edits
   * to.
   *
   * The agent writes to disk out of band from every editor buffer, so without
   * this a write silently destroys someone's unsaved work — the failure mode
   * most likely to lose a user permanently. Sent as the whole set rather than
   * deltas so a reconnect resynchronises by itself, and kept out of the event
   * log because it is presence, not history.
   */
  z.object({
    type: z.literal("bufferState"),
    dirty: z.array(z.string()),
  }),

  // ---- shared buffers (M3) -------------------------------------------------
  /**
   * Editor -> relay: I have this file open, and here is what it says.
   *
   * The text seeds the shared document only if nobody has it open yet.
   * Otherwise the relay's copy wins and this peer adopts it — someone else may
   * be holding unsaved edits, and a joiner's view of disk must not erase them.
   * `sv` is this peer's state vector so the reply carries only what it lacks.
   */
  z.object({
    type: z.literal("docOpen"),
    path: z.string(),
    text: z.string(),
    sv: z.string(),
  }),
  z.object({ type: z.literal("docClose"), path: z.string() }),
  /** A Yjs update, base64-encoded — see `@mpa/crdt` for why it rides this
   *  socket rather than a binary one of its own. */
  z.object({
    type: z.literal("docUpdate"),
    path: z.string(),
    update: z.string(),
  }),
  /** Editor -> relay: the save the relay asked for is done. */
  z.object({ type: z.literal("docSaved"), path: z.string() }),

  /**
   * agent-host -> relay: I am about to run a tool that reads files. Make disk
   * tell the truth first.
   *
   * Without this the agent reads the last saved version of a file somebody has
   * been editing for ten minutes, and everything it concludes is about a file
   * that no longer exists. `paths: null` means every live document, which is
   * what a shell command needs — a test run should see what people are
   * actually looking at.
   */
  z.object({
    type: z.literal("docFlush"),
    requestId: z.string(),
    paths: z.array(z.string()).nullable(),
    /** True when the tool is going to change the file, not just read it. Only
     *  then do editors need to be told to expect a write. */
    write: z.boolean(),
  }),
  /**
   * agent-host -> relay: this file went from `before` to `after`.
   *
   * Sending both halves rather than just the result is what lets the relay
   * merge the change into buffers people are still typing in, instead of
   * overwriting them with the agent's idea of the file.
   */
  z.object({
    type: z.literal("docWrote"),
    writeId: z.string(),
    path: z.string(),
    before: z.string(),
    after: z.string(),
    turnId: z.string().nullable(),
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
  // ---- shared buffers (M3) -------------------------------------------------
  /** Relay -> editor: everything you are missing for this document.
   *  `seeded` says your text is what created it, so anything you typed while
   *  the round trip was in flight is safe to keep. */
  z.object({
    type: z.literal("docState"),
    path: z.string(),
    update: z.string(),
    seeded: z.boolean(),
  }),
  z.object({
    type: z.literal("docUpdate"),
    path: z.string(),
    update: z.string(),
    /** Whether a person or the agent wrote this, so editors can attribute it. */
    by: z.enum(["peer", "agent"]),
  }),
  /** Relay -> editor: write this buffer to disk, the agent is about to read it. */
  z.object({ type: z.literal("docSave"), path: z.string() }),
  /** Relay -> agent-host: disk now matches the room. */
  z.object({ type: z.literal("docFlushed"), requestId: z.string() }),
  /**
   * Relay -> editor: the agent is writing this path right now.
   *
   * Editors need to know because VS Code silently reloads an unmodified open
   * file when it changes on disk. Pushing that reload back into the shared
   * document would apply the agent's change a second time, concurrently with
   * the relay's own merge — and two concurrent inserts of the same text is
   * duplicated text, not convergence.
   */
  z.object({
    type: z.literal("docLock"),
    path: z.string(),
    locked: z.boolean(),
  }),

  /**
   * Relay -> agent-host: how the write actually landed in people's buffers.
   *
   * The tool result only says the file was written, which is true and can also
   * be misleading: if someone had rewritten the very lines the agent changed,
   * their version was kept and part of the change is simply not there. An agent
   * that is not told this reports success for work that did not happen.
   */
  z.object({
    type: z.literal("docMerged"),
    writeId: z.string(),
    /** False when nobody had the file open, so disk is the whole story. */
    live: z.boolean(),
    applied: z.number().int(),
    moved: z.number().int(),
    conflicts: z.number().int(),
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
