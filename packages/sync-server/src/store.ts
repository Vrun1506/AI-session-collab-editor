import { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@mpa/protocol";

/**
 * Durable home for the shared log.
 *
 * The log is the product, so losing it on a process restart is not an
 * acceptable failure mode. Storage sits behind this interface so `Room` keeps
 * owning ordering semantics while remaining testable without a database, and
 * so the SQLite implementation can later be swapped for Postgres when rooms
 * outgrow one machine.
 */
export interface EventStore {
  append(event: SessionEvent): void;
  /** Events strictly after `sinceSeq`; pass -1 for the whole history. */
  since(roomId: string, sinceSeq: number): SessionEvent[];
  latestSeq(roomId: string): number;
  listRooms(): string[];
  /** The Agent SDK session backing a room, so context survives a restart. */
  getAgentSessionId(roomId: string): string | null;
  setAgentSessionId(roomId: string, sessionId: string): void;
  /**
   * Copy `from`'s history below `uptoSeq` into `to`, for a session fork.
   *
   * Sequence numbers are carried over rather than renumbered, so the two logs
   * agree about the shared prefix and a checkpoint means the same thing in
   * both. Refuses a target that already has events: a fork that silently
   * interleaved itself with an existing room's log would be unrecoverable.
   *
   * @returns how many events were copied
   */
  copyRoom(from: string, to: string, uptoSeq: number): number;
  close(): void;
}

export class MemoryEventStore implements EventStore {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly agentSessions = new Map<string, string>();

  private bucket(roomId: string): SessionEvent[] {
    let list = this.events.get(roomId);
    if (!list) {
      list = [];
      this.events.set(roomId, list);
    }
    return list;
  }

  append(event: SessionEvent): void {
    this.bucket(event.roomId).push(event);
  }

  since(roomId: string, sinceSeq: number): SessionEvent[] {
    const list = this.bucket(roomId);
    if (sinceSeq < 0) return [...list];
    return list.filter((e) => e.seq > sinceSeq);
  }

  latestSeq(roomId: string): number {
    const list = this.bucket(roomId);
    return list.length === 0 ? -1 : list[list.length - 1]!.seq;
  }

  listRooms(): string[] {
    return [...this.events.keys()];
  }

  getAgentSessionId(roomId: string): string | null {
    return this.agentSessions.get(roomId) ?? null;
  }

  setAgentSessionId(roomId: string, sessionId: string): void {
    this.agentSessions.set(roomId, sessionId);
  }

  copyRoom(from: string, to: string, uptoSeq: number): number {
    if (this.bucket(to).length > 0) {
      throw new Error(`room ${to} already has history`);
    }
    const copied = this.bucket(from)
      .filter((e) => e.seq < uptoSeq)
      .map((e) => ({ ...e, roomId: to }));
    this.events.set(to, copied);
    return copied.length;
  }

  close(): void {}
}

export class SqliteEventStore implements EventStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL lets readers proceed during writes, which matters because every
    // token delta is an append while clients may be replaying history.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        room_id TEXT    NOT NULL,
        seq     INTEGER NOT NULL,
        ts      INTEGER NOT NULL,
        actor   TEXT    NOT NULL,
        body    TEXT    NOT NULL,
        PRIMARY KEY (room_id, seq)
      );
      CREATE TABLE IF NOT EXISTS rooms (
        room_id          TEXT PRIMARY KEY,
        agent_session_id TEXT,
        updated_at       INTEGER NOT NULL
      );
    `);
  }

  append(event: SessionEvent): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO events (room_id, seq, ts, actor, body) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.roomId,
        event.seq,
        event.ts,
        JSON.stringify(event.actor),
        JSON.stringify(event.body),
      );
  }

  since(roomId: string, sinceSeq: number): SessionEvent[] {
    const rows = this.db
      .prepare(
        "SELECT room_id, seq, ts, actor, body FROM events WHERE room_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(roomId, sinceSeq < 0 ? -1 : sinceSeq) as Array<{
      room_id: string;
      seq: number;
      ts: number;
      actor: string;
      body: string;
    }>;

    return rows.map((row) => ({
      seq: row.seq,
      roomId: row.room_id,
      ts: row.ts,
      actor: JSON.parse(row.actor),
      body: JSON.parse(row.body),
    }));
  }

  latestSeq(roomId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS maxSeq FROM events WHERE room_id = ?")
      .get(roomId) as { maxSeq: number | null } | undefined;
    return row?.maxSeq ?? -1;
  }

  listRooms(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT room_id FROM events")
      .all() as Array<{ room_id: string }>;
    return rows.map((r) => r.room_id);
  }

  getAgentSessionId(roomId: string): string | null {
    const row = this.db
      .prepare("SELECT agent_session_id FROM rooms WHERE room_id = ?")
      .get(roomId) as { agent_session_id: string | null } | undefined;
    return row?.agent_session_id ?? null;
  }

  setAgentSessionId(roomId: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO rooms (room_id, agent_session_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET agent_session_id = excluded.agent_session_id,
                                            updated_at = excluded.updated_at`,
      )
      .run(roomId, sessionId, Date.now());
  }

  copyRoom(from: string, to: string, uptoSeq: number): number {
    if (this.latestSeq(to) >= 0) {
      throw new Error(`room ${to} already has history`);
    }
    // One statement, so a fork either lands whole or not at all — a half-copied
    // log would be a room whose history stops mid-turn with no way to tell.
    const result = this.db
      .prepare(
        `INSERT INTO events (room_id, seq, ts, actor, body)
         SELECT ?, seq, ts, actor, body FROM events
         WHERE room_id = ? AND seq < ?`,
      )
      .run(to, from, uptoSeq);
    return Number(result.changes ?? 0);
  }

  close(): void {
    this.db.close();
  }
}
