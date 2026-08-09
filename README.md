# Multiplayer Agent Sessions

Several people share **one live agent session** — same prompts, same tool calls,
same diffs, same approvals — from inside VS Code.

The product is not the editor integration. It is the **shared, replayable event
log with real concurrency control**. Everything a client shows is derived state
folded from that log, so someone joining ten minutes late sees exactly what
everyone else sees.

Status: **M2 complete** (see `Milestones` below).

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

## Prerequisites

- Node 22+, pnpm 11+
- **Anthropic auth.** The Agent SDK needs an API key (`ANTHROPIC_API_KEY`) for
  anything beyond personal experimentation — subscription credentials may not
  be used to serve other users. See "Auth and billing" in the plan.

## Run it

```bash
pnpm install
pnpm build

# 1. relay
pnpm relay

# 2. VS Code Extension Development Host
#    F5 in this repo, or:
code --extensionDevelopmentPath=$PWD/packages/vscode-ext <some-project>
```

In the dev host: **Multiplayer Agent: Host Session** (spawns the agent) in one
window, **Multiplayer Agent: Join Session** with the same room name in another.

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

## Safety note

In host-laptop mode a **guest's prompt runs tools on the host's machine with the
host's credentials.** Three layers, in order:

1. `MPA_ALLOWED_TOOLS` (default `Read,Glob,Grep`) runs without asking. Reading
   is cheap and reversible; waiting on a human for it would make the session
   unusable without making it safer.
2. Everything else **asks the room** and blocks until the driver decides.
3. `MPA_DISALLOWED_TOOLS` (default `Write,Edit,MultiEdit,NotebookEdit`) can be
   approved by nobody. File writes stay here until M3 routes them through the
   shared document — a write that silently clobbers someone's unsaved buffer is
   not made safe by approving it.

Layer 3 is also a backstop: a bug in layer 2 must not become arbitrary writes to
the host's disk.

Note that `allowedTools` is deliberately **not** passed to the SDK. A bare tool
name there auto-approves it before any callback runs, which is exactly the
shadowing the gate has to avoid — the SDK warns about this, and it is why layer
1 is applied by our own hook.

## Milestones

- **M0 ✅** streaming shared session: everyone watches one agent live
- **M1 ✅** durable log, session resume, reconnection
- **M2 ✅** driver token, suggestion queue, shared approval gate
- **M3** CRDT buffers, agent writes routed into the shared document
- **M4** checkpoint rewind, session fork, audit export

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

