import {
  isSuperseded,
  type Identity,
  type SessionEvent,
  type SupersededRange,
} from "@mpa/protocol";

/**
 * Turning the log into something a person can be held to.
 *
 * The transcript answers "what is the room working from now"; this answers
 * "what happened, and who decided it" — which is a different question the
 * moment anything goes wrong. So it reads the raw log rather than the compacted
 * one: work a rewind abandoned still happened, the agent still ran those tools,
 * and an audit that quietly dropped them would be worse than none.
 *
 * Everything here is folded from events. There is no separate audit trail to
 * drift out of sync with the session, which is the point of having put the
 * decisions in the log in the first place.
 */

export interface AuditApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  requestedAt: number;
  decided: boolean;
  allow: boolean | null;
  /** Null when the relay refused it on the room's behalf rather than a person. */
  decidedBy: Identity | null;
  bySystem: boolean;
  reason: string | null;
}

export interface AuditPrompt {
  promptId: string;
  seq: number;
  ts: number;
  author: Identity;
  /** Set when this began as someone else's suggestion. */
  promotedBy: Identity | null;
  text: string;
  turnId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  interrupted: boolean;
  /** True when a later rewind took this turn back. */
  superseded: boolean;
}

export interface AuditFileChange {
  seq: number;
  ts: number;
  path: string;
  tool: string;
  turnId: string | null;
  /** Populated when the write merged into buffers people had open. */
  merge: { applied: number; moved: number; conflicts: number } | null;
  superseded: boolean;
}

export interface AuditRewind {
  seq: number;
  ts: number;
  label: string;
  by: Identity | null;
  fromSeq: number;
  filesChanged: string[];
  skippedLinks: number;
}

export interface AuditFork {
  seq: number;
  ts: number;
  label: string;
  toRoomId: string | null;
  fromRoomId: string | null;
  atSeq: number;
}

export interface AuditSpend {
  who: Identity;
  costUsd: number;
  turns: number;
}

export interface AuditReport {
  roomId: string;
  generatedAt: number;
  events: number;
  firstTs: number | null;
  lastTs: number | null;
  participants: Identity[];
  prompts: AuditPrompt[];
  approvals: AuditApproval[];
  fileChanges: AuditFileChange[];
  rewinds: AuditRewind[];
  forks: AuditFork[];
  spend: AuditSpend[];
  totalCostUsd: number;
  /** Ranges a rewind left behind. */
  supersededRanges: SupersededRange[];
}

function actorIdentity(event: SessionEvent): Identity | null {
  return event.actor.kind === "user"
    ? { userId: event.actor.userId, name: event.actor.name }
    : null;
}

/** Fold a room's raw history into an auditable summary. */
export function buildAudit(roomId: string, events: SessionEvent[]): AuditReport {
  const participants = new Map<string, Identity>();
  const prompts: AuditPrompt[] = [];
  const promptById = new Map<string, AuditPrompt>();
  const approvals = new Map<string, AuditApproval>();
  const fileChanges: AuditFileChange[] = [];
  const rewinds: AuditRewind[] = [];
  const forks: AuditFork[] = [];
  const supersededRanges: SupersededRange[] = [];

  /** turnId -> the prompt that opened it, for cost attribution. */
  const turnPrompt = new Map<string, AuditPrompt>();
  /** Latest file change per turn+path, so a merge report can find its write. */
  const changeByKey = new Map<string, AuditFileChange>();

  for (const event of events) {
    const b = event.body;
    switch (b.type) {
      case "room.joined": {
        participants.set(b.userId, { userId: b.userId, name: b.name });
        break;
      }
      case "prompt.submitted": {
        const author = actorIdentity(event) ?? {
          userId: "unknown",
          name: "unknown",
        };
        participants.set(author.userId, author);
        const prompt: AuditPrompt = {
          promptId: b.promptId,
          seq: event.seq,
          ts: event.ts,
          author,
          promotedBy: b.promotedBy ?? null,
          text: b.text,
          turnId: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          interrupted: false,
          superseded: false,
        };
        prompts.push(prompt);
        promptById.set(b.promptId, prompt);
        break;
      }
      case "turn.started": {
        if (!b.promptId) break;
        const prompt = promptById.get(b.promptId);
        if (!prompt) break;
        prompt.turnId = b.turnId;
        turnPrompt.set(b.turnId, prompt);
        break;
      }
      case "turn.completed": {
        // Charged to whoever's prompt started the turn — which for a promoted
        // suggestion is its author, not the driver who let it through.
        const prompt = turnPrompt.get(b.turnId);
        if (!prompt) break;
        prompt.costUsd = b.usage.costUsd;
        prompt.inputTokens = b.usage.inputTokens;
        prompt.outputTokens = b.usage.outputTokens;
        break;
      }
      case "turn.interrupted": {
        const prompt = turnPrompt.get(b.turnId);
        if (prompt) prompt.interrupted = true;
        break;
      }
      case "tool.approval.requested": {
        if (approvals.has(b.requestId)) break;
        approvals.set(b.requestId, {
          requestId: b.requestId,
          toolName: b.toolName,
          input: b.input,
          requestedAt: event.ts,
          decided: false,
          allow: null,
          decidedBy: null,
          bySystem: false,
          reason: null,
        });
        break;
      }
      case "tool.approval.decided": {
        const approval = approvals.get(b.requestId);
        if (!approval) break;
        approval.decided = true;
        approval.allow = b.allow;
        approval.decidedBy = actorIdentity(event);
        approval.bySystem = event.actor.kind === "system";
        approval.reason = b.reason ?? null;
        break;
      }
      case "file.changed": {
        const change: AuditFileChange = {
          seq: event.seq,
          ts: event.ts,
          path: b.path,
          tool: b.tool,
          turnId: b.turnId,
          merge: null,
          superseded: false,
        };
        fileChanges.push(change);
        changeByKey.set(`${b.turnId ?? ""}\0${b.path}`, change);
        break;
      }
      case "doc.merged": {
        const change = changeByKey.get(`${b.turnId ?? ""}\0${b.path}`);
        if (!change) break;
        change.merge = {
          applied: b.applied,
          moved: b.moved,
          conflicts: b.conflicts,
        };
        break;
      }
      case "checkpoint.restored": {
        supersededRanges.push({ fromSeq: b.fromSeq, toSeq: event.seq });
        rewinds.push({
          seq: event.seq,
          ts: event.ts,
          label: b.label,
          by: actorIdentity(event),
          fromSeq: b.fromSeq,
          filesChanged: b.filesChanged,
          skippedLinks: b.skippedLinks,
        });
        break;
      }
      case "room.forked": {
        forks.push({
          seq: event.seq,
          ts: event.ts,
          label: b.label,
          toRoomId: b.toRoomId ?? null,
          fromRoomId: b.fromRoomId ?? null,
          atSeq: b.atSeq,
        });
        break;
      }
    }
  }

  for (const prompt of prompts) {
    prompt.superseded = isSuperseded(supersededRanges, prompt.seq);
  }
  for (const change of fileChanges) {
    change.superseded = isSuperseded(supersededRanges, change.seq);
  }

  // Spend follows attribution, not who was driving. Superseded turns are still
  // counted: the tokens were spent whether or not the room kept the result.
  const spendBy = new Map<string, AuditSpend>();
  let totalCostUsd = 0;
  for (const prompt of prompts) {
    if (prompt.costUsd === null) continue;
    totalCostUsd += prompt.costUsd;
    const entry = spendBy.get(prompt.author.userId) ?? {
      who: prompt.author,
      costUsd: 0,
      turns: 0,
    };
    entry.costUsd += prompt.costUsd;
    entry.turns += 1;
    spendBy.set(prompt.author.userId, entry);
  }

  return {
    roomId,
    generatedAt: Date.now(),
    events: events.length,
    firstTs: events.length > 0 ? events[0]!.ts : null,
    lastTs: events.length > 0 ? events[events.length - 1]!.ts : null,
    participants: [...participants.values()],
    prompts,
    approvals: [...approvals.values()],
    fileChanges,
    rewinds,
    forks,
    spend: [...spendBy.values()].sort((a, b) => b.costUsd - a.costUsd),
    totalCostUsd,
    supersededRanges,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function iso(ts: number | null): string {
  return ts === null ? "—" : new Date(ts).toISOString();
}

function usd(n: number | null): string {
  return n === null ? "—" : `$${n.toFixed(4)}`;
}

/** Keep a prompt readable in a table cell without losing what it asked for. */
function oneLine(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const escaped = flat.replace(/\|/g, "\\|");
  return escaped.length <= limit ? escaped : `${escaped.slice(0, limit)}…`;
}

function inputSummary(input: unknown, limit = 160): string {
  if (input === null || input === undefined) return "—";
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return oneLine(text, limit);
}

export function renderMarkdown(report: AuditReport): string {
  const out: string[] = [];
  const push = (line = "") => out.push(line);

  push(`# Session audit — ${report.roomId}`);
  push();
  push(`Generated ${iso(report.generatedAt)}`);
  push();
  push(`| | |`);
  push(`| --- | --- |`);
  push(`| Events | ${report.events} |`);
  push(`| First event | ${iso(report.firstTs)} |`);
  push(`| Last event | ${iso(report.lastTs)} |`);
  push(`| Participants | ${report.participants.length} |`);
  push(`| Turns | ${report.prompts.length} |`);
  push(`| Total cost | ${usd(report.totalCostUsd)} |`);
  push();

  push(`## Who was here`);
  push();
  if (report.participants.length === 0) {
    push(`Nobody joined.`);
  } else {
    for (const p of report.participants) {
      push(`- ${p.name} \`${p.userId}\``);
    }
  }
  push();

  push(`## Spend`);
  push();
  push(`Charged to whoever's prompt started the turn — for a promoted`);
  push(`suggestion that is its author, not the driver who ran it.`);
  push();
  if (report.spend.length === 0) {
    push(`No completed turns.`);
  } else {
    push(`| Participant | Turns | Cost |`);
    push(`| --- | ---: | ---: |`);
    for (const s of report.spend) {
      push(`| ${s.who.name} | ${s.turns} | ${usd(s.costUsd)} |`);
    }
    push(`| **Total** | **${report.prompts.length}** | **${usd(report.totalCostUsd)}** |`);
  }
  push();

  push(`## Prompts`);
  push();
  if (report.prompts.length === 0) {
    push(`Nothing was asked.`);
  } else {
    push(`| Seq | When | Who | Prompt | Cost | Notes |`);
    push(`| ---: | --- | --- | --- | ---: | --- |`);
    for (const p of report.prompts) {
      const notes: string[] = [];
      if (p.promotedBy) notes.push(`promoted by ${p.promotedBy.name}`);
      if (p.interrupted) notes.push("interrupted");
      if (p.superseded) notes.push("**rewound**");
      push(
        `| ${p.seq} | ${iso(p.ts)} | ${p.author.name} | ${oneLine(p.text)} | ${usd(
          p.costUsd,
        )} | ${notes.join(", ") || "—"} |`,
      );
    }
  }
  push();

  push(`## Tool approvals`);
  push();
  push(`Every tool outside the auto-approved set stopped the agent until`);
  push(`somebody decided. This is that record.`);
  push();
  if (report.approvals.length === 0) {
    push(`No tool call needed a decision.`);
  } else {
    push(`| When | Tool | Arguments | Decision | By |`);
    push(`| --- | --- | --- | --- | --- |`);
    for (const a of report.approvals) {
      const decision = !a.decided
        ? "never decided"
        : a.allow
          ? "allowed"
          : `denied${a.reason ? ` — ${oneLine(a.reason, 80)}` : ""}`;
      const by = a.bySystem
        ? "system"
        : (a.decidedBy?.name ?? (a.decided ? "unknown" : "—"));
      push(
        `| ${iso(a.requestedAt)} | ${a.toolName} | \`${inputSummary(a.input)}\` | ${decision} | ${by} |`,
      );
    }
  }
  push();

  push(`## Files the agent changed`);
  push();
  if (report.fileChanges.length === 0) {
    push(`The agent changed nothing on disk.`);
  } else {
    push(`| When | Path | Tool | Merge | Notes |`);
    push(`| --- | --- | --- | --- | --- |`);
    for (const c of report.fileChanges) {
      const merge = c.merge
        ? `${c.merge.applied} applied, ${c.merge.moved} shifted, ${c.merge.conflicts} skipped`
        : "written to disk";
      const notes: string[] = [];
      if (c.merge && c.merge.conflicts > 0) notes.push("**had conflicts**");
      if (c.superseded) notes.push("**rewound**");
      push(
        `| ${iso(c.ts)} | \`${c.path}\` | ${c.tool} | ${merge} | ${notes.join(", ") || "—"} |`,
      );
    }
  }
  push();

  if (report.rewinds.length > 0) {
    push(`## Rewinds`);
    push();
    push(`| When | Back to | By | Files restored | Skipped (unsafe links) |`);
    push(`| --- | --- | --- | ---: | ---: |`);
    for (const r of report.rewinds) {
      push(
        `| ${iso(r.ts)} | ${oneLine(r.label, 60)} (seq ${r.fromSeq}) | ${
          r.by?.name ?? "system"
        } | ${r.filesChanged.length} | ${r.skippedLinks} |`,
      );
    }
    push();
  }

  if (report.forks.length > 0) {
    push(`## Forks`);
    push();
    push(`| When | Branch point | Room | Direction |`);
    push(`| --- | --- | --- | --- |`);
    for (const f of report.forks) {
      const direction = f.toRoomId
        ? `forked out to \`${f.toRoomId}\``
        : `forked from \`${f.fromRoomId ?? "?"}\``;
      push(
        `| ${iso(f.ts)} | ${oneLine(f.label, 60)} (seq ${f.atSeq}) | ${
          f.toRoomId ?? f.fromRoomId ?? "—"
        } | ${direction} |`,
      );
    }
    push();
  }

  push(`## What this record does not contain`);
  push();
  push(
    `- **Tool results are previews.** Each is truncated to 800 characters for`,
  );
  push(
    `  transport; the full output stays in the agent's own SDK transcript on`,
  );
  push(`  the host machine and is not reproduced here.`);
  push(
    `- **Superseded work is listed, not hidden.** Rows marked \`rewound\` were`,
  );
  push(
    `  taken back by a later rewind. They still ran, still cost money and may`,
  );
  push(`  still have changed files that the rewind could not restore.`);
  push(
    `- **Human edits are not tracked.** This is a record of what the agent did`,
  );
  push(`  and who let it, not of what people typed.`);
  push(
    `- **Identity is only as good as the relay's auth.** Under a shared token,`,
  );
  push(
    `  everyone holding it can join under any name, so these attributions bind`,
  );
  push(`  only as tightly as that secret was held.`);
  push();

  return out.join("\n");
}
