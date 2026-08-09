import type {
  EventDraft,
  Identity,
  Participant,
  SessionEvent,
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
    }
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
   */
  compactedSince(sinceSeq: number): SessionEvent[] {
    const events = this.since(sinceSeq);

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
