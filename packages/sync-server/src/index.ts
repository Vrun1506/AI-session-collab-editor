import { WebSocketServer } from "ws";
import { DEFAULT_RELAY_PORT } from "@mpa/protocol";
import { authenticatorFromEnv, tokenFilePath } from "./auth.js";
import { connOf } from "./relay/conn.js";
import { RelayContext } from "./relay/context.js";
import { dispatch } from "./relay/dispatch.js";
import { onDisconnect } from "./relay/session.js";
import { MemoryEventStore, SqliteEventStore, type EventStore } from "./store.js";

/**
 * The relay process: configuration, a socket server, and nothing else.
 *
 * All of the behaviour lives in `relay/`, as plain functions over a
 * `RelayContext`. That split is what makes the relay testable — this file is
 * the only part that needs a network, and it holds no decisions worth testing.
 */

// `:memory:` keeps the old ephemeral behaviour for throwaway runs and tests.
const dbPath = process.env.MPA_DB ?? "mpa-sessions.db";
const store: EventStore =
  dbPath === ":memory:" ? new MemoryEventStore() : new SqliteEventStore(dbPath);

const ctx = new RelayContext({
  store,
  authenticator: authenticatorFromEnv(),
  config: {
    /**
     * How long a driver may go without doing anything before someone else can
     * take the token without asking. The token exists to stop two people
     * talking over each other, not to let one person lock the room by walking
     * away.
     */
    driverIdleMs: Number(process.env.MPA_DRIVER_IDLE_MS ?? 120_000),
    /**
     * How long the agent waits for editors to write their buffers to disk
     * before it reads a file. Saving is local and fast; the deadline only
     * exists so one wedged editor cannot stall the whole session.
     */
    flushTimeoutMs: Number(process.env.MPA_FLUSH_TIMEOUT_MS ?? 2_000),
    /**
     * Backstop for a document left marked as "the agent is writing this". The
     * lock is normally released when the write is reported; a tool that fails
     * outright never reports one, and a permanently locked document would
     * quietly stop accepting its holder's keystrokes.
     */
    writeLockTimeoutMs: Number(process.env.MPA_WRITE_LOCK_TIMEOUT_MS ?? 60_000),
    /** How long a path stays marked "being written", to cover a late reload. */
    writeGraceMs: Number(process.env.MPA_WRITE_GRACE_MS ?? 1_500),
  },
});

const port = Number(process.env.MPA_RELAY_PORT ?? DEFAULT_RELAY_PORT);

/**
 * Loopback unless someone deliberately opens it up.
 *
 * `ws` binds every interface by default, which put an unauthenticated socket on
 * the local network — and through it, an agent that can write files and run
 * shell commands on this machine. That was survivable while the agent was
 * read-only. It is not now.
 *
 * Set `MPA_HOST=0.0.0.0` to share a room across machines, and read the auth
 * section of the README before doing so.
 */
const host = process.env.MPA_HOST ?? "127.0.0.1";
const wss = new WebSocketServer({ port, host });

wss.on("connection", (socket) => {
  const conn = connOf(socket);

  socket.on("message", (raw) => dispatch(ctx, conn, raw.toString()));
  socket.on("close", () => onDisconnect(ctx, conn));
  socket.on("error", (err) => {
    console.error("[relay] socket error:", err.message);
  });
});

wss.on("listening", () => {
  console.log(`[relay] listening on ws://${host}:${port}`);
  console.log(
    `[relay] auth: ${ctx.authenticator.describe()} — ${tokenFilePath()}`,
  );
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.warn(
      `[relay] WARNING: reachable from the network on ${host}:${port}. ` +
        "Anyone who can connect can drive an agent that writes files and runs " +
        "commands on the agent-host's machine.",
    );
  }
});
