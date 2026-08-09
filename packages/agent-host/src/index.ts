import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_RELAY_URL,
  decodeServer,
  encode,
  type ClientMessage,
  type EventBody,
} from "@mpa/protocol";
import { AsyncQueue } from "./queue.js";
import { TurnTranslator } from "./translate.js";

/**
 * Drives one shared agent session for one room.
 *
 * It connects only to the relay — never to an editor. That is the seam that
 * lets this same process later run inside a cloud sandbox with no client
 * change: the editors already talk to it exclusively through the shared log.
 */

const roomId = process.env.MPA_ROOM ?? "demo";
const relayUrl = process.env.MPA_RELAY_URL ?? DEFAULT_RELAY_URL;
const cwd = process.env.MPA_CWD ?? process.cwd();

const splitList = (v: string) =>
  v.split(",").map((t) => t.trim()).filter(Boolean);

const allowedTools = splitList(process.env.MPA_ALLOWED_TOOLS ?? "Read,Glob,Grep");

/**
 * `allowedTools` is an auto-approve list, NOT a restriction — anything absent
 * from it still runs once approved, and in M0 there is no approval surface yet.
 * Since a guest's prompt executes tools on the HOST's machine with the host's
 * credentials, the read-only guarantee has to come from an explicit deny list.
 *
 * Write tools land in M3 (once agent writes route through the shared document)
 * and Bash in M2 (once approvals exist), not before.
 */
const disallowedTools = splitList(
  process.env.MPA_DISALLOWED_TOOLS ??
    "Bash,BashOutput,KillShell,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch",
);

const socket = new WebSocket(relayUrl);
const prompts = new AsyncQueue<SDKUserMessage>();
const translator = new TurnTranslator();

function sendToRelay(msg: ClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encode(msg));
}

/**
 * Deltas are forwarded as they arrive.
 *
 * A buffering layer was tried here and removed: measured against this SDK, a
 * ~1,350-character answer arrives as about five `content_block_delta` chunks of
 * ~260 characters each, not as per-token events. Coalescing produced exactly
 * the same frame count while adding up to 60ms of latency. If a future model or
 * provider does stream per token, re-add it — `tools/count-frames.mjs` is how
 * to tell.
 */
function publish(body: EventBody): void {
  sendToRelay({ type: "publish", draft: { actor: { kind: "agent" }, body } });
}

socket.on("open", () => {
  sendToRelay({
    type: "hello",
    roomId,
    userId: "agent-host",
    name: "Agent",
    role: "agent-host",
    // The host does not replay history; the editors are the readers.
    sinceSeq: Number.MAX_SAFE_INTEGER,
  });
  publish({ type: "agent.status", state: "starting" });
  console.log(`[agent-host] room=${roomId} cwd=${cwd}`);
  void runAgentLoop();
});

socket.on("message", (raw) => {
  const msg = decodeServer(raw.toString());
  if (!msg) return;

  switch (msg.type) {
    case "runPrompt": {
      const turnId = randomUUID();
      translator.startTurn(turnId);
      publish({ type: "turn.started", turnId, promptId: msg.promptId });
      prompts.push({
        type: "user",
        message: { role: "user", content: msg.text },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage);
      break;
    }
    case "doInterrupt": {
      const turnId = translator.openTurnId;
      void activeQuery?.interrupt().catch((err: unknown) => {
        console.error("[agent-host] interrupt failed:", err);
      });
      if (turnId) {
        publish({ type: "turn.interrupted", turnId, byUserId: msg.byUserId });
      }
      break;
    }
    case "error": {
      console.error("[agent-host] relay error:", msg.message);
      break;
    }
  }
});

socket.on("close", () => {
  console.log("[agent-host] relay connection closed, shutting down");
  prompts.close();
  process.exit(0);
});

socket.on("error", (err) => {
  console.error("[agent-host] socket error:", err.message);
  process.exit(1);
});

let activeQuery: ReturnType<typeof query> | undefined;

async function runAgentLoop(): Promise<void> {
  try {
    activeQuery = query({
      prompt: prompts,
      options: {
        cwd,
        allowedTools,
        disallowedTools,
        // Streams tokens as they arrive so every participant watches the agent
        // think in real time — the whole point of M0.
        includePartialMessages: true,
      },
    });

    for await (const message of activeQuery) {
      for (const body of translator.translate(message)) {
        publish(body);
      }
    }
    publish({ type: "agent.status", state: "stopped" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[agent-host] agent loop failed:", detail);
    publish({ type: "agent.status", state: "error", detail });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    prompts.close();
    socket.close();
    process.exit(0);
  });
}
