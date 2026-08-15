# Multiplayer Agent Sessions

Several people share **one live agent session** — same prompts, same tool calls,
same diffs, same approvals — from inside VS Code.

The product is not the editor integration. It is the **shared, replayable event
log with real concurrency control**. Everything a client shows is derived state
folded from that log, so someone joining ten minutes late sees exactly what
everyone else sees.

Status: **working MVP** — several people share one agent that can read, run
commands and change code, with concurrency control, live shared buffers, an auth
gate, and a session that can be rewound, forked and exported for audit. See
`Milestones`.

## Architecture

```
 VS Code ext (host)              VS Code ext (guest)
        └──────────┐      ┌──────────┘
                   ▼      ▼
            ┌──────────────────────┐
            │  sync-server (relay) │  rooms, presence, append-only log,
            │                      │  replay-from-seq — sole owner of `seq`
            └──────────┬───────────┘
                       ▼
            ┌──────────────────────┐
            │     agent-host       │  Claude Agent SDK in streaming-input mode
            └──────────────────────┘
```

`agent-host` talks **only** to the relay, never to an editor. That seam is what
lets it move into a cloud sandbox later without touching any client.

| Package | Role |
| --- | --- |
| `packages/protocol` | zod schemas for the event log and wire protocol — the contract |
| `packages/crdt` | shared text: hunk diffing, and merging an agent write into a document people are typing in |
| `packages/sync-server` | WebSocket relay, event log, replay, live documents, audit export |
| `packages/agent-host` | Agent SDK wrapper: prompt queue, event translation |
| `packages/vscode-ext` | Extension + shared agent panel webview |

Two seams are load-bearing for where this goes next. `EventStore` keeps SQLite
swappable for Postgres when rooms outgrow one machine, and `Authenticator` keeps
the shared token swappable for real accounts when the relay stops being
something you run on your laptop.

**Adding to this?** [`ARCHITECTURE.md`](ARCHITECTURE.md) has the seams, recipes
for the three recurring changes (a new event type, a new wire message, a new
client affordance), and an honest list of what is still awkward.

## Prerequisites

- Node 22+, pnpm 11+
- **Anthropic auth.** The Agent SDK needs an API key (`ANTHROPIC_API_KEY`) for
  anything beyond personal experimentation — subscription credentials may not
  be used to serve other users. See "Auth and billing" in the plan.

## Run it

```bash
pnpm install
pnpm build
pnpm package-ext && code --install-extension mpa-vscode.vsix
```

Then, in any VS Code window: **Multiplayer Agent: Host Session**. You are asked
for a room name and your display name; the relay and the agent both start on
their own. A second window joins the same room with **Join Session**.

There is no relay to start by hand and no token to copy — the extension starts
one if nothing is listening, and reads its token from
`~/.multiplayer-agent/relay-token`.

The **agent-host does not ship inside the .vsix**, so the repo has to stay on
disk: the Agent SDK depends on a ~270MB platform-specific native binary, which
would make the extension enormous and wrong on every OS but one. The extension
finds the built packages next to itself; if you move things, point
`mpa.relayEntry` and `mpa.agentHostEntry` at the built `dist/index.js` files.

### Without VS Code

The headless client reproduces the whole scenario and is the fastest way to
check ordering, streaming, late-join and the concurrency rules:

```bash
MPA_ROOM=demo MPA_CWD=/path/to/project node packages/agent-host/dist/index.js &

# Alice joins first, so she gets the driver token. She runs other people's
# suggestions and approves suspended tool calls.
MPA_ROOM=demo MPA_AUTOPROMOTE=1 MPA_AUTOAPPROVE=1 \
  node packages/sync-server/dist/test-client.js alice &

# Bob is not driving, so this text becomes a suggestion, not a prompt.
MPA_ROOM=demo node packages/sync-server/dist/test-client.js bob \
  "Run the shell command 'git status --short' and tell me the output."
```

Bob sees his own suggestion promoted, the prompt attributed back to *him*, the
live token stream, the tool call suspended for approval, Alice's decision, and
the cost. Swap `MPA_AUTOAPPROVE=1` for `MPA_AUTODENY=1` to watch the agent get
refused. `MPA_DRIVE=1` asks for the token on join.

The client is a real editor peer, not a viewer, which is how the shared-buffer
races are reproduced without timing two people's typing by hand:

```bash
# Alice holds login.ts open, with unsaved work, and types the instant the
# agent starts writing it.
MPA_ROOM=demo MPA_AUTOPROMOTE=1 MPA_AUTOAPPROVE=1 \
  MPA_OPEN=src/login.ts \
  MPA_UNSAVED='// not saved yet
' MPA_TYPE_ON_LOCK='// typed during the write
' node packages/sync-server/dist/test-client.js alice
```

Interrupt it and it prints the document it ended up with, which is what to
compare against the file on disk. `MPA_REPLACE_ON_LOCK='old>>new'` rewrites text
instead of appending it — aim it at the lines the agent is about to change and
the merge should report a conflict rather than overwrite you.

## Concurrency control

Exactly one participant holds the **driver token** and may prompt the agent
directly. Everyone else **suggests**; the driver runs or dismisses each
suggestion, and a promoted prompt is attributed in the log to whoever had the
idea, not to whoever pressed the button.

Clients send the same message either way — the relay decides whether it is a
prompt or a suggestion — so a stale idea of who is driving cannot jump the
queue.

The token is not a lock. It moves without the driver's consent in exactly the
two cases where waiting for them would deadlock the room:

| Situation | What happens |
| --- | --- |
| Nobody is driving | First editor to join, or to ask, takes it |
| Driver asked to hand over | They see the request and pass it explicitly |
| Driver has disconnected | Anyone may take it; a lone survivor is given it |
| Driver has gone quiet | Taken after `MPA_DRIVER_IDLE_MS` (default 120s) |

`interrupt()` is available to **everyone** regardless of the token: a deadlocked
room is worse than a cancelled turn. So is typing — the token governs who talks
to the agent, not who may edit code.

The rules live in `packages/sync-server/src/policy.ts`, apart from the socket
handling, because they are the actual product decision here.

## The approval gate

Anything outside `MPA_ALLOWED_TOOLS` suspends the agent and asks the room.
Every participant sees the pending call **with its arguments**; only the driver
decides; everyone sees who decided, and the transcript still says so tomorrow.

The pause is real — the agent is genuinely stopped, not notified afterwards.

> **This is implemented as a `PreToolUse` hook, not `canUseTool`.** Measured
> against this SDK, `canUseTool` is *not* consulted for `Bash`: the first
> version of this gate watched a guest's prompt run a shell command with nobody
> asked. `packages/agent-host/probe-gate.mjs` is how to check, and should be run
> after any SDK upgrade:
>
> ```bash
> cd packages/agent-host && node probe-gate.mjs deny   # must NOT execute
> ```

A suspended call is idempotent on its request id, so the agent-host re-asks
safely after a reconnect, and times out (`MPA_APPROVAL_TIMEOUT_MS`, default 5
minutes) rather than wedging an unattended room forever.

## Persistence

The relay writes every event to SQLite (`MPA_DB`, default `mpa-sessions.db`;
set `:memory:` for throwaway runs). This uses Node 22's built-in `node:sqlite`,
so there is **no native dependency to compile** — the API is still marked
experimental, which is the tradeoff.

Two separate things survive a restart, and both are needed:

- **The transcript**, from the event log. `Room` reads the stored high-water
  mark on construction, so sequence numbers continue rather than collide.
- **The agent's memory**, via the SDK `session_id` recorded per room and passed
  to `query({ resume })`. Without this you would restore the history but face
  an agent that had forgotten all of it.

Verify both at once:

```bash
node packages/sync-server/dist/test-client.js a "Remember the codeword PLATYPUS."
# kill the relay AND the agent-host, restart both
node packages/sync-server/dist/test-client.js b "What was the codeword?"
```

The driver token, the suggestion queue and any undecided approvals come back
too — all of it is folded from the log rather than stored beside it, so it
survives for free and stays consistent with what clients render.

Everything reconnects with backoff and rejoins at its last seen `seq`, so only
missed events replay. That includes the **agent-host**: the shared agent has to
outlive a relay restart, and its own output is buffered while the relay is away
rather than dropped.

The SDK's cumulative session cost resets on resume, so it is not used. Room and
per-participant totals are folded from per-turn deltas instead, and each turn's
cost is charged to whoever's prompt started it.

## Agent edits

The agent can change code, and every write goes to the room first. The approval
card shows the file and the change as a diff rather than a tool name and a blob
of JSON, because the change *is* the decision and nobody consents meaningfully
to `{"tool":"Edit",…}`.

When a write lands, `file.changed` goes into the log and the panel lists what
moved, for everyone — otherwise the file quietly differs and nobody knows which
of your twelve open tabs it was.

## Shared buffers

A file anybody has open is a **live CRDT document**, held by the relay while at
least one editor is attached to it. Two people can type in it at once, and the
agent writes into the same text rather than over it.

Two problems disappear at once, and they are the two that make an agent in a
shared workspace feel dangerous.

**The agent read a file that was already out of date.** Before any file-touching
tool runs, the relay asks whoever holds unsaved changes to save, and waits.
`Bash` and `Grep` flush *every* live document, because a test run that sees the
last-saved version of a file someone has been editing for ten minutes produces a
result about a project that does not exist. The editors do the saving rather
than the agent writing their files for them: VS Code's own save is silent, where
a file changing underneath a dirty buffer means a conflict prompt.

**The agent overwrote what somebody was typing.** The agent tells the relay what
the file said before and after, not just after, so the change arrives as hunks.
Each hunk is placed by matching the text around it rather than trusting an
offset, so an edit at line 200 still lands when someone added a line at the top:

```
🔀 merged into login.ts — 1 change, 1 shifted around live edits · open by alice
```

Measured, not assumed: with Alice holding unsaved changes and typing into
`login.ts` at the moment the agent wrote it, the agent's validation landed,
both of Alice's lines survived, and her buffer and the file on disk ended
byte-identical at 401 bytes.

### When it cannot merge

If someone has rewritten the very lines the agent meant to change, there is no
correct merge. The human's version is kept, the hunk is **skipped**, and both
the room and the agent are told:

```
⇄ merged into login.ts — 0 changes
   1 of the agent's changes were not applied: someone had already rewritten
   those lines. Their version was kept — ask the agent to look again.
```

The agent has to hear about it too, because the tool result says "written
successfully" and that is true of disk and misleading about everything else.
Told, it corrects itself rather than reporting work it did not do:

> Heads up — my edit didn't land. Someone in the session rewrote that exact
> line while I was working, and their version was kept instead of mine.

That feedback rides `additionalContext` on a `PostToolUse` hook.
`packages/agent-host/probe-posttool.mjs` checks the channel still reaches the
model, and should be run after any SDK upgrade.

### What this does not do

- **Nothing is persisted.** A document lives only while somebody holds it open;
  when the last editor closes it, disk is the truth again. That is deliberate —
  a stale shared copy waiting to overwrite a file tomorrow is a worse failure
  than the one it would prevent.
- **No cursors or selections yet.** You see other people's text arrive, not
  where they are.
- **Files outside the workspace folder are not shared**, and neither are
  untitled buffers.
- Set `mpa.sharedBuffers` to false to turn all of it off, and the M2 behaviour
  comes back: writes go to disk, and the relay refuses any write to a file
  somebody has unsaved changes in —

  ```
  ⛔ system denied the tool call
     bob has unsaved changes in that file. Ask them to save, or come back to it.
  ```

  That refusal still applies with shared buffers on, for files that are not
  live. It is computed before the request is broadcast and applied in the same
  tick, so it is not a race an eager approver can win.

| Variable | Effect |
| --- | --- |
| `MPA_SHARED_BUFFERS=0` | agent-host: read and write disk directly, no merging |
| `MPA_FLUSH_TIMEOUT_MS` | how long to wait for editors to save (relay 2s, agent-host 5s) |
| `MPA_WRITE_GRACE_MS` | how long a path stays marked "the agent is writing this" after the merge, to cover a late reload (default 1.5s) |
| `MPA_WRITE_LOCK_TIMEOUT_MS` | backstop release for a write that never reported (default 60s) |

## Checkpoints, rewind and fork

A **checkpoint** is recorded at the start of every turn. Nobody creates them by
hand: the turn is the unit people actually want back, because the thing that
goes wrong is a prompt, and everything that followed it.

Rewinding has to move three things that are keyed three different ways, and
moving any two of them is worse than moving none:

| What | Keyed by | Moved by |
| --- | --- | --- |
| The transcript | our `seq` | superseding a range of the log |
| The files on disk | SDK message uuid | `Query.rewindFiles()` |
| The agent's memory | SDK message uuid | `resumeSessionAt` + `forkSession` |

That is the whole reason `checkpoint.created` exists: it is the join row between
our sequence numbers and the SDK's message uuids, and nothing else bridges them.

**None of the hard part is ours.** File restoration comes from the SDK's own
pre-write backups (`enableFileCheckpointing`, now always on) and the memory
rewind is its own transcript truncation. `packages/agent-host/probe-rewind.mjs`
checks all three assumptions and should be run after any SDK upgrade:

```bash
cd packages/agent-host && node probe-rewind.mjs
```

### Nothing is deleted

The log stays append-only. A rewind appends `checkpoint.restored`, which
declares the range from the checkpoint's *prompt* up to itself **superseded** —
so the room stops counting it without losing it.

That split is deliberate, and it is why there are two readers:

- **The transcript** folds the compacted log, so a rewound turn disappears.
  Someone who watched it happen sees it removed; someone joining afterwards is
  never sent it. Both end up looking at the same thing.
- **The audit export** reads the raw log, so the abandoned turn is still there.
  It ran, it spent money and it may have touched files, and a record that
  quietly dropped it would be worse than no record.

Rewinding is refused while a turn is in flight — restoring files underneath a
running agent races its own writes, and there is no correct winner, so the
caller has to interrupt first. Only the driver may do it.

```
⏪ alice rewound the session to "make the login form accessible" ·
   3 file(s) restored (+0/-47)
```

### What a rewind does not undo

- **Only files the agent changed.** The SDK backs up what it is about to write,
  so that is exactly the set that comes back. **Anything people typed
  themselves is left alone** — deliberately: an "undo" that reverted a
  colleague's work because it shared a file with the agent's would be a much
  worse failure than the one it fixed.
- **Files it cannot safely restore are reported, not skipped quietly.** If a
  symlink or a moved parent directory appears where a tracked file was, the SDK
  refuses that file and `skippedLinks` says how many, because a rewind that
  half-happened is the state most worth knowing about.
- **Money already spent.** The audit still bills the abandoned turn.
- **The old branch is not destroyed.** The rewind *forks* the SDK session rather
  than truncating it, so the abandoned conversation is still on disk and a
  rewind someone regrets is recoverable by hand.

### Forking a session

When the agent goes down the wrong path but the work is worth keeping on both
sides of the decision, fork the checkpoint into a room of its own:

```
🌿 alice forked "try the CSS grid approach" into room demo-alt — this room carries on
```

The log prefix is copied up to the branch point and the agent's session is
forked at the same place, so the new room's agent remembers everything up to the
branch and nothing after it. Sequence numbers are carried over rather than
renumbered, so a checkpoint means the same thing in both logs.

Two things to know:

- The new room needs **its own agent-host**. Host or join `demo-alt` and one
  starts; from the CLI, `MPA_ROOM=demo-alt`.
- **A fork carries no file history** — the SDK does not copy backups into a
  forked session — so the new room can rewind to its own turns but not back
  past the branch point.

### Audit export

```bash
node packages/sync-server/dist/audit-cli.js              # list rooms
node packages/sync-server/dist/audit-cli.js demo         # markdown
node packages/sync-server/dist/audit-cli.js demo --json  # structured
node packages/sync-server/dist/audit-cli.js demo -o audit.md
```

Reading the database rather than asking a running relay is the point: the moment
anyone needs this — a bad write, a command nobody remembers approving, a bill
worth arguing about — is exactly the moment the session is over and the relay is
not running.

The report folds prompts and who authored them, every tool call with its
arguments and who allowed or denied it, files changed and how the merge landed,
rewinds, forks, and spend attributed to whoever's prompt started each turn
(**for a promoted suggestion that is its author, not the driver who ran it**).
It ends with a section stating what it does *not* contain, because an audit
trail that implies completeness it does not have is the one failure mode worth
designing against.

**Multiplayer Agent: Export Audit Log** opens the same thing in an editor tab.

### Trying it without VS Code

```bash
# Alice drives, approves, and rewinds the turn as soon as it finishes.
MPA_ROOM=demo MPA_DRIVE=1 MPA_AUTOAPPROVE=1 \
  MPA_REWIND_AFTER=1 MPA_AUDIT=1 \
  node packages/sync-server/dist/test-client.js alice \
  "Add a comment to the top of src/login.ts"
```

Watch the file change, then change back, and the audit print the turn it just
took back. `MPA_FORK_AFTER=demo-alt` branches instead of rewinding. Join the
same room with a second client afterwards to confirm a late joiner is never
sent the abandoned turn.

## Auth

The relay listens on **loopback only** by default, and requires a token.

Both matter more since the agent gained the ability to write files and run
shell commands: `ws` binds every interface unless told otherwise, which had
quietly put an unauthenticated socket — and through it a shell on the host's
machine — on the local network.

Locally there is nothing to configure. The relay mints a token on first run and
writes it to `~/.multiplayer-agent/relay-token` with mode `0600`; clients on the
same machine read it from there.

To share a room across machines:

```bash
MPA_HOST=0.0.0.0 pnpm relay          # warns, loudly, that it is exposed
```

and give the other machine the token via the `mpa.token` setting. Read the
safety note first — you are handing out the ability to run commands on the
agent-host's machine.

| Variable | Effect |
| --- | --- |
| `MPA_TOKEN` | Use this token instead of the generated one |
| `MPA_TOKEN_FILE` | Where the token lives |
| `MPA_HOST` | Interface to bind (default `127.0.0.1`) |
| `MPA_NO_AUTH=1` | Disable the gate entirely — for tests, never for a shared machine |

A shared secret proves you were told a secret, not that you are who you claim to
be: everyone holding it can join as any name, so the audit log is only as
trustworthy as the people with the token. That is acceptable for a team on one
machine and **not** acceptable hosted, which is why the check sits behind an
`Authenticator` interface in `packages/sync-server/src/auth.ts`. It returns the
identity it verified rather than a boolean, so an OAuth implementation can
overrule the name a client asks for. Replacing it should be a new class, not a
change to the relay.

## Safety note

In host-laptop mode a **guest's prompt runs tools on the host's machine with the
host's credentials.** Four layers, in order:

1. The auth gate — you must hold the relay's token to be in the room at all.
2. `MPA_ALLOWED_TOOLS` (default `Read,Glob,Grep`) runs without asking. Reading
   is cheap and reversible; waiting on a human for it would make the session
   unusable without making it safer.
3. Everything else **asks the room** and blocks until the driver decides. A
   write to a file nobody has open as a shared document additionally cannot
   touch it while someone has unsaved changes.
4. `MPA_DISALLOWED_TOOLS` (empty by default) can be approved by nobody. Set it
   if you want a harder guarantee than "a human said yes".

Note that `allowedTools` is deliberately **not** passed to the SDK. A bare tool
name there auto-approves it before any callback runs, which is exactly the
shadowing the gate has to avoid — the SDK warns about this, and it is why layer
2 is applied by our own hook.

## Milestones

- **M0 ✅** streaming shared session: everyone watches one agent live
- **M1 ✅** durable log, session resume, reconnection
- **M2 ✅** driver token, suggestion queue, shared approval gate
- **MVP ✅** agent writes with lost-update protection, one-command start, auth
- **M3 ✅** CRDT buffers: people and the agent edit the same live document
- **M4 ✅** checkpoint rewind, session fork, audit export
- **Desktop app** ship as a VS Code fork rather than an extension, so there is
  an installer instead of "build the repo and keep it on disk"
- **Hosting** relay on a server, TLS, real accounts, org-level billing

Open work — including the one probe that has never been run — is tracked in
[`TASKS.md`](TASKS.md).

## Tests and measurement

```bash
pnpm test        # ordering, replay, compaction, folded state, driver policy
pnpm typecheck
```

`fixtures/demo-repo` is a tiny project for exercising a shared session.

`tools/count-frames.mjs` counts streaming frames against characters delivered:

```bash
node tools/count-frames.mjs "In exactly 200 words, explain event sourcing."
```

Three probes check assumptions about the SDK that the design rests on, and all
should be re-run after an upgrade:

```bash
cd packages/agent-host
node probe-gate.mjs deny   # a denied tool call must NOT execute
node probe-posttool.mjs    # PostToolUse additionalContext must reach the model
node probe-rewind.mjs      # prompt uuids, rewindFiles, forkSession
```

The second is what lets the agent be told that part of its edit did not land.
Without that channel it reports success for work it did not do.

The third covers M4, where the load-bearing behaviour is entirely the SDK's:
prompts must come back through the stream carrying a `uuid` (or a checkpoint has
nothing to anchor to), `rewindFiles` must actually restore a file (or a rewind
rolls back the transcript and leaves the edits on disk), and a forked session
must be resumable (or a fork produces a room whose agent remembers nothing).

`count-frames.mjs` exists because an assumption cost real work. A buffering layer was added to
the agent-host to coalesce "per-token" deltas; measurement showed this SDK
already delivers ~260-character chunks (about five per response), so the frame
count was **identical** with and without it and the buffering only added
latency. It was removed. Re-run this before adding any batching, or after
changing model or provider.

