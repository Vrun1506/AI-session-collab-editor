import {
  encode,
  type ClientMessage,
  type EventDraft,
  type Identity,
  type Participant,
  type ServerMessage,
} from "@mpa/protocol";
import type { Authenticator } from "../auth.js";
import { DocHub } from "../docs.js";
import { Room } from "../room.js";
import type { EventStore } from "../store.js";
import { DirtyBufferIndex } from "../writes.js";
import type { Conn } from "./conn.js";

/** A connected peer: one editor window, or the room's single agent-host. */
export interface Peer {
  conn: Conn;
  roomId: string;
  participant: Participant;
}

/**
 * One arm of the client message union, by name.
 *
 * Handlers take these rather than hand-written parameter shapes so the wire
 * schema stays the single source of truth — a field going optional in
 * `wire.ts` then shows up as a compile error in the handler that reads it,
 * instead of as `undefined` at runtime.
 */
export type Msg<T extends ClientMessage["type"]> = Extract<
  ClientMessage,
  { type: T }
>;

/**
 * Timings the relay is built around. Gathered into one object so a test can run
 * with a 10ms deadline where production runs with 2s, instead of every handler
 * reading `process.env` at import time.
 */
export interface RelayConfig {
  driverIdleMs: number;
  flushTimeoutMs: number;
  writeLockTimeoutMs: number;
  writeGraceMs: number;
}

export const DEFAULT_CONFIG: RelayConfig = {
  driverIdleMs: 120_000,
  flushTimeoutMs: 2_000,
  writeLockTimeoutMs: 60_000,
  writeGraceMs: 1_500,
};

/** A "make disk tell the truth" round trip the agent is suspended inside. */
export interface PendingFlush {
  roomId: string;
  conn: Conn;
  /** Outstanding `userId\0path` acknowledgements. */
  waiting: Set<string>;
  timer: NodeJS.Timeout;
}

/**
 * Everything the relay knows, and the handful of primitives every handler
 * needs.
 *
 * This exists because the relay's state used to be a dozen module-level `Map`s.
 * That is fine until you want to test a handler, at which point there is no way
 * to construct a relay with two peers in a known state — the only entry point
 * is a live WebSocket server. Handlers are now plain functions over this
 * object, so a test builds one, feeds it messages and reads what came back.
 *
 * It deliberately holds *state and plumbing only*. Every actual decision —
 * who may drive, what a rewind supersedes, whether a write would destroy
 * somebody's work — lives in a handler module or, better, in `policy.ts` and
 * `room.ts` where it can be read without any of this.
 */
export class RelayContext {
  readonly store: EventStore;
  readonly authenticator: Authenticator;
  readonly config: RelayConfig;

  readonly docs = new DocHub();
  readonly dirtyBuffers = new DirtyBufferIndex();

  private readonly rooms = new Map<string, Room>();
  private readonly peers = new Map<Conn, Peer>();

  /** Workspace root per room, reported by the agent-host on hello. */
  readonly roomCwd = new Map<string, string>();

  /**
   * Forks awaiting the agent-host's answer, so the resulting `room.forked` is
   * attributed to whoever asked rather than to the process that carried it out.
   */
  readonly pendingForks = new Map<string, Identity>();

  /** Auto-release timers for `docLock`, keyed room + path. */
  readonly lockTimers = new Map<string, NodeJS.Timeout>();
  readonly flushes = new Map<string, PendingFlush>();

  /** Swapped out in tests so a run does not print a session's worth of noise. */
  log: (message: string) => void = (message) => console.log(message);
  warn: (message: string) => void = (message) => console.warn(message);

  constructor(options: {
    store: EventStore;
    authenticator: Authenticator;
    config?: Partial<RelayConfig>;
  }) {
    this.store = options.store;
    this.authenticator = options.authenticator;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
  }

  // ---- rooms ---------------------------------------------------------------

  getRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      // Constructing a Room replays the stored log: sequence numbering, the
      // driver token, the suggestion queue, undecided approvals and the
      // checkpoint list all come back with it.
      room = new Room(roomId, this.store);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Whether a room is already live in memory — distinct from having history. */
  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  // ---- peers ---------------------------------------------------------------

  peerFor(conn: Conn): Peer | undefined {
    return this.peers.get(conn);
  }

  addPeer(peer: Peer): void {
    this.peers.set(peer.conn, peer);
    this.getRoom(peer.roomId).addParticipant(peer.participant);
  }

  removePeer(conn: Conn): Peer | undefined {
    const peer = this.peers.get(conn);
    if (peer) this.peers.delete(conn);
    return peer;
  }

  peersIn(roomId: string): Peer[] {
    return [...this.peers.values()].filter((p) => p.roomId === roomId);
  }

  agentHostIn(roomId: string): Peer | undefined {
    return this.peersIn(roomId).find((p) => p.participant.role === "agent-host");
  }

  /** Display name for a user id, falling back to the id itself. */
  nameOf(roomId: string, userId: string): string {
    return (
      this.getRoom(roomId)
        .listParticipants()
        .find((p) => p.userId === userId)?.name ?? userId
    );
  }

  // ---- messaging -----------------------------------------------------------

  send(conn: Conn, msg: ServerMessage): void {
    if (conn.open) conn.send(encode(msg));
  }

  refuse(conn: Conn, message: string): void {
    this.send(conn, { type: "error", message });
  }

  /**
   * Append to the room log and fan out to every peer, including the publisher,
   * so all clients converge on the relay's ordering rather than on optimistic
   * local guesses.
   */
  publish(roomId: string, draft: EventDraft): void {
    const event = this.getRoom(roomId).append(draft);
    for (const peer of this.peersIn(roomId)) {
      this.send(peer.conn, { type: "event", event });
    }
  }

  broadcastParticipants(roomId: string): void {
    const participants = this.getRoom(roomId).listParticipants();
    for (const peer of this.peersIn(roomId)) {
      this.send(peer.conn, { type: "participants", participants });
    }
  }
}

export function identityOf(peer: Peer): Identity {
  return { userId: peer.participant.userId, name: peer.participant.name };
}
