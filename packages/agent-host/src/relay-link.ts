import WebSocket from "ws";
import {
  decodeServer,
  encode,
  type ClientMessage,
  type EventBody,
  type EventDraft,
  type ServerMessage,
} from "@mpa/protocol";

const RETRY_DELAYS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * Events produced while the relay is unreachable.
 *
 * The log is the product, so silently dropping a turn's output because a socket
 * blipped is not acceptable. The cap exists because an agent mid-answer will
 * happily outproduce a relay that never comes back; oldest first, since a
 * dropped delta is superseded by the `assistant.message` that follows it.
 */
const OUTBOX_LIMIT = 5_000;

export interface RelayLinkOptions {
  url: string;
  roomId: string;
  /** Workspace root, so the relay can resolve the paths a tool asks to write. */
  cwd: string;
  token: string | undefined;
  /** Every decoded frame, after any offline backlog has been flushed. */
  onMessage(msg: ServerMessage): void;
  /** Called on each (re)connect, for state that must survive a relay restart. */
  onConnected(first: boolean): void;
}

/**
 * The agent-host's one connection to the relay.
 *
 * Owning the socket, the retry schedule and the offline outbox in one place
 * keeps the rest of the process from having to know whether the relay is
 * currently reachable — it publishes, and this either sends or holds.
 *
 * The shared agent must outlive a relay restart. The SDK query is untouched by
 * a dropped socket, so recovery is only a matter of getting the transcript
 * flowing again.
 */
export class RelayLink {
  private socket: WebSocket | undefined;
  private readonly outbox: ClientMessage[] = [];
  private retries = 0;
  private connectedOnce = false;
  private closing = false;

  constructor(private readonly options: RelayLinkOptions) {}

  get shuttingDown(): boolean {
    return this.closing;
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encode(msg));
      return;
    }
    if (this.outbox.length >= OUTBOX_LIMIT) this.outbox.shift();
    this.outbox.push(msg);
  }

  /**
   * Deltas are forwarded as they arrive.
   *
   * A buffering layer was tried here and removed: measured against this SDK, a
   * ~1,350-character answer arrives as about five `content_block_delta` chunks
   * of ~260 characters each, not as per-token events. Coalescing produced
   * exactly the same frame count while adding up to 60ms of latency. If a
   * future model or provider does stream per token, re-add it —
   * `tools/count-frames.mjs` is how to tell.
   */
  publish(body: EventBody): void {
    this.send({ type: "publish", draft: { actor: { kind: "agent" }, body } });
  }

  /**
   * Publish something the agent did on somebody else's instruction.
   *
   * A rewind is carried out by this process but decided by a person, and an
   * audit log that credits the agent with having rewound itself is describing a
   * different event from the one that happened.
   */
  publishAs(actor: EventDraft["actor"], body: EventBody): void {
    this.send({ type: "publish", draft: { actor, body } });
  }

  connect(): void {
    const ws = new WebSocket(this.options.url);
    this.socket = ws;

    ws.on("open", () => {
      this.retries = 0;
      ws.send(
        encode({
          type: "hello",
          roomId: this.options.roomId,
          userId: "agent-host",
          name: "Agent",
          role: "agent-host",
          // The host does not replay history; the editors are the readers.
          sinceSeq: Number.MAX_SAFE_INTEGER,
          cwd: this.options.cwd,
          ...(this.options.token ? { token: this.options.token } : {}),
        }),
      );
    });

    ws.on("message", (raw) => {
      const msg = decodeServer(raw.toString());
      if (!msg) return;

      if (msg.type === "welcome") {
        // Flush anything produced while offline before anything new lands, so
        // the room's ordering matches the order the agent actually spoke in.
        const backlog = this.outbox.splice(0, this.outbox.length);
        for (const queued of backlog) this.send(queued);

        const first = !this.connectedOnce;
        this.connectedOnce = true;
        this.options.onConnected(first);
      }

      this.options.onMessage(msg);
    });

    ws.on("close", () => {
      if (this.closing) return;
      const delay =
        RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)]!;
      this.retries++;
      console.log(
        `[agent-host] relay unreachable, retrying in ${delay}ms (attempt ${this.retries})`,
      );
      setTimeout(() => this.connect(), delay).unref?.();
    });

    ws.on("error", (err) => {
      console.error("[agent-host] socket error:", err.message);
    });
  }

  close(): void {
    this.closing = true;
    this.socket?.close();
  }
}
