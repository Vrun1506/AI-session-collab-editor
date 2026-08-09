# Multiplayer Agent Sessions

Several people share **one live agent session** — same prompts, same tool calls,
same diffs, same approvals — from inside VS Code.

The product is not the editor integration. It is the **shared, replayable event
log with real concurrency control**. Everything a client shows is derived state
folded from that log, so someone joining ten minutes late sees exactly what
everyone else sees.

Status: **M0 complete** (see `Milestones` below).

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

The headless client reproduces the whole M0 scenario and is the fastest way to
check ordering, streaming and late-join:

```bash
MPA_ROOM=demo MPA_CWD=/path/to/project node packages/agent-host/dist/index.js &
MPA_ROOM=demo node packages/sync-server/dist/test-client.js bob &          # observer
MPA_ROOM=demo node packages/sync-server/dist/test-client.js alice "your prompt"
```

Bob sees Alice's prompt, the live token stream, every tool call and the cost.

## Safety note

In host-laptop mode a **guest's prompt runs tools on the host's machine with the
host's credentials**. `allowedTools` is an auto-approve list, *not* a
restriction — the read-only guarantee comes from `MPA_DISALLOWED_TOOLS`, which
denies `Bash`/`Write`/`Edit` and friends by default. Do not relax it before the
M2 approval gate exists.

## Milestones

- **M0 ✅** streaming shared session: everyone watches one agent live
- **M1** persistent log, late-join replay from seq, presence/cursors
- **M2** driver token, suggestion queue, shared approval gate via `canUseTool`
- **M3** CRDT buffers, agent writes routed into the shared document
- **M4** checkpoint rewind, session fork, audit export

## Tests and measurement

```bash
pnpm test        # relay ordering, replay and compaction invariants
pnpm typecheck
```

`fixtures/demo-repo` is a tiny project for exercising a shared session.

`tools/count-frames.mjs` counts streaming frames against characters delivered:

```bash
node tools/count-frames.mjs "In exactly 200 words, explain event sourcing."
```

It exists because an assumption cost real work. A buffering layer was added to
the agent-host to coalesce "per-token" deltas; measurement showed this SDK
already delivers ~260-character chunks (about five per response), so the frame
count was **identical** with and without it and the buffering only added
latency. It was removed. Re-run this before adding any batching, or after
changing model or provider.

