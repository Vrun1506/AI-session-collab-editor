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

/**
 * Converts the SDK's message stream into shared-log events.
 *
 * Holds the small amount of state the conversion needs: which turn is open,
 * which assistant message the current deltas belong to, and the previous
 * cumulative cost (so each turn can report its own cost rather than the
 * session running total).
 */
export class TurnTranslator {
  private turnId: string | null = null;
  private messageId = "pending";
  private lastTotalCostUsd = 0;

  startTurn(turnId: string): void {
    this.turnId = turnId;
    this.messageId = "pending";
  }

  get openTurnId(): string | null {
    return this.turnId;
  }

  translate(msg: SDKMessage): EventBody[] {
    const turnId = this.turnId ?? "orphan";
    const out: EventBody[] = [];

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
        // Tool results arrive as synthetic user messages.
        const content = msg.message?.content;
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
