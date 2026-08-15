import { decodeClient, type ClientMessage } from "@mpa/protocol";
import {
  onDecideApproval,
  onRequestApproval,
} from "./approvals.js";
import {
  onForkRoom,
  onForkedSession,
  onRequestAudit,
  onRewindTo,
} from "./checkpoints.js";
import type { Conn } from "./conn.js";
import type { Peer, RelayContext } from "./context.js";
import {
  onBufferState,
  onDocClose,
  onDocFlush,
  onDocOpen,
  onDocSaved,
  onDocUpdate,
  onDocWrote,
} from "./documents.js";
import {
  onGrantDriver,
  onReleaseDriver,
  onRequestDriver,
} from "./driver.js";
import {
  onDismissSuggestion,
  onInterrupt,
  onPromoteSuggestion,
  onSubmitPrompt,
} from "./prompts.js";
import { onHello, onPing, onPublish } from "./session.js";

/**
 * Every client message, and the handler that answers it.
 *
 * The table is typed as a total map over `ClientMessage["type"]`, which is the
 * point of it: **adding a message to the wire protocol without handling it here
 * is a compile error.** Previously this was a 23-arm `switch` inside a 1,200
 * line file, where a missing arm was a silent no-op that showed up as a client
 * hanging on a reply that never came.
 *
 * `hello` is absent on purpose — it is the message that creates the peer every
 * other handler is handed, so it is dispatched separately below.
 */
type Handled = Exclude<ClientMessage["type"], "hello">;

type MessageOf<T extends Handled> = Extract<ClientMessage, { type: T }>;

export type Handler<T extends Handled> = (
  ctx: RelayContext,
  peer: Peer,
  msg: MessageOf<T>,
) => void;

type HandlerTable = { [T in Handled]: Handler<T> };

const handlers: HandlerTable = {
  publish: onPublish,
  ping: onPing,
  interrupt: onInterrupt,

  submitPrompt: onSubmitPrompt,
  promoteSuggestion: onPromoteSuggestion,
  dismissSuggestion: onDismissSuggestion,

  requestDriver: onRequestDriver,
  grantDriver: onGrantDriver,
  releaseDriver: onReleaseDriver,

  requestApproval: onRequestApproval,
  decideApproval: onDecideApproval,

  bufferState: onBufferState,
  docOpen: onDocOpen,
  docClose: onDocClose,
  docUpdate: onDocUpdate,
  docSaved: onDocSaved,
  docFlush: onDocFlush,
  docWrote: onDocWrote,

  rewindTo: onRewindTo,
  forkRoom: onForkRoom,
  forkedSession: onForkedSession,
  requestAudit: onRequestAudit,
};

/**
 * Route one frame from one peer.
 *
 * This is the whole of the relay's transport-facing surface: everything else is
 * a plain function over `RelayContext`, which is what lets the behaviour be
 * tested without a socket.
 */
export function dispatch(ctx: RelayContext, conn: Conn, raw: string): void {
  const msg = decodeClient(raw);
  if (!msg) {
    ctx.refuse(conn, "malformed frame");
    return;
  }

  if (msg.type === "hello") {
    onHello(ctx, conn, msg);
    return;
  }

  // Every message except `hello` requires an established peer.
  const peer = ctx.peerFor(conn);
  if (!peer) {
    ctx.refuse(conn, "send hello first");
    return;
  }

  // The table guarantees a handler exists for every type; TypeScript cannot
  // correlate the looked-up handler with the narrowed message on its own, so
  // the pairing is asserted here and nowhere else.
  const handler = handlers[msg.type] as Handler<Handled>;
  handler(ctx, peer, msg as MessageOf<Handled>);
}
