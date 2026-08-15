import {
  isSuperseded,
  withinRange,
  type EventDraft,
  type Identity,
  type Participant,
  type SessionEvent,
  type SupersededRange,
} from "@mpa/protocol";
import { MemoryEventStore, type EventStore } from "./store.js";

/** A suggestion waiting for the driver to run or dismiss it. */
export interface Suggestion {
  suggestionId: string;
  text: string;
  author: Identity;
  ts: number;
}

/** A tool call suspended inside the agent's `canUseTool`, awaiting a decision. */
export interface Approval {
  requestId: string;
  toolName: string;
  input: unknown;
  turnId: string | null;
  decision: { allow: boolean; reason?: string } | null;
}

/**
 * A point the room can be taken back to, or branched from.
 *
 * `fromSeq` is where the turn began in our log and `userMessageId`/`resumeAt`
 * are where it began in the SDK's. Holding both is the whole job: a rewind has
 * to move the transcript, the files and the agent's memory together, and no two
 * of those three are addressed the same way.
 */
export interface Checkpoint {
  checkpointId: string;
  /** Seq of the `checkpoint.created` event itself. */
  seq: number;
  /** Seq of the prompt that opened the turn — the first thing a rewind hides. */
  fromSeq: number;
  turnId: string | null;
  label: string;
  userMessageId: string;
  resumeAt: string | null;
  ts: number;
}


/**
 * Room state, kept free of any transport concerns so the ordering and replay
 * rules can be unit tested directly. The relay owns `seq`: it is assigned here
 * and nowhere else, which is what guarantees every peer folds the same log in
 * the same order.
 *
 * Events go to an `EventStore`; the default is in-memory so tests need no
 * database, while the relay passes a SQLite-backed one so a restart does not
 * destroy the session.
 *
 * Everything the relay arbitrates — who is driving, what is queued, what is
 * awaiting approval — is *derived by folding the log*, never stored alongside
 * it. That is why it all survives a restart for free, and why the answer to
 * "who approved that write?" is always in the transcript. Participants are the
 * one exception: presence is a property of live sockets, not of history.
 */
export class Room {
  readonly id: string;
  private readonly store: EventStore;
  private nextSeq: number;
  private readonly participants = new Map<string, Participant>();

  // ---- derived state, rebuilt from the log on construction ----------------
  private driverId: Identity | null = null;
  private readonly driverQueue: Identity[] = [];
  private readonly suggestions = new Map<string, Suggestion>();
  private readonly approvals = new Map<string, Approval>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  /** promptId -> the seq it was logged at, so a checkpoint can find its turn. */
  private readonly promptSeq = new Map<string, number>();
  private readonly superseded: SupersededRange[] = [];
  /** The turn currently running, if any. Rewinding across one is refused. */
  private openTurn: string | null = null;

  /**
   * When the driver last did something that only a driver can do. In memory on
   * purpose: after a restart nobody is connected, and the "driver is offline"
   * rule already covers that case more directly than a stale timestamp would.
   */
  private driverActiveAt = 0;

  constructor(id: string, store: EventStore = new MemoryEventStore()) {
    this.id = id;
    this.store = store;
    // Continue the numbering of whatever history already exists on disk, so
    // sequence numbers stay unique and monotonic across restarts.
    this.nextSeq = store.latestSeq(id) + 1;
    for (const event of store.since(id, -1)) this.fold(event);
  }

  /** Stamp a draft with the next sequence number and record it durably. */
  append(draft: EventDraft): SessionEvent {
    const event: SessionEvent = {
      seq: this.nextSeq++,
      roomId: this.id,
      ts: Date.now(),
      actor: draft.actor,
      body: draft.body,
    };
    this.store.append(event);
    // Fold on the way out so the relay's view and a client's view of the same
    // log can never disagree — there is only one reducer.
    this.fold(event);
    return event;
  }

  /** The single reducer. Runs over replayed history and new events alike. */
  private fold(event: SessionEvent): void {
    const b = event.body;
    switch (b.type) {
      case "driver.granted": {
        this.driverId = { userId: b.userId, name: b.name };
        this.dropRequest(b.userId);
        this.driverActiveAt = Date.now();
        break;
      }
      case "driver.released": {
        if (this.driverId?.userId === b.userId) this.driverId = null;
        break;
      }
      case "driver.requested": {
        if (!this.driverQueue.some((r) => r.userId === b.userId)) {
          this.driverQueue.push({ userId: b.userId, name: b.name });
        }
        break;
      }
      case "suggestion.queued": {
        // The author is the actor, which is the whole point: promotion later
        // credits them rather than whoever held the token.
        const author: Identity =
          event.actor.kind === "user"
            ? { userId: event.actor.userId, name: event.actor.name }
            : { userId: "unknown", name: "unknown" };
        this.suggestions.set(b.suggestionId, {
          suggestionId: b.suggestionId,
          text: b.text,
          author,
          ts: event.ts,
        });
        break;
      }
      case "suggestion.promoted":
      case "suggestion.dismissed": {
        this.suggestions.delete(b.suggestionId);
        break;
      }
      case "tool.approval.requested": {
        if (!this.approvals.has(b.requestId)) {
          this.approvals.set(b.requestId, {
            requestId: b.requestId,
            toolName: b.toolName,
            input: b.input,
            turnId: b.turnId,
            decision: null,
          });
        }
        break;
      }
      case "tool.approval.decided": {
        const pending = this.approvals.get(b.requestId);
        if (pending) {
          pending.decision = { allow: b.allow, reason: b.reason };
        }
        break;
      }

      // ---- checkpoints (M4) ------------------------------------------------
      case "prompt.submitted": {
        this.promptSeq.set(b.promptId, event.seq);
        break;
      }
      case "turn.started": {
        this.openTurn = b.turnId;
        break;
      }
      case "turn.completed":
      case "turn.interrupted": {
        if (this.openTurn === b.turnId) this.openTurn = null;
        break;
      }
      case "checkpoint.created": {
        // A rewind undoes the whole turn, prompt included, so the checkpoint
        // starts at the prompt rather than at itself. Falling back to its own
        // seq keeps a checkpoint usable if the prompt somehow never landed.
        const fromSeq =
          (b.promptId !== null ? this.promptSeq.get(b.promptId) : undefined) ??
          event.seq;
        this.checkpoints.set(b.checkpointId, {
          checkpointId: b.checkpointId,
          seq: event.seq,
          fromSeq,
          turnId: b.turnId,
          label: b.label,
          userMessageId: b.userMessageId,
          resumeAt: b.resumeAt,
          ts: event.ts,
        });
        break;
      }
      case "checkpoint.restored": {
        // Nothing is removed from the log; a range of it stops counting.
        this.superseded.push({ fromSeq: b.fromSeq, toSeq: event.seq });
        // Checkpoints inside that range describe turns the room has abandoned.
        // Leaving them on offer would let someone rewind to a point that no
        // longer exists in the transcript they are looking at.
        const abandoned = { fromSeq: b.fromSeq, toSeq: event.seq };
        for (const [id, cp] of this.checkpoints) {
          if (withinRange(abandoned, cp.seq)) this.checkpoints.delete(id);
        }
        // A rewind ends whatever turn was open; the query it belonged to is
        // gone, so nothing will ever complete it.
        this.openTurn = null;
        break;
      }
    }
  }

  /** Whether a rewind has left this event behind. */
  isSuperseded(seq: number): boolean {
    return isSuperseded(this.superseded, seq);
  }

  /**
   * Everything strictly after `sinceSeq`. Pass -1 for the full history, which
   * is how a late joiner reconstructs the session from nothing.
   */
  since(sinceSeq: number): SessionEvent[] {
    return this.store.since(this.id, sinceSeq);
  }

  /**
   * Replay history with superseded token deltas removed.
   *
   * `assistant.message` carries the authoritative final text for a message, so
   * every delta that built it up is redundant once it arrives. Replaying them
   * costs a late joiner thousands of events and renders the identical result.
   * Deltas for a message that is still streaming are kept, so someone joining
   * mid-turn still sees partial text.
   *
   * Sequence numbers are preserved on the events that survive, so clients that
   * dedupe on `seq` are unaffected by the gaps.
   *
   * Ranges a rewind superseded are dropped here too, so a late joiner is never
   * sent a turn the room has already taken back. Someone who was present sees
   * that turn and then watches it disappear when `checkpoint.restored` arrives;
   * both end up rendering the same thing, which is the property that makes one
   * reducer over one log worth having. `since()` stays raw — the audit export
   * is precisely the reader that must still see what was abandoned.
   */
  compactedSince(sinceSeq: number): SessionEvent[] {
    const events = this.since(sinceSeq).filter(
      (event) => !this.isSuperseded(event.seq),
    );

    const finalized = new Set<string>();
    for (const event of events) {
      const body = event.body;
      if (body.type === "assistant.message") finalized.add(body.messageId);
    }
    if (finalized.size === 0) return events;

    return events.filter((event) => {
      const body = event.body;
      if (body.type !== "assistant.delta" && body.type !== "thinking.delta") {
        return true;
      }
      return !finalized.has(body.messageId);
    });
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  get size(): number {
    return this.nextSeq;
  }

  /** The Agent SDK session backing this room, if one has been recorded. */
  get agentSessionId(): string | null {
    return this.store.getAgentSessionId(this.id);
  }

  rememberAgentSession(sessionId: string): void {
    this.store.setAgentSessionId(this.id, sessionId);
  }

  // ---- driver token -------------------------------------------------------

  get driver(): Identity | null {
    return this.driverId;
  }

  isDriver(userId: string): boolean {
    return this.driverId?.userId === userId;
  }

  /** Records that the driver did something, for the idle-handoff rule. */
  markDriverActive(): void {
    this.driverActiveAt = Date.now();
  }

  driverIdleFor(): number {
    return Date.now() - this.driverActiveAt;
  }

  /** Requests waiting on the current driver, oldest first. */
  pendingDriverRequests(): Identity[] {
    return [...this.driverQueue];
  }

  dropRequest(userId: string): void {
    const at = this.driverQueue.findIndex((r) => r.userId === userId);
    if (at >= 0) this.driverQueue.splice(at, 1);
  }

  // ---- suggestions --------------------------------------------------------

  getSuggestion(suggestionId: string): Suggestion | undefined {
    return this.suggestions.get(suggestionId);
  }

  listSuggestions(): Suggestion[] {
    return [...this.suggestions.values()].sort((a, b) => a.ts - b.ts);
  }

  // ---- approvals ----------------------------------------------------------

  getApproval(requestId: string): Approval | undefined {
    return this.approvals.get(requestId);
  }

  listPendingApprovals(): Approval[] {
    return [...this.approvals.values()].filter((a) => a.decision === null);
  }

  // ---- checkpoints --------------------------------------------------------

  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /** Rewindable points, oldest first. */
  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => a.seq - b.seq);
  }

  /** The turn in flight, if any. Rewind and fork both refuse across one. */
  get openTurnId(): string | null {
    return this.openTurn;
  }

  // ---- presence -----------------------------------------------------------

  addParticipant(p: Participant): void {
    this.participants.set(p.userId, p);
  }

  removeParticipant(userId: string): Participant | undefined {
    const p = this.participants.get(userId);
    this.participants.delete(userId);
    return p;
  }

  listParticipants(): Participant[] {
    return [...this.participants.values()];
  }

  isConnected(userId: string): boolean {
    return this.participants.has(userId);
  }

  listEditors(): Participant[] {
    return this.listParticipants().filter((p) => p.role === "editor");
  }

  /** Exactly one agent-host may serve a room. */
  hasAgentHost(): boolean {
    return this.listParticipants().some((p) => p.role === "agent-host");
  }

  isEmpty(): boolean {
    return this.participants.size === 0;
  }
}
