import { randomUUID } from "node:crypto";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@mpa/protocol";
import { configFromEnv, labelFor } from "./config.js";
import { BROAD_TOOLS, FileBridge, WRITE_TOOLS, readOrEmpty } from "./files.js";
import { ApprovalGate } from "./gate.js";
import { RelayLink } from "./relay-link.js";
import { performFork, performRewind, type RewindDeps } from "./rewind.js";
import { AgentSession } from "./session.js";
import { TurnTranslator } from "./translate.js";

/**
 * Drives one shared agent session for one room.
 *
 * It connects only to the relay — never to an editor. That is the seam that
 * lets this same process later run inside a cloud sandbox with no client
 * change: the editors already talk to it exclusively through the shared log.
 *
 * This file is wiring. The parts worth reading on their own are `gate.ts` (the
 * approval pause), `files.ts` (shared buffers), `session.ts` (the SDK session,
 * including the rewind swap) and `rewind.ts` (M4).
 */

const config = configFromEnv();

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

The workspace root is ${config.cwd}. All file paths you use must be relative to \
that root or absolute beneath it; a leading "/" means the filesystem root, not \
the project. Prefer Glob or Grep over guessing a path.

People may have this project open and be editing it as you work. Before you \
read a file its editors write out their unsaved changes, so what you read is \
current — and when you write a file, your change is merged into the buffers \
they have open rather than replacing them. You do not need to do anything \
about this; just do not assume a file is unchanged since you last read it.

Most of your tools pause for a human decision before they run, and the room \
sees the arguments you asked for. Prefer one clear, complete change over a \
series of small ones, since each is a separate interruption for a person who \
has to read it.

If a tool call is declined, do not retry it. If the refusal says someone has \
unsaved changes in the file, say so plainly and offer to continue once they \
save — do not attempt to write it another way. Otherwise explain what you \
wanted to do and why, and let the room respond.`;

const translator = new TurnTranslator();

const link = new RelayLink({
  url: config.relayUrl,
  roomId: config.roomId,
  cwd: config.cwd,
  token: config.relayToken,
  onConnected: (first) => {
    // Tool calls still suspended on a human decision have to be re-asked; the
    // relay may have restarted and forgotten them.
    gate.resendAll();
    if (first) link.publish({ type: "agent.status", state: "starting" });
  },
  onMessage: (msg) => handle(msg),
});

const gate = new ApprovalGate(link, config.approvalTimeoutMs);
const files = new FileBridge(
  link,
  config.cwd,
  config.sharedBuffers,
  config.flushTimeoutMs,
);

// ---------------------------------------------------------------------------
// Hooks — where the gate and shared buffers actually attach to the agent
// ---------------------------------------------------------------------------

const gateToolCall: HookCallback = async (input, _toolUseId, options) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolName = input.tool_name;

  // Reading is cheap, reversible and constant, so waiting on a human for it
  // would make the session unusable without making it meaningfully safer.
  // Everything else is suspended until the room decides.
  if (!config.autoApproved.has(toolName)) {
    const decision = await gate.ask(
      toolName,
      input.tool_input,
      translator.openTurnId,
      options.signal,
    );
    if (!decision.allow) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            decision.reason ?? "The room declined this tool call.",
        },
      };
    }
  }

  // Approved — now make disk agree with the room before the tool looks at it.
  const path = files.toolPath(toolName, input.tool_input);
  const write = WRITE_TOOLS.has(toolName);
  if (path) {
    await files.flush([path], write);
    if (write) files.rememberBefore(path);
  } else if (BROAD_TOOLS.has(toolName)) {
    await files.flush(null, false);
  }

  if (config.autoApproved.has(toolName)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Approved in the shared session.",
    },
  };
};

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

  const path = files.toolPath(input.tool_name, input.tool_input);
  if (!path) return {};

  link.publish({
    type: "file.changed",
    path,
    turnId: translator.openTurnId,
    tool: input.tool_name,
  });

  // Both halves of the change go to the relay, which folds it into whatever the
  // file's readers are looking at now — including anything typed while this
  // tool was running.
  const before = files.takeBefore(path);
  if (!config.sharedBuffers || before === undefined) return {};

  const merge = await files.reportWrite(
    path,
    before,
    readOrEmpty(path),
    translator.openTurnId,
  );

  // "Written successfully" is true and, when a hunk was skipped, misleading:
  // that part of the change is not in the file anyone is looking at. Saying so
  // here is the difference between the agent correcting itself and the agent
  // confidently reporting work it did not do.
  if (merge && merge.conflicts > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `Your write to ${path} succeeded on disk, but ${merge.conflicts} ` +
          "part(s) of it were NOT applied to the copy people are editing: " +
          "somebody had already rewritten those exact lines while you were " +
          "working, and their version was kept. Their copy is the one that " +
          "counts — it will overwrite the file the next time it is saved — so " +
          "do not describe this edit as done. Say plainly which part did not " +
          "land and that someone else had changed those lines, and let the room " +
          "decide. Do not try to write the file again.",
      },
    };
  }
  return {};
};

const session = new AgentSession({
  baseOptions: {
    cwd: config.cwd,
    disallowedTools: config.disallowedTools,
    /**
     * Backups of every file before the agent changes it, which is what
     * `rewindFiles` restores from. Not optional: without it a rewind would roll
     * the transcript back and leave every edit the agent made sitting on disk,
     * and the room would believe otherwise.
     */
    enableFileCheckpointing: true,
    hooks: {
      // The hook's own timeout has to outlast the human one, or the SDK gives
      // up on the gate while the room is still looking at it.
      PreToolUse: [
        {
          timeout: Math.ceil(config.approvalTimeoutMs / 1000) + 30,
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
  },
  onMessage: (message) => {
    for (const body of translator.translate(message)) link.publish(body);
  },
  onStopped: () => link.publish({ type: "agent.status", state: "stopped" }),
  onError: (detail) =>
    link.publish({ type: "agent.status", state: "error", detail }),
});

const rewindDeps: RewindDeps = {
  link,
  session,
  files,
  translator,
  cwd: config.cwd,
};

// ---------------------------------------------------------------------------
// Relay messages
// ---------------------------------------------------------------------------

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome": {
      if (session.running) break;
      if (msg.agentSessionId) {
        console.log(`[agent-host] resuming session ${msg.agentSessionId}`);
      }
      session.start(msg.agentSessionId);
      break;
    }
    case "runPrompt": {
      const turnId = randomUUID();
      translator.startTurn(turnId, msg.promptId, labelFor(msg.text));
      link.publish({ type: "turn.started", turnId, promptId: msg.promptId });
      session.submit(msg.text);
      break;
    }
    case "doInterrupt": {
      const turnId = translator.openTurnId;
      void session.interrupt().catch((err: unknown) => {
        console.error("[agent-host] interrupt failed:", err);
      });
      if (turnId) {
        link.publish({ type: "turn.interrupted", turnId, byUserId: msg.byUserId });
      }
      break;
    }
    case "toolDecision":
      gate.settle(msg.requestId, msg.allow, msg.reason);
      break;
    case "docFlushed":
      files.onFlushed(msg.requestId);
      break;
    case "docMerged":
      files.onMerged(msg.writeId, {
        live: msg.live,
        applied: msg.applied,
        moved: msg.moved,
        conflicts: msg.conflicts,
      });
      break;
    case "doRewind":
      void performRewind(rewindDeps, msg);
      break;
    case "doFork":
      void performFork(rewindDeps, msg);
      break;
    case "error": {
      console.error("[agent-host] relay error:", msg.message);
      // Retrying a rejected credential just produces the same rejection every
      // few seconds forever. Stop, and say what to do about it.
      if (msg.message.startsWith("not authorised")) {
        console.error(
          "[agent-host] set MPA_TOKEN to the relay's token " +
            "(see the relay's startup log for where it lives), then start again.",
        );
        link.close();
        session.close();
        process.exit(1);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------

console.log(`[agent-host] room=${config.roomId} cwd=${config.cwd}`);
console.log(
  `[agent-host] auto-approved: ${[...config.autoApproved].join(", ") || "none"} · ` +
    `never allowed: ${config.disallowedTools.join(", ") || "none"} · ` +
    "everything else asks the room",
);
console.log(
  `[agent-host] shared buffers: ${
    config.sharedBuffers
      ? "on — reads see unsaved work, writes merge into open editors"
      : "off — reads and writes go straight to disk"
  }`,
);
link.connect();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    link.close();
    session.close();
    process.exit(0);
  });
}
