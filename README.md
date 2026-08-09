# Multiplayer Agent Sessions

Several people share **one live agent session** — same prompts, same tool calls,
same diffs, same approvals — from inside VS Code.

The product is not the editor integration. It is the **shared, replayable event
log with real concurrency control**. Everything a client shows is derived state
folded from that log, so someone joining ten minutes late sees exactly what
everyone else sees.

Status: **working MVP** — several people share one agent that can read, run
commands and change code, with concurrency control and an auth gate. See
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
| `packages/sync-server` | WebSocket relay, event log, replay |
| `packages/agent-host` | Agent SDK wrapper: prompt queue, event translation |
| `packages/vscode-ext` | Extension + shared agent panel webview |

Two seams are load-bearing for where this goes next. `EventStore` keeps SQLite
swappable for Postgres when rooms outgrow one machine, and `Authenticator` keeps
the shared token swappable for real accounts when the relay stops being
something you run on your laptop.

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
room is worse than a cancelled turn.

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
moved, for everyone — VS Code reloads an unmodified open file from disk by
itself, but with no indication of which of your twelve open files it was.

### The lost-update problem

The agent writes to disk out of band from every editor buffer. So if someone has
unsaved changes in `login.ts` and the agent rewrites it, their work is gone, with
no undo and no warning.

Approving harder does not fix this: the person clicking Approve is consenting to
the change, and has no way of knowing a colleague is mid-edit. So editors report
their dirty files and **the relay refuses the write before anyone is asked**:

```
⛔ system denied the tool call
   bob has unsaved changes in that file. Ask them to save, or come back to it.
```

The agent is told who is holding it and says so rather than retrying. The
refusal is computed before the request is broadcast and applied in the same
tick, so it is not a race an eager approver can win.

Not yet CRDT-backed shared buffers — the agent writes to disk and everyone
reloads. That is honest for an MVP and enough to keep the failure mode above
from ever happening; live co-editing is the next milestone.

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
3. Everything else **asks the room** and blocks until the driver decides. Writes
   additionally cannot touch a file someone is still editing.
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
- **M3** CRDT buffers, so people and the agent edit the same live document
- **M4** checkpoint rewind, session fork, audit export
- **Hosting** relay on a server, TLS, real accounts, org-level billing

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

`packages/agent-host/probe-gate.mjs` checks that a denied tool call really does
not execute — see "The approval gate" above.

`count-frames.mjs` exists because an assumption cost real work. A buffering layer was added to
the agent-host to coalesce "per-token" deltas; measurement showed this SDK
already delivers ~260-character chunks (about five per response), so the frame
count was **identical** with and without it and the buffering only added
latency. It was removed. Re-run this before adding any batching, or after
changing model or provider.

