import type { EventBody } from "@mpa/protocol";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const PREVIEW_LIMIT = 800;

function truncate(s: string, limit = PREVIEW_LIMIT): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}… (${s.length} chars)`;
}

/** Flatten arbitrary tool_result content into something renderable. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/** The uuid the SDK assigned a transcript entry, where it has one. */
function entryUuid(msg: SDKMessage): string | undefined {
  return "uuid" in msg && typeof msg.uuid === "string" ? msg.uuid : undefined;
}

/**
 * Converts the SDK's message stream into shared-log events.
 *
 * Holds the small amount of state the conversion needs: which turn is open,
 * which assistant message the current deltas belong to, the previous cumulative
 * cost (so each turn can report its own cost rather than the session running
 * total), and — for M4 — where each turn sits in the SDK's own transcript.
 *
 * That last part is the only place the two id spaces meet. Our log is ordered
 * by the relay's `seq`; `rewindFiles` and `resumeSessionAt` are addressed by SDK
 * message uuid. A checkpoint has to carry both or a rewind can move the
 * transcript without moving the files and the agent's memory with it.
 */
export class TurnTranslator {
  private turnId: string | null = null;
  private messageId = "pending";
  private lastTotalCostUsd = 0;

  // ---- checkpoint anchoring (M4) -------------------------------------------
  /** The most recent chain entry, whichever kind it was. */
  private lastEntry: string | null = null;
  /** What `lastEntry` was when this turn opened: the last entry to keep. */
  private resumeAt: string | null = null;
  private promptId: string | null = null;
  private label = "";
  /** Whether this turn's prompt echo has been seen and its checkpoint emitted. */
  private anchored = true;

  startTurn(turnId: string, promptId: string | null = null, label = ""): void {
    this.turnId = turnId;
    this.messageId = "pending";
    // Captured before the prompt enters the transcript, so it names the last
    // entry that survives if this turn is later taken back.
    this.resumeAt = this.lastEntry;
    this.promptId = promptId;
    this.label = label;
    this.anchored = false;
  }

  get openTurnId(): string | null {
    return this.turnId;
  }

  /**
   * Point the translator at a session that has just been rewound.
   *
   * Two things have to move together. `lastEntry` becomes the truncation point,
   * because the entries after it no longer exist in the forked transcript and a
   * checkpoint anchored to one would be unresumable. And the cost baseline goes
   * back to zero, because `total_cost_usd` is per-session and the fork is a new
   * session — leaving it would make the next turn look free until the running
   * total climbed back past the old one.
   */
  resetTo(entryUuid: string | null): void {
    this.lastEntry = entryUuid;
    this.resumeAt = entryUuid;
    this.turnId = null;
    this.anchored = true;
    this.lastTotalCostUsd = 0;
  }

  translate(msg: SDKMessage): EventBody[] {
    const turnId = this.turnId ?? "orphan";
    const out: EventBody[] = [];

    // Every entry that lands in the SDK transcript can be a fork point, so the
    // running "last entry" is tracked for all of them rather than only the
    // kinds this translator turns into events.
    const uuid = entryUuid(msg);
    if (uuid) this.lastEntry = uuid;

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          out.push({
            type: "agent.status",
            state: "ready",
            sessionId: msg.session_id,
          });
        }
        break;
      }

      case "stream_event": {
        const ev = msg.event as {
          type: string;
          message?: { id?: string };
          delta?: { type?: string; text?: string; thinking?: string };
        };
        if (ev.type === "message_start" && ev.message?.id) {
          // Anchor subsequent deltas to this message so clients append into
          // the right bubble when a turn contains several messages.
          this.messageId = ev.message.id;
        } else if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta" && ev.delta.text) {
            out.push({
              type: "assistant.delta",
              turnId,
              messageId: this.messageId,
              text: ev.delta.text,
            });
          } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
            out.push({
              type: "thinking.delta",
              turnId,
              messageId: this.messageId,
              text: ev.delta.thinking,
            });
          }
        }
        break;
      }

      case "assistant": {
        const message = msg.message;
        const messageId = message.id ?? this.messageId;
        const blocks = Array.isArray(message.content) ? message.content : [];

        const text = blocks
          .filter((b): b is typeof b & { type: "text"; text: string } =>
            b.type === "text",
          )
          .map((b) => b.text)
          .join("");

        // Authoritative text replaces whatever the deltas built up.
        if (text.trim()) {
          out.push({ type: "assistant.message", turnId, messageId, text });
        }

        for (const block of blocks) {
          if (block.type === "tool_use") {
            out.push({
              type: "tool.requested",
              turnId,
              toolUseId: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        break;
      }

      case "user": {
        const content = msg.message?.content;
        const isToolResult =
          Array.isArray(content) &&
          content.some(
            (block) =>
              block &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "tool_result",
          );

        // The prompt coming back with a uuid on it is the one moment the SDK
        // tells us where this turn begins in its own transcript. Tool results
        // arrive as user messages too, hence the check rather than the type.
        if (!isToolResult && uuid && !this.anchored) {
          this.anchored = true;
          out.push({
            type: "checkpoint.created",
            checkpointId: uuid,
            turnId: this.turnId,
            promptId: this.promptId,
            label: this.label,
            userMessageId: uuid,
            resumeAt: this.resumeAt,
          });
        }

        // Tool results arrive as synthetic user messages.
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            "type" in block &&
            block.type === "tool_result"
          ) {
            const b = block as {
              tool_use_id: string;
              is_error?: boolean;
              content?: unknown;
            };
            out.push({
              type: "tool.result",
              turnId,
              toolUseId: b.tool_use_id,
              isError: Boolean(b.is_error),
              preview: truncate(contentToText(b.content)),
            });
          }
        }
        break;
      }

      case "result": {
        const total = msg.total_cost_usd ?? 0;
        // total_cost_usd is cumulative across turns in a streaming-input
        // session, so the per-turn figure is the delta since the last result.
        const delta = Math.max(0, total - this.lastTotalCostUsd);
        this.lastTotalCostUsd = total;

        const usage = msg.usage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;

        out.push({
          type: "turn.completed",
          turnId,
          isError: msg.is_error === true,
          usage: {
            costUsd: delta,
            sessionTotalCostUsd: total,
            durationMs: msg.duration_ms ?? null,
            inputTokens: usage?.input_tokens ?? null,
            outputTokens: usage?.output_tokens ?? null,
          },
        });
        this.turnId = null;
        break;
      }

      default:
        // The SDKMessage union is broad and grows; unhandled kinds are simply
        // not part of the shared log yet.
        break;
    }

    return out;
  }
}
