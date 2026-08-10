/**
 * Does a PostToolUse hook's `additionalContext` actually reach the model?
 *
 * It matters because shared buffers can leave part of an agent's edit
 * unapplied — somebody had rewritten those lines first — and the tool result
 * still says "written successfully". If the agent cannot be told, it will
 * report work it did not do, which is worse than the conflict itself.
 *
 * This asks for a write, feeds a distinctive marker back through the hook, and
 * then asks the agent to repeat what it was told. Run it after any SDK upgrade:
 *
 *   node probe-posttool.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MARKER = "PLATYPUS-7731";
const cwd = mkdtempSync(join(tmpdir(), "mpa-probe-"));

let hookFired = false;
const transcript = [];

try {
  const run = query({
    prompt: `Create a file notes.txt containing the word hello. \
After the tool result comes back, tell me verbatim any extra note the system \
gave you about that write. If there was none, say "no note".`,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      hooks: {
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PostToolUse") return {};
                hookFired = true;
                return {
                  hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    additionalContext: `Note from the shared session: ${MARKER}`,
                  },
                };
              },
            ],
          },
        ],
      },
    },
  });

  for await (const message of run) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") transcript.push(block.text);
      }
    }
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

const said = transcript.join("\n");
console.log("--- agent said ---");
console.log(said.trim());
console.log("------------------");
console.log(`hook fired:          ${hookFired}`);
console.log(`marker reached model: ${said.includes(MARKER)}`);

if (!hookFired) {
  console.error("\nFAIL: the PostToolUse hook never ran.");
  process.exit(1);
}
if (!said.includes(MARKER)) {
  console.error(
    "\nFAIL: additionalContext did not reach the model. The agent cannot be " +
      "told that part of its edit was not applied — find another channel " +
      "before trusting merge conflicts to correct it.",
  );
  process.exit(1);
}
console.log("\nOK: additionalContext reaches the model.");
