import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventDraft, Identity } from "@mpa/protocol";
import { buildAudit, renderMarkdown } from "./audit.js";
import { Room } from "./room.js";

/**
 * The audit export.
 *
 * What it has to get right is attribution: who asked for a thing, who let it
 * happen, and who is being charged for it. Those are three different people
 * often enough that guessing any of them from the others is wrong.
 */

const alice: Identity = { userId: "u-alice", name: "alice" };
const bob: Identity = { userId: "u-bob", name: "bob" };

const agent: EventDraft["actor"] = { kind: "agent" };
const system: EventDraft["actor"] = { kind: "system" };
const user = (who: Identity): EventDraft["actor"] => ({
  kind: "user",
  userId: who.userId,
  name: who.name,
});

function joined(who: Identity): EventDraft {
  return {
    actor: system,
    body: { type: "room.joined", userId: who.userId, name: who.name },
  };
}

function completedTurn(turnId: string, costUsd: number): EventDraft {
  return {
    actor: agent,
    body: {
      type: "turn.completed",
      turnId,
      isError: false,
      usage: {
        costUsd,
        sessionTotalCostUsd: costUsd,
        durationMs: 100,
        inputTokens: 10,
        outputTokens: 20,
      },
    },
  };
}

/** Alice asks, the agent answers, and it costs something. */
function simpleTurn(room: Room, text: string, cost: number, n = 1): number {
  const seq = room.append({
    actor: user(alice),
    body: { type: "prompt.submitted", promptId: `p${n}`, text },
  }).seq;
  room.append({
    actor: agent,
    body: { type: "turn.started", turnId: `t${n}`, promptId: `p${n}` },
  });
  room.append(completedTurn(`t${n}`, cost));
  return seq;
}

function auditOf(room: Room) {
  return buildAudit(room.id, room.since(-1));
}

test("cost is charged to whoever's prompt started the turn", () => {
  const room = new Room("r");
  room.append(joined(alice));
  room.append(joined(bob));
  simpleTurn(room, "alice asks", 0.05, 1);

  const report = auditOf(room);
  assert.equal(report.totalCostUsd, 0.05);
  assert.equal(report.spend.length, 1);
  assert.equal(report.spend[0]!.who.name, "alice");
  assert.equal(report.spend[0]!.costUsd, 0.05);
});

test("a promoted suggestion is charged to its author, not the driver", () => {
  const room = new Room("r");
  room.append(joined(alice));
  room.append(joined(bob));

  // Bob had the idea; alice held the token and let it through. The log credits
  // bob, and so must the bill — this is the whole reason `promotedBy` exists
  // separately from the actor.
  room.append({
    actor: user(bob),
    body: {
      type: "prompt.submitted",
      promptId: "p1",
      text: "bob's idea",
      promotedBy: alice,
      suggestionId: "s1",
    },
  });
  room.append({
    actor: agent,
    body: { type: "turn.started", turnId: "t1", promptId: "p1" },
  });
  room.append(completedTurn("t1", 0.2));

  const report = auditOf(room);
  assert.equal(report.spend.length, 1);
  assert.equal(report.spend[0]!.who.name, "bob");
  assert.equal(report.prompts[0]!.promotedBy?.name, "alice");
});

test("an approval records the tool, its arguments and who decided", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: {
      type: "tool.approval.requested",
      requestId: "a1",
      toolName: "Bash",
      input: { command: "rm -rf build" },
      turnId: "t1",
    },
  });
  room.append({
    actor: user(alice),
    body: { type: "tool.approval.decided", requestId: "a1", allow: true },
  });

  const report = auditOf(room);
  assert.equal(report.approvals.length, 1);
  const approval = report.approvals[0]!;
  assert.equal(approval.toolName, "Bash");
  assert.equal(approval.allow, true);
  assert.equal(approval.decidedBy?.name, "alice");
  assert.equal(approval.bySystem, false);

  // The arguments have to survive into the report: "alice approved a Bash
  // call" is not an audit record, "alice approved `rm -rf build`" is.
  assert.match(renderMarkdown(report), /rm -rf build/);
});

test("a refusal by the relay is attributed to the system, not to a person", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: {
      type: "tool.approval.requested",
      requestId: "a1",
      toolName: "Write",
      input: { file_path: "/tmp/x" },
      turnId: null,
    },
  });
  room.append({
    actor: system,
    body: {
      type: "tool.approval.decided",
      requestId: "a1",
      allow: false,
      reason: "bob has unsaved changes in that file.",
    },
  });

  const report = auditOf(room);
  assert.equal(report.approvals[0]!.bySystem, true);
  assert.equal(report.approvals[0]!.decidedBy, null);
  assert.match(renderMarkdown(report), /unsaved changes/);
});

test("a request nobody ever decided is reported as undecided", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: {
      type: "tool.approval.requested",
      requestId: "a1",
      toolName: "Bash",
      input: { command: "ls" },
      turnId: null,
    },
  });

  const report = auditOf(room);
  assert.equal(report.approvals[0]!.decided, false);
  assert.match(renderMarkdown(report), /never decided/);
});

test("a file change carries its merge outcome", () => {
  const room = new Room("r");
  room.append({
    actor: agent,
    body: {
      type: "file.changed",
      path: "/w/login.ts",
      turnId: "t1",
      tool: "Edit",
    },
  });
  room.append({
    actor: agent,
    body: {
      type: "doc.merged",
      path: "/w/login.ts",
      turnId: "t1",
      applied: 1,
      moved: 1,
      conflicts: 2,
      holders: ["alice"],
    },
  });

  const report = auditOf(room);
  assert.equal(report.fileChanges.length, 1);
  assert.deepEqual(report.fileChanges[0]!.merge, {
    applied: 1,
    moved: 1,
    conflicts: 2,
  });
  // A write that partly did not land is the case most worth surfacing.
  assert.match(renderMarkdown(report), /had conflicts/);
});

test("rewound work is marked but still counted", () => {
  const room = new Room("r");
  room.append(joined(alice));
  const promptSeq = simpleTurn(room, "the abandoned attempt", 0.4, 1);
  room.append({
    actor: user(alice),
    body: {
      type: "checkpoint.restored",
      checkpointId: "c1",
      label: "the abandoned attempt",
      fromSeq: promptSeq,
      filesChanged: ["/w/a.ts"],
      insertions: 0,
      deletions: 3,
      skippedLinks: 1,
      sessionId: "s2",
    },
  });

  const report = auditOf(room);
  assert.equal(report.prompts[0]!.superseded, true);
  // The tokens were spent whether or not the room kept the result, so a bill
  // that quietly dropped them would be wrong.
  assert.equal(report.totalCostUsd, 0.4);
  assert.equal(report.rewinds.length, 1);
  assert.equal(report.rewinds[0]!.by?.name, "alice");
  assert.equal(report.rewinds[0]!.skippedLinks, 1);

  const md = renderMarkdown(report);
  assert.match(md, /rewound/);
  assert.match(md, /## Rewinds/);
});

test("a fork is recorded in both directions", () => {
  const room = new Room("r");
  room.append({
    actor: user(alice),
    body: {
      type: "room.forked",
      checkpointId: "c1",
      label: "try it the other way",
      toRoomId: "r-alt",
      atSeq: 7,
      sessionId: "s-fork",
    },
  });

  const report = auditOf(room);
  assert.equal(report.forks.length, 1);
  assert.equal(report.forks[0]!.toRoomId, "r-alt");
  assert.match(renderMarkdown(report), /forked out to/);
});

test("an interrupted turn says so", () => {
  const room = new Room("r");
  room.append({
    actor: user(alice),
    body: { type: "prompt.submitted", promptId: "p1", text: "go" },
  });
  room.append({
    actor: agent,
    body: { type: "turn.started", turnId: "t1", promptId: "p1" },
  });
  room.append({
    actor: agent,
    body: { type: "turn.interrupted", turnId: "t1", byUserId: bob.userId },
  });

  const report = auditOf(room);
  assert.equal(report.prompts[0]!.interrupted, true);
  assert.match(renderMarkdown(report), /interrupted/);
});

test("the report states what it does not contain", () => {
  const room = new Room("r");
  simpleTurn(room, "anything", 0.01);

  // Tool results are truncated for transport, and an audit trail that implied
  // otherwise would be claiming completeness it does not have.
  const md = renderMarkdown(auditOf(room));
  assert.match(md, /Tool results are previews/);
  assert.match(md, /Human edits are not tracked/);
  assert.match(md, /only as good as the relay's auth/);
});

test("an empty room renders without inventing anything", () => {
  const md = renderMarkdown(buildAudit("empty", []));
  assert.match(md, /Nobody joined/);
  assert.match(md, /Nothing was asked/);
  assert.match(md, /No tool call needed a decision/);
});

test("a prompt containing a table pipe cannot break the markdown", () => {
  const room = new Room("r");
  room.append({
    actor: user(alice),
    body: {
      type: "prompt.submitted",
      promptId: "p1",
      text: "run `a | b`\nand then more",
    },
  });

  const md = renderMarkdown(auditOf(room));
  const row = md
    .split("\n")
    .find((line) => line.includes("a \\| b"));
  assert.ok(row, "the pipe is escaped");
  // Newlines flattened, so one prompt stays one row.
  assert.ok(!row.includes("\n"));
});
