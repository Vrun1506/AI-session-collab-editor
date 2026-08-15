/**
 * Do the SDK primitives M4 is built on actually behave as documented?
 *
 * Checkpoint rewind and session fork are not implemented in this repo — they
 * are delegated to the SDK, which is the right call and also means three
 * assumptions are load-bearing and none of them are ours:
 *
 *   A. A user message pushed into a streaming-input session comes back through
 *      the stream carrying a `uuid`. Without it there is no way to anchor a
 *      checkpoint: our log speaks in `seq`, and `rewindFiles`/`resumeSessionAt`
 *      speak in message UUIDs. Nothing else bridges the two.
 *   B. `enableFileCheckpointing` + `Query.rewindFiles(uuid)` really restores a
 *      file the agent changed. If it does not, "rewind" would roll back the
 *      transcript while leaving the code it wrote in place — the worst of the
 *      available outcomes, because the room would believe the change was undone.
 *   C. `forkSession(id, { upToMessageId })` yields a session that can actually
 *      be resumed. Session fork is nothing without it.
 *
 * Run after any SDK upgrade:
 *
 *   cd packages/agent-host && node probe-rewind.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";

const cwd = mkdtempSync(join(tmpdir(), "mpa-rewind-probe-"));
const file = join(cwd, "subject.txt");
const ORIGINAL = "the original line\n";
writeFileSync(file, ORIGINAL);

/** Streaming-input mode, which is how agent-host runs — see runAgentLoop. */
async function* onePrompt(text) {
  yield {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  };
}

let promptUuid = null;
let lastEntryUuid = null;
let sessionId = null;

const results = { A: false, B: false, C: false };
let detail = {};

try {
  const run = query({
    prompt: onePrompt(
      `Replace the entire contents of ${file} with the single line: REWRITTEN`,
    ),
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      // The option the whole rewind path depends on.
      enableFileCheckpointing: true,
      includePartialMessages: true,
    },
  });

  for await (const message of run) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }

    // The prompt echo: a user message with no tool_result blocks. Tool results
    // arrive as user messages too, which is why the content is inspected
    // rather than just the type.
    if (message.type === "user" && message.uuid) {
      const content = message.message?.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some((b) => b && typeof b === "object" && b.type === "tool_result");
      if (!isToolResult && !promptUuid) promptUuid = message.uuid;
      lastEntryUuid = message.uuid;
    }
    if (message.type === "assistant" && message.uuid) {
      lastEntryUuid = message.uuid;
    }

    // The turn is done; the file should now be rewritten. Rewind it while the
    // query is still alive, because rewindFiles is a method on the live Query.
    if (message.type === "result") {
      const afterWrite = readFileSync(file, "utf8");
      detail.afterWrite = afterWrite;

      results.A = Boolean(promptUuid);
      if (!promptUuid) break;

      const preview = await run.rewindFiles(promptUuid, { dryRun: true });
      detail.dryRun = preview;

      const rewound = await run.rewindFiles(promptUuid);
      detail.rewind = rewound;

      const afterRewind = readFileSync(file, "utf8");
      detail.afterRewind = afterRewind;
      results.B = afterWrite !== ORIGINAL && afterRewind === ORIGINAL;
      break;
    }
  }

  // C: fork the session and check the fork is resumable.
  if (sessionId && lastEntryUuid) {
    const fork = await forkSession(sessionId, { upToMessageId: lastEntryUuid });
    detail.forkedSessionId = fork?.sessionId ?? null;

    if (fork?.sessionId) {
      const resumed = query({
        prompt: onePrompt("Reply with the single word: RESUMED"),
        options: { cwd, permissionMode: "bypassPermissions", resume: fork.sessionId },
      });
      let said = "";
      for await (const message of resumed) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") said += block.text;
          }
        }
        if (message.type === "result") break;
      }
      detail.forkReplied = said.trim().slice(0, 80);
      results.C = said.toUpperCase().includes("RESUMED");
    }
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

console.log("--- detail ---");
console.log(JSON.stringify(detail, null, 2));
console.log("--------------");
console.log(`A. prompt echo carries a uuid:      ${results.A}  (${promptUuid ?? "none"})`);
console.log(`B. rewindFiles restored the file:   ${results.B}`);
console.log(`C. forked session is resumable:     ${results.C}`);

const failures = [];
if (!results.A) {
  failures.push(
    "A: no uuid on the prompt echo. Checkpoints cannot be anchored to SDK " +
      "messages, so rewind and fork have nothing to aim at — find another way " +
      "to learn a turn's message UUID before building on this.",
  );
}
if (!results.B) {
  failures.push(
    "B: rewindFiles did not restore the file. Rewind must NOT be shipped on " +
      "this SDK version: it would roll back the transcript while leaving the " +
      "agent's edits on disk, and the room would believe otherwise.",
  );
}
if (!results.C) {
  failures.push(
    "C: the forked session could not be resumed. Session fork would produce " +
      "a room whose agent has no memory of what it forked from.",
  );
}

if (failures.length > 0) {
  console.error(`\nFAIL\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK: rewind and fork rest on behaviour this SDK actually has.");
