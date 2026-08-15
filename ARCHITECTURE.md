# Architecture

How this codebase is put together, and how to add to it without reading all of
it. The README explains *what* the product does; this explains *where things
go*.

## The one idea

Everything is derived from an append-only event log that the relay alone
orders. Clients do not hold state that the log cannot reproduce — they fold it.
That is why late join, reconnect, restart, rewind and audit all work without
special cases: each is a different way of reading the same list.

Two consequences worth internalising before changing anything:

- **Never mutate history.** Rewind does not delete; it appends a
  `checkpoint.restored` that declares a range superseded. `Room.compactedSince`
  hides that range from the transcript, and the audit export deliberately reads
  the raw log so the abandoned work is still there.
- **Never store derived state beside the log.** The driver token, the
  suggestion queue, undecided approvals and the checkpoint list are all folded
  in `Room.fold`. That is why they survive a restart for free. Presence is the
  one exception, because it is a property of live sockets, not of history.

## Packages

| Package | Role | Depends on |
| --- | --- | --- |
| `protocol` | zod schemas for the log and the wire — the contract | — |
| `crdt` | hunk diffing and merging an agent write into a live document | — |
| `sync-server` | the relay: rooms, ordering, replay, documents, audit | protocol, crdt |
| `agent-host` | the Agent SDK wrapper: one shared session per room | protocol |
| `vscode-ext` | the editor client and its webview panel | protocol, crdt |

`agent-host` talks **only** to the relay, never to an editor. That seam is what
lets it move into a cloud sandbox later without touching any client. Do not
introduce a direct path between them.

## Inside the relay

`sync-server/src/index.ts` is 90 lines: config, a socket server, nothing else.
All behaviour is in `relay/`, as plain functions over a `RelayContext`.

```
relay/conn.ts        Conn — the three things the relay needs from a socket
relay/context.ts     RelayContext — all state, plus send/publish/getRoom
relay/dispatch.ts    the handler table; the only place transport meets logic
relay/session.ts     hello, publish, ping, disconnect
relay/prompts.ts     submitPrompt, suggestions, interrupt
relay/driver.ts      the driver token (rules live in policy.ts)
relay/approvals.ts   the shared approval gate
relay/documents.ts   shared buffers: flush, locks, merge
relay/checkpoints.ts rewind, fork, audit export
```

Two things make this testable, and both matter more than they look:

- **`Conn` is not a WebSocket.** It is `send`/`close`/`open`. A test peer is an
  object that collects strings, so a whole room can be built and driven
  in-process — see `relay/relay.test.ts`.
- **Handlers are functions, not methods on a server.** They take
  `(ctx, peer, msg)` and return nothing. Nothing in `relay/` opens a socket,
  reads `process.env`, or calls `Date.now()` for a deadline that a test cannot
  shorten via `RelayConfig`.

Decisions that are *product* rather than plumbing live outside the handlers, in
`policy.ts` (who may drive) and `room.ts` (what the log means). Handlers turn
those decisions into events. When you find yourself writing an `if` about
fairness or safety inside a handler, it probably belongs in one of those two.

## Inside the agent-host

`agent-host/src/index.ts` is wiring. The parts worth reading alone:

```
config.ts       everything read from the environment, resolved once
relay-link.ts   the socket, the retry schedule, the offline outbox
session.ts      AgentSession — the SDK query, including the rewind swap
gate.ts         ApprovalGate — tool calls suspended until the room decides
files.ts        FileBridge — flush-before-read, report-write-after
translate.ts    SDK messages → log events, and checkpoint anchoring
rewind.ts       M4: rewindFiles + resumeSessionAt, and forkSession
```

`AgentSession` exists because a rewind cannot move a live SDK session
backwards: the only way is to end the running query and start another resumed
at an earlier point. That swap coordinates five things at once, and they used
to be five module-level `let`s any part of the file could reach. Keep them
behind the class.

## Inside the extension

```
extension.ts     commands, wiring, the session lifecycle
session.ts       RoomSession — the socket, reconnect, the checkpoint list
panel.ts         the webview host (media/panel.js folds the log and renders)
docsync.ts       adapter: watches documents, applies edits, draws decorations
buffer-rules.ts  the decisions docsync makes, with no editor attached
bootstrap.ts     finding and starting the relay
buffers.ts       the dirty-buffer watcher
```

`buffer-rules.ts` is the same split as the relay's, for the same reason. What
may be shared, whose copy wins on attach, which buffer changes are ours to
send, and how to turn one text into another are all pure questions; only the
API answering them is VS Code's. **Put new buffer logic there, not in
`docsync.ts`** — and note it is the part that survives a move to a VS Code
fork, where the adapter gets rewritten but the questions do not.

Three of its rules are load-bearing and silently corrupt a file when wrong,
which is why each has a test naming the failure:

- **echo** — applying a remote change raises a change event of its own
- **disk reload** — VS Code rereads an unmodified file when it changes on disk,
  so during an agent write that event is the agent's own change coming back
- **refusal** — two dirty buffers with different content have no common history
  to merge from, so neither may win

## Recipes

### Add an event type

Events fan out to several readers and **the compiler will not tell you if you
miss one.** This is the single biggest trap in the codebase. In order:

1. **`protocol/src/events.ts`** — add the arm to `EventBody`. Document *why* the
   event exists, not what its fields are named.
2. **`sync-server/src/room.ts`** — add a `fold` case **only if** the relay must
   arbitrate on it. If nothing server-side reads it, skip this.
3. **`sync-server/src/audit.ts`** — add a `buildAudit` case if it is something
   someone would need to answer for later. Approvals, writes, spend and rewinds
   are; token deltas are not.
4. **`vscode-ext/media/panel.js`** — add a `case` to render it, or add the type
   to `SILENT` if it is deliberately invisible. Anything else logs a warning to
   the devtools console rather than vanishing.
5. **`sync-server/src/test-client.ts`** — add an `isEvent` branch so the
   headless client shows it. Unhandled types print generically here, so this is
   the one place that degrades gracefully.
6. **Test it in `checkpoint.test.ts` or `audit.test.ts`** if you touched steps
   2 or 3.

Steps 2–5 are four parallel switches. There is no way to make TypeScript
enforce them without forcing every reader to handle every event, which would be
worse — most readers legitimately care about a handful. Treat this list as the
checklist it is.

### Add a wire message

This one **is** compiler-enforced.

1. **`protocol/src/wire.ts`** — add to `ClientMessage` or `ServerMessage`.
2. If it is a `ClientMessage`, `relay/dispatch.ts` **will not compile** until
   you add a handler to the table. Write it in whichever `relay/*.ts` module
   owns that concern.
3. Type the handler's `msg` as `Msg<"yourType">` — never a hand-written shape,
   or a field going optional in the schema will reach the handler as
   `undefined` with no warning.
4. If it is a `ServerMessage` the client must act on, add it to
   `vscode-ext/src/session.ts` (and a `SessionHandlers` callback) and to
   `agent-host/src/index.ts`'s `handle` if the agent cares.
5. Add a case to `relay/relay.test.ts`. Building a room is three lines.

### Add a relay rule

If it is about *who may do what*, put it in `policy.ts` and test it in
`policy.test.ts` — no relay involved. If it is about *what the log means*, put
it in `Room.fold` and test it in `room.test.ts`. Only reach for a handler when
the rule genuinely needs the socket layer.

Guards that several handlers share belong next to them — see `checkpointFor` in
`relay/checkpoints.ts`, which is the driver check, the missing-checkpoint check
and the mid-turn check that rewind and fork both need.

### Add a client affordance

1. A method on `RoomSession` in `vscode-ext/src/session.ts` that sends the wire
   message.
2. A command in `extension.ts`, registered in `package.json` under
   `contributes.commands`.
3. If the panel needs it, a `PanelActions` entry in `panel.ts` and a
   `postMessage` handler in `media/panel.js`.

## Tests

```bash
pnpm test        # 193 tests
pnpm typecheck
```

| File | Covers |
| --- | --- |
| `sync-server/relay/relay.test.ts` | the relay's message handling, in-process |
| `sync-server/room.test.ts` | ordering, replay, compaction, folded state |
| `sync-server/checkpoint.test.ts` | checkpoints, supersession, log forking |
| `sync-server/audit.test.ts` | attribution, spend, what the report admits |
| `sync-server/policy.test.ts` | the driver rules, with no relay involved |
| `sync-server/docs.test.ts`, `writes.test.ts` | shared buffers, dirty-buffer guard |
| `sync-server/store.test.ts` | both stores against one contract |
| `agent-host/translate.test.ts` | the SDK fold, and checkpoint anchoring |
| `vscode-ext/buffer-rules.test.ts` | echo, reload and refusal; edit planning |
| `crdt/*.test.ts` | hunk placement and merge conflicts |

`vscode-ext` compiles to `dist/` for tests only — the extension itself ships as
the CommonJS bundle in `out/`, so `scripts/prep-tests.mjs` marks the test output
as ESM. Anything importing `vscode` cannot be tested this way; that is the line
`buffer-rules.ts` exists to sit on.

Three **probes** check assumptions about the SDK rather than about our code.
They cost real tokens and are not part of `pnpm test`; run them after any SDK
upgrade:

```bash
cd packages/agent-host
node probe-gate.mjs deny   # a denied tool call must NOT execute
node probe-posttool.mjs    # additionalContext must reach the model
node probe-rewind.mjs      # prompt uuids, rewindFiles, forkSession
```

If a probe fails, the feature resting on it must not ship in that state. They
exist because each of these was once assumed and was once wrong.

## Known friction

Honest list of what is still awkward, so nobody rediscovers it the hard way.
[`TASKS.md`](TASKS.md) says what to do about each one.

- **Event fan-out is a checklist, not a type.** Four readers, no enforcement.
  See the recipe above. The panel's `default` warning is the only safety net.
- **`test-client.ts` is not a test.** It is a headless editor peer, and its name
  collides with Node's test-file discovery — which is why the test scripts use
  an explicit `dist/**/*.test.js` glob rather than a directory. Renaming it
  would be an improvement and would touch the README in several places.
- **The extension's adapters are still untested.** `docsync.ts` is now thin, but
  `session.ts` (417 lines: reconnect, replay cursor, the checkpoint list) and
  `extension.ts` hold real logic behind the `vscode` import. The checkpoint
  tracking in `session.ts` duplicates the relay's supersession rule in a second
  language, and nothing checks that the two agree.
- **The webview folds the log in JavaScript**, so none of the protocol types
  reach it. A rendering bug there is only caught by looking; the `default` arm
  warning is the only safety net.
- **`RelayContext` is a god object** by design — it is the state, deliberately
  in one place. It is fine while handlers stay thin. If it starts growing
  methods that make decisions, those decisions belong in `policy.ts`.
