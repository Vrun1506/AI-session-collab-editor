import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import {
  decodeServer,
  encode,
  type ClientMessage,
  type Participant,
  type SessionEvent,
} from "@mpa/protocol";

export interface SessionHandlers {
  onEvent(event: SessionEvent, replay: boolean): void;
  onParticipants(participants: Participant[]): void;
  onStatus(text: string): void;
  /** Who the relay thinks we are — the panel needs it to know whether the
   *  driver token in the folded log is ours. */
  onIdentity(you: Participant): void;
}

export interface SessionConfig {
  relayUrl: string;
  roomId: string;
  userId: string;
  name: string;
  /** Host mode spawns the agent-host; join mode attaches to an existing one. */
  host: boolean;
  agentHostEntry: string;
  workspaceDir: string;
  allowedTools: string;
  disallowedTools: string;
  /** Surfaced loudly, unlike `onStatus` — a shared agent that never started is
   *  not something to leave in a status line. */
  onFatal(message: string): void;
}

/**
 * A participant's connection to one shared room.
 *
 * In host mode this also owns the agent-host child process. That is the only
 * asymmetry between host and guest — everything else goes through the relay,
 * which is what keeps the cloud-sandbox migration a matter of not spawning
 * this child.
 */
/** Backoff schedule for reconnection, in milliseconds. */
const RETRY_DELAYS = [500, 1_000, 2_000, 4_000, 8_000];

export class RoomSession {
  private socket: WebSocket | undefined;
  private child: ChildProcess | undefined;
  private disposed = false;
  private retries = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  /**
   * Highest sequence number seen. Used as the replay cursor on reconnect so
   * only the missed tail comes back rather than the whole session.
   */
  private lastSeq = -1;

  constructor(
    private readonly config: SessionConfig,
    private readonly handlers: SessionHandlers,
  ) {}

  start(): void {
    if (this.config.host) this.spawnAgentHost();
    this.connect();
  }

  private spawnAgentHost(): void {
    // ELECTRON_RUN_AS_NODE lets us reuse VS Code's bundled Node rather than
    // depending on whatever `node` happens to be on PATH.
    //
    // Detached, because the shared agent must not die with the window that
    // happened to start it — closing a tab should never end everyone else's
    // session. The relay is the only thing the agent-host really belongs to.
    const startedAt = Date.now();
    this.child = spawn(process.execPath, [this.config.agentHostEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MPA_ROOM: this.config.roomId,
        MPA_CWD: this.config.workspaceDir,
        MPA_RELAY_URL: this.config.relayUrl,
        MPA_ALLOWED_TOOLS: this.config.allowedTools,
        MPA_DISALLOWED_TOOLS: this.config.disallowedTools,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    this.child.unref();

    // Keep the last thing it said, so an early death can explain itself.
    let lastError = "";
    this.child.stdout?.on("data", (d: Buffer) =>
      this.handlers.onStatus(d.toString().trim()),
    );
    this.child.stderr?.on("data", (d: Buffer) => {
      lastError = d.toString().trim();
      this.handlers.onStatus(`agent-host: ${lastError}`);
    });
    this.child.on("error", (err) =>
      this.config.onFatal(`Could not start the shared agent: ${err.message}`),
    );
    this.child.on("exit", (code) => {
      this.handlers.onStatus(`agent-host exited (${code})`);
      // A clean exit long after startup is someone stopping the agent. Dying
      // in the first few seconds means it never ran, and that used to show up
      // only as a puzzling "no agent-host connected" when you tried to prompt.
      if (code !== 0 && Date.now() - startedAt < 5_000) {
        this.config.onFatal(
          `The shared agent exited immediately (code ${code}). ${lastError}`.trim(),
        );
      }
    });
  }

  private connect(): void {
    const socket = new WebSocket(this.config.relayUrl);
    this.socket = socket;

    socket.on("open", () => {
      const resuming = this.lastSeq >= 0;
      this.retries = 0;
      this.send({
        type: "hello",
        roomId: this.config.roomId,
        userId: this.config.userId,
        name: this.config.name,
        role: "editor",
        // First connect replays everything; a reconnect asks only for what it
        // missed while offline.
        sinceSeq: this.lastSeq,
      });
      if (resuming) this.handlers.onStatus("reconnected — catching up");
    });

    socket.on("message", (raw: Buffer) => {
      const msg = decodeServer(raw.toString());
      if (!msg) return;
      switch (msg.type) {
        case "welcome":
          this.handlers.onIdentity(msg.you);
          this.handlers.onStatus(
            `joined ${msg.roomId} — replayed ${msg.backlog.length} events`,
          );
          // Replay first so a late joiner reconstructs history before live
          // events land on top.
          for (const event of msg.backlog) {
            this.trackSeq(event.seq);
            this.handlers.onEvent(event, true);
          }
          this.handlers.onParticipants(msg.participants);
          break;
        case "event":
          this.trackSeq(msg.event.seq);
          this.handlers.onEvent(msg.event, false);
          break;
        case "participants":
          this.handlers.onParticipants(msg.participants);
          break;
        case "error":
          this.handlers.onStatus(`relay error: ${msg.message}`);
          break;
      }
    });

    socket.on("error", (err: Error) =>
      this.handlers.onStatus(`socket error: ${err.message}`),
    );
    socket.on("close", () => {
      if (this.disposed) return;
      this.scheduleReconnect();
    });
  }

  private trackSeq(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq;
  }

  /**
   * Reconnect with backoff. A dropped socket used to leave the panel silently
   * dead; because the relay is the ordering authority and the log is durable,
   * recovery is just rejoining with the right cursor.
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer) return;

    const delay =
      RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)]!;
    this.retries++;
    this.handlers.onStatus(
      `disconnected — reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.retries})`,
    );

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.disposed) this.connect();
    }, delay);
  }

  private send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encode(msg));
    }
  }

  /**
   * Send text to the room. Whether this becomes a prompt or a queued
   * suggestion is the relay's call, not ours — see the wire protocol.
   */
  submitPrompt(text: string): void {
    this.send({ type: "submitPrompt", text });
  }

  interrupt(): void {
    this.send({ type: "interrupt" });
  }

  requestDriver(): void {
    this.send({ type: "requestDriver" });
  }

  grantDriver(userId: string): void {
    this.send({ type: "grantDriver", userId });
  }

  releaseDriver(): void {
    this.send({ type: "releaseDriver" });
  }

  promoteSuggestion(suggestionId: string): void {
    this.send({ type: "promoteSuggestion", suggestionId });
  }

  dismissSuggestion(suggestionId: string): void {
    this.send({ type: "dismissSuggestion", suggestionId });
  }

  decideApproval(requestId: string, allow: boolean, reason?: string): void {
    this.send({
      type: "decideApproval",
      requestId,
      allow,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Leaves the room. Deliberately does NOT kill the agent-host: the session
   * outlives any single participant, so other people keep working and this
   * window can rejoin later. Use `stopAgent()` to end it for everyone.
   */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.socket?.close();
  }

  /** Ends the shared session for everyone in the room. */
  stopAgent(): void {
    this.child?.kill();
  }
}
