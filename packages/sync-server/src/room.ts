import type {
  EventDraft,
  Participant,
  SessionEvent,
} from "@mpa/protocol";
import { MemoryEventStore, type EventStore } from "./store.js";

/**
 * Room state, kept free of any transport concerns so the ordering and replay
 * rules can be unit tested directly. The relay owns `seq`: it is assigned here
 * and nowhere else, which is what guarantees every peer folds the same log in
 * the same order.
 *
 * Events go to an `EventStore`; the default is in-memory so tests need no
 * database, while the relay passes a SQLite-backed one so a restart does not
 * destroy the session. Participants deliberately stay in memory — presence is
 * ephemeral and should not survive a restart.
 */
export class Room {
  readonly id: string;
  private readonly store: EventStore;
  private nextSeq: number;
  private readonly participants = new Map<string, Participant>();

  constructor(id: string, store: EventStore = new MemoryEventStore()) {
    this.id = id;
    this.store = store;
    // Continue the numbering of whatever history already exists on disk, so
    // sequence numbers stay unique and monotonic across restarts.
    this.nextSeq = store.latestSeq(id) + 1;
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
    return event;
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

  /** Exactly one agent-host may serve a room. */
  hasAgentHost(): boolean {
    return this.listParticipants().some((p) => p.role === "agent-host");
  }

  isEmpty(): boolean {
    return this.participants.size === 0;
  }
}
