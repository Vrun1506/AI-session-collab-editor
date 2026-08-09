import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  query,
  type HookCallback,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_RELAY_URL,
  decodeServer,
  encode,
  type ClientMessage,
  type EventBody,
} from "@mpa/protocol";
import { readLocalToken } from "@mpa/protocol/token";
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
// MPA_TOKEN if given, otherwise whatever the relay on this machine minted.
const relayToken = readLocalToken();

const splitList = (v: string) =>
  v.split(",").map((t) => t.trim()).filter(Boolean);

/**
 * Tools that run without asking anyone. Reading is safe enough to be worth the
 * latency saved; everything else goes to the room.
 *
 * Note this list is applied by *our* hook, not passed to the SDK as
 * `allowedTools`. A bare name in `allowedTools` auto-approves the tool before
 * any callback is consulted, which is precisely the shadowing we need to avoid.
 */
const autoApproved = new Set(
  splitList(process.env.MPA_ALLOWED_TOOLS ?? "Read,Glob,Grep"),
);

/**
 * Tools nobody may authorise, however much they want to. Empty by default now
 * that every other tool goes to a human first.
 *
 * File writes used to live here, because approving a write is not the same as
 * consenting to destroy a colleague's unsaved buffer and the approver has no
 * way to tell the difference. That gap is closed in the relay instead: it
 * refuses a write to a file anyone is still editing before the room is even
 * asked. So the agent can finally change code, which is the point of it.
 *
 * The list remains as an escape hatch for anyone who wants a harder guarantee
 * than "a human said yes" — set `MPA_DISALLOWED_TOOLS` to pin tools off.
 */
const disallowedTools = splitList(process.env.MPA_DISALLOWED_TOOLS ?? "");

/**
 * How long a suspended tool call waits for a human before it gives up.
 *
 * Without this an unattended room wedges the agent forever: `canUseTool` has no
 * deadline of its own, and a promise nobody resolves is indistinguishable from
 * a hang.
 */
const approvalTimeoutMs = Number(process.env.MPA_APPROVAL_TIMEOUT_MS ?? 300_000);

const prompts = new AsyncQueue<SDKUserMessage>();
const translator = new TurnTranslator();

let socket: WebSocket | undefined;
let started = false;
let shuttingDown = false;
let activeQuery: ReturnType<typeof query> | undefined;

// ---------------------------------------------------------------------------
// Relay connection
// ---------------------------------------------------------------------------

const RETRY_DELAYS = [500, 1_000, 2_000, 4_000, 8_000];
let retries = 0;

/**
 * Events produced while the relay is unreachable.
 *
 * The log is the product, so silently dropping a turn's output because a socket
 * blipped is not acceptable. The cap exists because an agent mid-answer will
 * happily outproduce a relay that never comes back; oldest first, since a
 * dropped delta is superseded by the `assistant.message` that follows it.
 */
const outbox: ClientMessage[] = [];
const OUTBOX_LIMIT = 5_000;

function sendToRelay(msg: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(encode(msg));
    return;
  }
  if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
  outbox.push(msg);
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

function connect(): void {
  const ws = new WebSocket(relayUrl);
  socket = ws;

  ws.on("open", () => {
    retries = 0;
    ws.send(
      encode({
        type: "hello",
        roomId,
        userId: "agent-host",
        name: "Agent",
        role: "agent-host",
        // The host does not replay history; the editors are the readers.
        sinceSeq: Number.MAX_SAFE_INTEGER,
        // Lets the relay resolve the paths a tool call asks to write against
        // the same root the agent is working in.
        cwd,
        ...(relayToken ? { token: relayToken } : {}),
      }),
    );
    if (!started) publish({ type: "agent.status", state: "starting" });
  });

  ws.on("message", (raw) => {
    const msg = decodeServer(raw.toString());
    if (!msg) return;

    switch (msg.type) {
      case "welcome": {
        // Flush anything produced while offline before anything new lands, so
        // the room's ordering matches the order the agent actually spoke in.
        const backlog = outbox.splice(0, outbox.length);
        for (const queued of backlog) sendToRelay(queued);

        // Tool calls still suspended on a human decision have to be re-asked:
        // the relay may have restarted and forgotten them, and it answers
        // idempotently if it has not.
        for (const [requestId, pending] of pendingApprovals) {
          sendToRelay({
            type: "requestApproval",
            requestId,
            toolName: pending.toolName,
            input: pending.input,
            turnId: pending.turnId,
          });
        }

        if (started) break;
        started = true;
        if (msg.agentSessionId) {
          console.log(`[agent-host] resuming session ${msg.agentSessionId}`);
        }
        void runAgentLoop(msg.agentSessionId);
        break;
      }
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
      case "toolDecision": {
        settleApproval(msg.requestId, msg.allow, msg.reason);
        break;
      }
      case "error": {
        console.error("[agent-host] relay error:", msg.message);
        // Retrying a rejected credential just produces the same rejection
        // every few seconds forever. Stop, and say what to do about it.
        if (msg.message.startsWith("not authorised")) {
          console.error(
            "[agent-host] set MPA_TOKEN to the relay's token " +
              "(see the relay's startup log for where it lives), then start again.",
          );
          shuttingDown = true;
          prompts.close();
          process.exit(1);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (shuttingDown) return;
    // The shared agent must outlive a relay restart. The query itself is
    // untouched by a dropped socket, so recovery is only a matter of getting
    // the transcript flowing again.
    const delay = RETRY_DELAYS[Math.min(retries, RETRY_DELAYS.length - 1)]!;
    retries++;
    console.log(
      `[agent-host] relay unreachable, retrying in ${delay}ms (attempt ${retries})`,
    );
    setTimeout(connect, delay).unref?.();
  });

  ws.on("error", (err) => {
    console.error("[agent-host] socket error:", err.message);
  });
}

// ---------------------------------------------------------------------------
// Shared approval gate
// ---------------------------------------------------------------------------

interface PendingApproval {
  toolName: string;
  input: unknown;
  turnId: string | null;
  settle: (decision: { allow: boolean; reason?: string }) => void;
  timer: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, PendingApproval>();

function settleApproval(
  requestId: string,
  allow: boolean,
  reason: string | undefined,
): void {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return;
  pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);
  pending.settle({ allow, reason });
}

/**
 * Suspends the agent until someone in the room decides.
 *
 * This is the milestone's whole point. The pause is real — the agent is
 * genuinely stopped, not shown a notification after the fact — and the request,
 * its arguments and the eventual decision all land in the shared log, so every
 * participant sees the same thing and the transcript answers "who approved
 * that?" afterwards.
 *
 * It runs as a `PreToolUse` hook rather than through `canUseTool`, which was
 * the obvious choice and the wrong one: measured against this SDK, `canUseTool`
 * is simply not consulted for `Bash`, so the first version of this gate watched
 * a guest's prompt run a shell command with nobody asked. The hook fires for
 * every tool call, which is the property the whole milestone rests on. Re-check
 * with `packages/agent-host/probe.mjs` before trusting either mechanism on a
 * new SDK version.
 */
async function askTheRoom(
  toolName: string,
  input: unknown,
  signal: AbortSignal,
): Promise<{ allow: boolean; reason?: string }> {
  const requestId = randomUUID();
  const turnId = translator.openTurnId;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      resolve({
        allow: false,
        reason: `No one approved this ${toolName} call within ${Math.round(
          approvalTimeoutMs / 1000,
        )}s.`,
      });
    }, approvalTimeoutMs);
    timer.unref?.();

    pendingApprovals.set(requestId, {
      toolName,
      input,
      turnId,
      settle: resolve,
      timer,
    });

    // An interrupt must not leave the room staring at a request that can no
    // longer matter.
    signal.addEventListener("abort", () => {
      settleApproval(requestId, false, "Turn was interrupted.");
    });

    sendToRelay({
      type: "requestApproval",
      requestId,
      toolName,
      input,
      turnId,
    });
  });
}

/** Tools whose effect is a file on disk changing. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * Tell the room which files actually changed.
 *
 * Approving a write is not the same as seeing it land: without this the file
 * changes on the host's disk and everyone else's editor shows the old content
 * with no hint that anything happened.
 */
const reportFileChange: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  if (!WRITE_TOOLS.has(input.tool_name)) return {};

  const toolInput = input.tool_input as Record<string, unknown> | undefined;
  const raw =
    toolInput?.["file_path"] ?? toolInput?.["notebook_path"] ?? toolInput?.["path"];
  if (typeof raw !== "string" || !raw) return {};

  publish({
    type: "file.changed",
    path: resolve(cwd, raw),
    turnId: translator.openTurnId,
    tool: input.tool_name,
  });
  return {};
};

const gateToolCall: HookCallback = async (input, _toolUseId, options) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolName = input.tool_name;
  // Reading is cheap, reversible and constant, so waiting on a human for it
  // would make the session unusable without making it meaningfully safer.
  if (autoApproved.has(toolName)) return {};

  const decision = await askTheRoom(toolName, input.tool_input, options.signal);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.allow ? "allow" : "deny",
      permissionDecisionReason:
        decision.reason ??
        (decision.allow
          ? "Approved in the shared session."
          : "The room declined this tool call."),
    },
  };
};

// ---------------------------------------------------------------------------

/**
 * The agent is told where it is and who it is working for.
 *
 * Without the first part it guesses root-relative paths and burns a tool call
 * recovering; without the second it writes as though one person asked, which
 * reads oddly to the three other people watching.
 */
const sharedSessionPrompt = `You are the shared agent in a multiplayer session. \
Several people are watching this conversation and any of them may prompt you, \
so prompts in one turn may come from a different person than the last.

The workspace root is ${cwd}. All file paths you use must be relative to that \
root or absolute beneath it; a leading "/" means the filesystem root, not the \
project. Prefer Glob or Grep over guessing a path.

Most of your tools pause for a human decision before they run, and the room \
sees the arguments you asked for. Prefer one clear, complete change over a \
series of small ones, since each is a separate interruption for a person who \
has to read it.

If a tool call is declined, do not retry it. If the refusal says someone has \
unsaved changes in the file, say so plainly and offer to continue once they \
save — do not attempt to write it another way. Otherwise explain what you \
wanted to do and why, and let the room respond.`;

async function runAgentLoop(resumeSessionId: string | null): Promise<void> {
  try {
    activeQuery = query({
      prompt: prompts,
      options: {
        cwd,
        disallowedTools,
        hooks: {
          // The hook's own timeout has to outlast the human one, or the SDK
          // gives up on the gate while the room is still looking at it.
          PreToolUse: [
            {
              timeout: Math.ceil(approvalTimeoutMs / 1000) + 30,
              hooks: [gateToolCall],
            },
          ],
          PostToolUse: [{ hooks: [reportFileChange] }],
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: sharedSessionPrompt,
        },
        // Streams tokens as they arrive so every participant watches the agent
        // think in real time — the whole point of M0.
        includePartialMessages: true,
        // Resuming restores what the agent already knows about this room, so a
        // relay or host restart does not send it back to a blank slate. The
        // session file is local to this machine; if it has gone, the SDK
        // starts fresh and the transcript still replays from the log.
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
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

console.log(`[agent-host] room=${roomId} cwd=${cwd}`);
console.log(
  `[agent-host] auto-approved: ${[...autoApproved].join(", ") || "none"} · ` +
    `never allowed: ${disallowedTools.join(", ") || "none"} · ` +
    "everything else asks the room",
);
connect();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shuttingDown = true;
    prompts.close();
    socket?.close();
    process.exit(0);
  });
}
