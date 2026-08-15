# Open work

Known-and-deferred, not forgotten. `ARCHITECTURE.md` explains *why* each of
these is awkward; this file says what to do about it. Ordered by what would
hurt most if left alone.

## Blocking trust

### 1. Run `probe-rewind.mjs` — never executed

```bash
cd packages/agent-host && node probe-rewind.mjs
```

Needs `ANTHROPIC_API_KEY`, which has not been available in any session so far.

M4's rewind rests on three assumptions about the Agent SDK that are **asserted
but unverified**:

- **A.** a prompt echo carries a stable `uuid` that `rewindFiles` accepts
- **B.** `rewindFiles` restores *only* files the turn touched, and reports them
- **C.** `resumeSessionAt` resumes with the turn absent from the agent's memory

The design is written so a failure is survivable: A and C degrade to a worse
rewind. **B does not.** If `rewindFiles` restores more than the turn's own
files, a rewind silently reverts work nobody asked it to touch — and because
the log supersedes rather than deletes, the transcript would show a range hidden
that does not match what happened on disk. **If B fails, rewind must not ship.**

Re-run all three probes after any SDK upgrade.

## Test coverage gaps

Both are behind the `vscode` import, which is why they have no tests: the module
can't be loaded outside the extension host. The fix in each case is the one that
worked for `docsync.ts` — pull the decisions into a plain module and test those,
leaving an adapter that only makes API calls. `buffer-rules.ts` is the pattern.

### 2. `session.ts` (~420 lines)

Reconnect and replay cursor, the checkpoint list, and **a second implementation
of the relay's supersession rule**. That last one is the real risk: two copies
of a half-open interval that can drift into a client offering a checkpoint the
rest of the room has discarded. It now calls `isSuperseded`/`withinRange` from
`@mpa/protocol`, but nothing tests that the extension applies them at the same
moments the relay does.

Cover: replay-cursor advancement, dedupe on `seq`, reconnect backoff, and
checkpoint eviction on `checkpoint.restored`.

### 3. `extension.ts` (~353 lines)

Activation, command registration, host-vs-guest branching, agent-host spawn.

Cover: role selection, what each command requires (driver token held, no open
turn, relay connected), and the spawn/teardown lifecycle.

Note both files get substantially rewritten by the fork — worth doing *after*
the shell lands, so the tests are written against the code that survives.

## Papercuts

### 4. `test-client.ts` is not a test

It is a headless editor peer. Node's `--test` treats `test-*.js` as a test file
and the client never exits, which is why the test scripts use an explicit
`dist/**/*.test.js` glob rather than a directory. Rename to `peer-client.ts`,
update the scripts and the README, and the glob can relax.

### 5. Event fan-out is a checklist, not a type

Adding an event type means remembering four readers — `Room.fold`, `audit.ts`,
`session.ts`, `panel.js` — with no enforcement. Contrast with wire messages,
where the relay's dispatch table makes a missing handler a compile error; that
table caught a real bug the first time it was used.

Make each TS reader an exhaustive `Record<SessionEvent["body"]["type"], …>`. The
webview can't import protocol types at all, so it needs a generated manifest
checked at runtime — its `default` arm warning is the only safety net today.

## Next milestone

### 6. Fork VS Code as a thin branded shell

So there is an installer instead of "build the repo and keep it on disk".

Scope, deliberately minimal:

- `product.json` branding **only**
- `mpa-vscode` bundled as a built-in extension
- `agent-host` shipped alongside the app binary
- **no core patches**
- Open VSX as the marketplace

Maintain the diff as a **patch series over an upstream tag**, VSCodium-style,
rather than a merge fork — upstream moves fast and a merge fork turns every
rebase into a negotiation. The moment a core patch feels necessary, stop and ask
whether an extension API can do it instead; that is the line between this and a
maintenance burden.
