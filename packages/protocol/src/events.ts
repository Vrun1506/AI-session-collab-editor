import { z } from "zod";

/**
 * The append-only event log is the core data structure of the system.
 * Everything a client renders is derived state folded from this log.
 *
 * Publishers (editors, agent-host) emit `EventDraft`s. The relay is the sole
 * authority for `seq` and `ts` — it stamps them on arrival, which is what makes
 * total ordering and replay-from-seq possible.
 */

/** A participant, in the smallest form worth putting in the log. */
export const Identity = z.object({
  userId: z.string(),
  name: z.string(),
});
export type Identity = z.infer<typeof Identity>;

export const Actor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    userId: z.string(),
    name: z.string(),
  }),
  z.object({ kind: z.literal("agent") }),
  // Emitted by the relay itself (presence, token grants).
  z.object({ kind: z.literal("system") }),
]);
export type Actor = z.infer<typeof Actor>;

/**
 * Cost/usage carried on turn completion so per-participant attribution is
 * possible from day one — see the billing constraint in the plan.
 *
 * Note `costUsd` is the cost of THIS turn. The SDK's `total_cost_usd` is a
 * running total across a streaming-input session, so the agent-host subtracts
 * the previous total to get a per-turn delta. `sessionTotalCostUsd` keeps the
 * raw running figure for display.
 */
export const TurnUsage = z.object({
  costUsd: z.number().nullable(),
  sessionTotalCostUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;

/**
 * Event payloads. M0 covers presence + the full prompt→turn→tool→result cycle.
 * Types reserved for later milestones (driver token, approvals, buffers,
 * checkpoints) are declared here so the log format does not churn later.
 */
export const EventBody = z.discriminatedUnion("type", [
  // ---- presence -----------------------------------------------------------
  z.object({
    type: z.literal("room.joined"),
    userId: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("room.left"),
    userId: z.string(),
    name: z.string(),
  }),

  // ---- agent lifecycle ----------------------------------------------------
  z.object({
    type: z.literal("agent.status"),
    state: z.enum(["starting", "ready", "busy", "stopped", "error"]),
    detail: z.string().optional(),
    sessionId: z.string().nullable().optional(),
  }),

  // ---- the turn cycle -----------------------------------------------------
  z.object({
    type: z.literal("prompt.submitted"),
    promptId: z.string(),
    text: z.string(),
    /**
     * Set when this prompt began life as another participant's suggestion.
     * The `actor` stays the original author — the log credits whoever had the
     * idea, not the driver who happened to hold the token — and this records
     * who let it through.
     */
    promotedBy: Identity.optional(),
    suggestionId: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn.started"),
    turnId: z.string(),
    promptId: z.string().nullable(),
  }),
  // A turn may contain several assistant messages. `messageId` is stable
  // across the deltas of one message, so clients append deltas into the right
  // bubble and then replace it with the authoritative final text.
  z.object({
    type: z.literal("assistant.delta"),
    turnId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant.message"),
    turnId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("thinking.delta"),
    turnId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool.requested"),
    turnId: z.string(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool.result"),
    turnId: z.string(),
    toolUseId: z.string(),
    isError: z.boolean(),
    /** Truncated for transport; the full result stays in the SDK transcript. */
    preview: z.string(),
  }),
  z.object({
    type: z.literal("turn.completed"),
    turnId: z.string(),
    isError: z.boolean(),
    usage: TurnUsage,
  }),
  z.object({
    type: z.literal("turn.interrupted"),
    turnId: z.string(),
    byUserId: z.string().nullable(),
  }),

  // ---- concurrency control (M2) -------------------------------------------
  /**
   * Exactly one participant holds the driver token and may prompt the agent
   * directly. Everyone else suggests. The token lives in the log rather than in
   * relay memory so it survives a restart along with everything else — and so
   * "who was driving when this happened" is answerable after the fact.
   */
  z.object({
    type: z.literal("driver.granted"),
    userId: z.string(),
    name: z.string(),
    /**
     * Why the token moved, which is the interesting part when reading back.
     * `initial` nobody was driving · `handoff` the driver passed it on ·
     * `idle` taken from a driver who had gone quiet · `offline` taken from a
     * driver who had disconnected.
     */
    reason: z.enum(["initial", "handoff", "idle", "offline"]),
    from: Identity.nullable().optional(),
  }),
  z.object({
    type: z.literal("driver.requested"),
    userId: z.string(),
    name: z.string(),
  }),
  z.object({
    type: z.literal("driver.released"),
    userId: z.string(),
    name: z.string(),
  }),

  z.object({
    type: z.literal("suggestion.queued"),
    suggestionId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("suggestion.promoted"),
    suggestionId: z.string(),
    promptId: z.string(),
  }),
  z.object({
    type: z.literal("suggestion.dismissed"),
    suggestionId: z.string(),
  }),

  /**
   * The shared approval gate. The agent-host suspends inside `canUseTool`
   * until a decision arrives, so this pair of events brackets a real pause in
   * the agent's execution rather than merely describing one.
   */
  z.object({
    type: z.literal("tool.approval.requested"),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    turnId: z.string().nullable(),
  }),
  z.object({
    type: z.literal("tool.approval.decided"),
    requestId: z.string(),
    allow: z.boolean(),
    reason: z.string().optional(),
  }),

  /**
   * The agent changed a file on disk. Every participant needs to know, not
   * just whoever happens to be hosting — an edit nobody can see is worse than
   * no edit at all.
   */
  z.object({
    type: z.literal("file.changed"),
    path: z.string(),
    turnId: z.string().nullable(),
    tool: z.string(),
  }),

  // ---- shared buffers (M3) -------------------------------------------------
  /**
   * An agent write was merged into a document people had open, rather than
   * landing on disk for everyone to reload.
   *
   * The counts are the honest part. The agent computed its change against the
   * file as it was when the tool started; anything typed since then moves the
   * change (`moved`) or, if someone rewrote the very lines the agent meant to
   * change, leaves it unapplied (`conflicts`). A room that cannot see that
   * happened would be trusting a merge it has no way to check.
   */
  z.object({
    type: z.literal("doc.merged"),
    path: z.string(),
    turnId: z.string().nullable(),
    applied: z.number().int(),
    moved: z.number().int(),
    conflicts: z.number().int(),
    /** Who had the file open, so the transcript says whose buffer changed. */
    holders: z.array(z.string()),
  }),

  // ---- checkpoints, rewind and fork (M4) -----------------------------------
  /**
   * A point the room can be taken back to: one per turn, recorded when the turn
   * starts.
   *
   * Rewinding has to move three things that are keyed differently — the
   * transcript (our `seq`), the files on disk and the agent's memory (both the
   * SDK's message UUIDs) — and nothing else bridges those two id spaces. That
   * is the entire reason this event exists: it is the join row.
   *
   * `promptId` rather than a sequence number because the agent-host publishes
   * this and only the relay knows `seq`; the room resolves it when folding.
   */
  z.object({
    type: z.literal("checkpoint.created"),
    checkpointId: z.string(),
    turnId: z.string().nullable(),
    promptId: z.string().nullable(),
    /** Human label, derived from the prompt that opened the turn. */
    label: z.string(),
    /** SDK uuid of the prompt. `rewindFiles` restores files to this point. */
    userMessageId: z.string(),
    /**
     * SDK uuid of the last chain entry *before* this turn, for
     * `resumeSessionAt`. Null on the room's first turn, which rewinds to a
     * session with no history rather than to a point inside one.
     */
    resumeAt: z.string().nullable(),
  }),

  /**
   * The room was taken back to a checkpoint.
   *
   * Nothing is deleted. The log stays append-only and this event declares a
   * range of it superseded, which is what keeps "what actually happened" and
   * "what the room is working from now" both answerable — the transcript hides
   * the abandoned range, the audit export still shows it.
   */
  z.object({
    type: z.literal("checkpoint.restored"),
    checkpointId: z.string(),
    label: z.string(),
    /** Events from here up to this event are superseded. */
    fromSeq: z.number().int(),
    /** Files the SDK put back, and by how much. */
    filesChanged: z.array(z.string()),
    insertions: z.number().int(),
    deletions: z.number().int(),
    /**
     * Files the SDK refused to restore because a symlink or a moved parent
     * directory made it unsafe. Surfaced because a rewind that silently left
     * some files rewritten is worse than one that failed outright.
     */
    skippedLinks: z.number().int(),
    /** The session the room continues in — a fork, so the old one is intact. */
    sessionId: z.string().nullable(),
  }),

  /** A rewind that could not be completed, kept in the log because a failed
   *  rewind leaves the room in a state somebody has to reason about. */
  z.object({
    type: z.literal("checkpoint.failed"),
    checkpointId: z.string(),
    reason: z.string(),
  }),

  /**
   * A checkpoint was branched into a room of its own, leaving this one running.
   *
   * The fork copies the log up to the checkpoint and forks the agent's session
   * at the same point, so the new room's agent remembers everything the old one
   * did up to the branch and nothing after it.
   */
  z.object({
    type: z.literal("room.forked"),
    checkpointId: z.string(),
    label: z.string(),
    /** The room created. `fromRoomId` on the event in the *new* room's log. */
    toRoomId: z.string().optional(),
    fromRoomId: z.string().optional(),
    /** Log position the branch was taken at: the new room holds seq < this. */
    atSeq: z.number().int(),
    /** The forked SDK session, or null when branching from before any turn. */
    sessionId: z.string().nullable(),
  }),
]);
export type EventBody = z.infer<typeof EventBody>;

/** What publishers send: a body plus who caused it. */
export const EventDraft = z.object({
  actor: Actor,
  body: EventBody,
});
export type EventDraft = z.infer<typeof EventDraft>;

/** What the relay stores and broadcasts. */
export const SessionEvent = z.object({
  seq: z.number().int().nonnegative(),
  roomId: z.string(),
  ts: z.number().int(),
  actor: Actor,
  body: EventBody,
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export type EventType = EventBody["type"];

/** Narrow a SessionEvent to a specific body type, keeping envelope fields. */
export function isEvent<T extends EventType>(
  event: SessionEvent,
  type: T,
): event is SessionEvent & { body: Extract<EventBody, { type: T }> } {
  return event.body.type === type;
}
