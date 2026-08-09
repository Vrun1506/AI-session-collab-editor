/**
 * Does the approval gate actually fire?
 *
 * This exists because assuming it did cost real work. The obvious mechanism —
 * `canUseTool` — is simply not consulted for `Bash` in this SDK, so the first
 * version of the shared approval gate watched a guest's prompt run a shell
 * command with nobody asked. A `PreToolUse` hook does fire for every tool call,
 * which is what `agent-host` uses.
 *
 * Run this after any SDK upgrade, or before trusting a different mechanism.
 * "deny" is the important case: if the command still runs, the gate is a lie.
 *
 *   node probe-gate.mjs deny     # expect: tool_result ERROR, nothing executed
 *   node probe-gate.mjs allow    # expect: hello-from-probe
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const decision = process.argv[2] ?? "deny";
const AUTO = new Set(["Read", "Glob", "Grep"]);

const q = query({
  prompt:
    "Run the shell command `echo hello-from-probe` and tell me what it printed.",
  options: {
    cwd: process.cwd(),
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
    hooks: {
      PreToolUse: [
        {
          timeout: 600,
          hooks: [
            async (input) => {
              const name = input.tool_name;
              if (AUTO.has(name)) {
                console.log(`>>> hook: auto-allow ${name}`);
                return {};
              }
              console.log(
                `>>> hook: SUSPENDING on ${name}`,
                JSON.stringify(input.tool_input).slice(0, 80),
              );
              // A real pause, to prove the agent genuinely waits rather than
              // being told about the decision after the fact.
              await new Promise((r) => setTimeout(r, 3000));
              console.log(`>>> hook: resolved ${name} -> ${decision}`);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: decision,
                  permissionDecisionReason: `probe says ${decision}`,
                },
              };
            },
          ],
        },
      ],
    },
  },
});

for await (const m of q) {
  if (m.type === "assistant") {
    for (const b of m.message.content ?? []) {
      if (b.type === "tool_use") {
        console.log(`[tool_use] ${b.name}`, JSON.stringify(b.input).slice(0, 80));
      }
      if (b.type === "text" && b.text.trim()) {
        console.log(`[text] ${b.text.slice(0, 250)}`);
      }
    }
  }
  if (m.type === "user") {
    for (const b of m.message.content ?? []) {
      if (b?.type === "tool_result") {
        const t =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        console.log(`[tool_result${b.is_error ? " ERROR" : ""}] ${t.slice(0, 200)}`);
      }
    }
  }
  if (m.type === "result") console.log(`[result] ${m.subtype}`);
}
