// @ts-check
/**
 * Folds the shared event log into everything on screen.
 *
 * Replayed and live events run through the same reducer, so a participant who
 * joins ten minutes late sees exactly what everyone else sees — the transcript,
 * who is driving, what is queued, what is awaiting approval and who has spent
 * what. None of that is fetched or pushed as separate state; it is all derived
 * from the log, which is why it is consistent by construction.
 *
 * Ordering comes from the relay's `seq`; this view never invents its own.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const transcriptEl = document.getElementById("transcript");
  const participantsEl = document.getElementById("participants");
  const statusEl = document.getElementById("status");
  const driverbarEl = document.getElementById("driverbar");
  const approvalsEl = document.getElementById("approvals");
  const queueEl = document.getElementById("queue");
  const ledgerEl = document.getElementById("ledger");
  const changedFilesEl = document.getElementById("changed");
  const sendEl = document.getElementById("send");
  const inputEl = /** @type {HTMLTextAreaElement} */ (
    document.getElementById("input")
  );
  const dotEl = document.getElementById("dot");

  /** id -> {el, kind} for items updated in place (streaming text, tool results). */
  const items = new Map();
  let lastSeq = -1;

  /**
   * Event types this panel deliberately does not render.
   *
   * Everything else that reaches the switch's `default` is reported to the
   * console, so adding an event type to the protocol and forgetting the UI
   * shows up as a complaint rather than as a silent hole in the transcript.
   */
  const SILENT = new Set([
    // One per turn, recorded so the room can be rewound to it. Rendering every
    // one would be pure noise; the rewind that uses it is what people see.
    "checkpoint.created",
  ]);

  // ---- folded state -------------------------------------------------------

  /** @type {{userId: string, name: string} | null} */
  let me = null;
  /** @type {Array<{userId: string, name: string, role: string}>} */
  let participants = [];

  /** @type {{userId: string, name: string} | null} */
  let driver = null;
  /** @type {Array<{userId: string, name: string}>} */
  let driverRequests = [];
  /** suggestionId -> {text, author} */
  const suggestions = new Map();
  /** requestId -> {toolName, input} for calls still suspended */
  const approvals = new Map();
  /** path -> times changed, so the room can see what the agent actually did */
  const changedFiles = new Map();
  /**
   * Prompts accepted while the agent is mid-turn. The SDK queues them, but
   * silently — without this a second prompt reads as having been swallowed.
   */
  const queuedPrompts = [];
  let agentBusy = false;

  /** promptId -> author, and turnId -> promptId, so a turn's cost has an owner. */
  const promptAuthors = new Map();
  const turnPrompts = new Map();
  /** userId -> {name, costUsd, turns} */
  const ledger = new Map();
  let totalCostUsd = 0;

  const isDriver = () => Boolean(me && driver && driver.userId === me.userId);

  // ---- rendering ----------------------------------------------------------

  let renderQueued = false;

  /** Regions are small and rebuilt wholesale; batching keeps replay cheap. */
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderDriverBar();
      renderApprovals();
      renderQueue();
      renderChangedFiles();
      renderLedger();
      renderComposer();
    });
  }

  function button(label, className, onClick, title) {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = className;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderDriverBar() {
    driverbarEl.replaceChildren();
    if (!driver) {
      driverbarEl.append(text("span", "muted", "nobody is driving"));
      driverbarEl.append(
        button("Take the wheel", "primary", () =>
          vscode.postMessage({ type: "requestDriver" }),
        ),
      );
      return;
    }

    const driving = isDriver();
    driverbarEl.append(
      text("span", "who-drives", driving ? "🎧 You are driving" : `🎧 ${driver.name} is driving`),
    );

    if (driving) {
      // Requests are shown to the driver as an offer to hand over, because the
      // token is only useful if passing it is easier than arguing about it.
      for (const r of driverRequests) {
        if (r.userId === driver.userId) continue;
        driverbarEl.append(
          button(`Hand to ${r.name}`, "primary", () =>
            vscode.postMessage({ type: "grantDriver", userId: r.userId }),
          ),
        );
      }
      driverbarEl.append(
        button("Release", "", () => vscode.postMessage({ type: "releaseDriver" })),
      );
    } else {
      const asked = driverRequests.some((r) => me && r.userId === me.userId);
      const offline = !participants.some((p) => p.userId === driver.userId);
      driverbarEl.append(
        button(
          asked ? "Asked to drive…" : offline ? "Take over (offline)" : "Ask to drive",
          asked ? "" : "primary",
          () => vscode.postMessage({ type: "requestDriver" }),
          offline
            ? "The driver is disconnected, so the token is free to take"
            : "The driver is asked to hand over",
        ),
      );
    }
  }

  const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

  /**
   * Describe what is actually about to happen.
   *
   * "Agent wants to run Edit" plus a blob of JSON is not something a person can
   * consent to in the two seconds they will spend on it. For a write, the file
   * and the change are the whole decision, so they get shown as a diff.
   */
  function describeApproval(card, toolName, input) {
    const args = input && typeof input === "object" ? input : {};
    const file = args.file_path ?? args.notebook_path ?? args.path;

    if (WRITE_TOOLS.has(toolName) && typeof file === "string") {
      card.append(text("div", "who", `⏸ Agent wants to edit ${basename(file)}`));
      card.append(text("div", "filepath", file));

      const edits = Array.isArray(args.edits)
        ? args.edits
        : args.old_string !== undefined
          ? [{ old_string: args.old_string, new_string: args.new_string }]
          : [];

      if (edits.length > 0) {
        const diff = document.createElement("pre");
        diff.className = "args diff";
        for (const edit of edits) {
          diff.append(text("span", "del", prefixLines(edit.old_string, "-")));
          diff.append(text("span", "add", prefixLines(edit.new_string, "+")));
        }
        card.append(diff);
      } else if (typeof args.content === "string") {
        card.append(
          text("pre", "args add", prefixLines(args.content, "+")),
        );
      } else {
        card.append(text("pre", "args", stringify(input)));
      }
      return;
    }

    if (toolName === "Bash" && typeof args.command === "string") {
      card.append(text("div", "who", "⏸ Agent wants to run a command"));
      card.append(text("pre", "args", args.command));
      if (typeof args.description === "string") {
        card.append(text("div", "muted", args.description));
      }
      return;
    }

    card.append(text("div", "who", `⏸ Agent wants to run ${toolName}`));
    card.append(text("pre", "args", stringify(input)));
  }

  function prefixLines(value, marker) {
    if (typeof value !== "string" || value === "") return "";
    return `${value
      .split("\n")
      .map((line) => `${marker} ${line}`)
      .join("\n")}\n`;
  }

  function basename(p) {
    const parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  function renderApprovals() {
    approvalsEl.replaceChildren();
    for (const [requestId, a] of approvals) {
      const card = document.createElement("div");
      card.className = "approval";

      describeApproval(card, a.toolName, a.input);

      const row = document.createElement("div");
      row.className = "row";
      if (isDriver()) {
        row.append(
          button("Approve", "primary", () =>
            vscode.postMessage({ type: "decideApproval", requestId, allow: true }),
          ),
        );
        row.append(
          button("Deny", "danger", () =>
            vscode.postMessage({ type: "decideApproval", requestId, allow: false }),
          ),
        );
      } else {
        row.append(
          text(
            "span",
            "muted",
            driver
              ? `waiting for ${driver.name} to decide`
              : "waiting for someone to take the wheel",
          ),
        );
      }
      card.append(row);
      approvalsEl.append(card);
    }
  }

  function renderQueue() {
    queueEl.replaceChildren();
    if (suggestions.size === 0) return;

    queueEl.append(
      text("div", "queue-title", `${suggestions.size} suggested`),
    );
    for (const [suggestionId, s] of suggestions) {
      const row = document.createElement("div");
      row.className = "suggestion";
      row.append(text("span", "who", s.author.name));
      row.append(text("span", "body", s.text));
      if (isDriver()) {
        row.append(
          button("Run", "primary", () =>
            vscode.postMessage({ type: "promoteSuggestion", suggestionId }),
          ),
        );
        row.append(
          button("Dismiss", "", () =>
            vscode.postMessage({ type: "dismissSuggestion", suggestionId }),
          ),
        );
      }
      queueEl.append(row);
    }
  }

  /**
   * What the agent changed, for everyone rather than only the host.
   *
   * Anyone holding the file open already has the change — merged into their
   * buffer if they were editing it, reloaded from disk if not — but with no
   * indication that it moved, or which of the twelve open files it was.
   */
  function renderChangedFiles() {
    changedFilesEl.replaceChildren();
    if (changedFiles.size === 0) return;

    changedFilesEl.append(
      text("div", "queue-title", `${changedFiles.size} file(s) changed by the agent`),
    );
    for (const [path, count] of changedFiles) {
      const row = document.createElement("div");
      row.className = "changed";
      const open = button(basename(path), "link", () =>
        vscode.postMessage({ type: "openFile", path }),
      );
      open.title = path;
      row.append(open);
      if (count > 1) row.append(text("span", "muted", `×${count}`));
      changedFilesEl.append(row);
    }
  }

  function renderLedger() {
    if (totalCostUsd === 0) {
      ledgerEl.textContent = "";
      return;
    }
    // Folded from per-turn deltas rather than read off the agent's running
    // total, which restarts at zero whenever the session is resumed.
    const parts = [...ledger.values()]
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 3)
      .map((e) => `${e.name} $${e.costUsd.toFixed(2)}`);
    ledgerEl.textContent = `$${totalCostUsd.toFixed(2)} · ${parts.join(" · ")}`;
  }

  function renderComposer() {
    const driving = isDriver();
    sendEl.textContent = driving ? "Send" : "Suggest";
    inputEl.placeholder = driving
      ? "Prompt the shared agent… (Enter to send, Shift+Enter for newline)"
      : `Suggest a prompt for ${driver ? driver.name : "the driver"} to run…`;

    if (queuedPrompts.length > 0) {
      statusEl.textContent = `${queuedPrompts.length} prompt(s) waiting for the agent to finish`;
    }
  }

  function text(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = content;
    return el;
  }

  function stringify(value) {
    try {
      return JSON.stringify(value, null, 1);
    } catch {
      return String(value);
    }
  }

  function actorName(actor) {
    if (actor.kind === "user") return actor.name;
    if (actor.kind === "agent") return "Agent";
    return "system";
  }

  function ensureItem(id, kind, build) {
    let entry = items.get(id);
    if (!entry) {
      const el = build();
      transcriptEl.appendChild(el);
      entry = { el, kind };
      items.set(id, entry);
    }
    return entry;
  }

  let scrollQueued = false;

  /**
   * Reading scrollHeight forces a synchronous layout, so doing it per token
   * thrashes the compositor during a long answer. Coalescing into one frame
   * keeps streaming smooth.
   */
  function scrollToEnd() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      // Only follow the tail if the reader is already near it, so scrolling
      // back through history isn't yanked away when the agent keeps talking.
      const nearBottom =
        transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 120;
      if (nearBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    });
  }

  /**
   * Pending-turn indicator.
   *
   * Between `turn.started` and the first token there can be a long, silent gap.
   * For someone who typed the prompt that reads as waiting; for everyone else
   * watching it is indistinguishable from a broken session. An explicit
   * placeholder with a running clock removes the ambiguity.
   */
  let pendingEl = null;
  let pendingTimer = null;

  function showPending() {
    clearPending();
    const started = Date.now();
    pendingEl = addBlock("pending", "Agent", "working…");
    transcriptEl.appendChild(pendingEl);
    const body = pendingEl.querySelector(".body");
    pendingTimer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      body.textContent = `working… ${secs}s`;
    }, 1000);
    scrollToEnd();
  }

  function clearPending() {
    if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
  }

  function addBlock(className, headerText, bodyText) {
    const div = document.createElement("div");
    div.className = `item ${className}`;
    if (headerText) {
      const h = document.createElement("div");
      h.className = "who";
      h.textContent = headerText;
      div.appendChild(h);
    }
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = bodyText ?? "";
    div.appendChild(body);
    return div;
  }

  function meta(line) {
    transcriptEl.appendChild(addBlock("meta", "", line));
  }

  function apply(event, replay) {
    // The relay is the ordering authority; drop anything we've already folded.
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;

    const b = event.body;
    const who = actorName(event.actor);
    // Where the transcript ended before this event, so anything it renders can
    // be stamped with the seq that produced it. That stamp is what lets a
    // rewind take exactly its own range back off the screen.
    const renderedBefore = transcriptEl.childElementCount;

    // Any real output means the agent is no longer merely pending.
    if (
      b.type === "assistant.delta" ||
      b.type === "assistant.message" ||
      b.type === "thinking.delta" ||
      b.type === "tool.requested"
    ) {
      clearPending();
    }

    switch (b.type) {
      case "prompt.submitted": {
        promptAuthors.set(b.promptId, {
          userId: event.actor.kind === "user" ? event.actor.userId : "agent",
          name: who,
        });
        const header = b.promotedBy
          ? `${who} · run by ${b.promotedBy.name}`
          : who;
        transcriptEl.appendChild(addBlock("prompt", header, b.text));
        // Accepted, but the agent is still on the previous one. Saying so is
        // the difference between "queued" and "did that even send?".
        if (agentBusy) queuedPrompts.push(b.promptId);
        break;
      }

      case "assistant.delta": {
        const entry = ensureItem(`msg:${b.messageId}`, "text", () =>
          addBlock("assistant", "Agent", ""),
        );
        entry.el.querySelector(".body").textContent += b.text;
        break;
      }

      case "assistant.message": {
        // Authoritative text replaces whatever the deltas accumulated.
        const entry = ensureItem(`msg:${b.messageId}`, "text", () =>
          addBlock("assistant", "Agent", ""),
        );
        entry.el.querySelector(".body").textContent = b.text;
        break;
      }

      case "thinking.delta": {
        const entry = ensureItem(`think:${b.messageId}`, "text", () =>
          addBlock("thinking", "thinking", ""),
        );
        entry.el.querySelector(".body").textContent += b.text;
        break;
      }

      case "tool.requested": {
        const entry = ensureItem(`tool:${b.toolUseId}`, "tool", () =>
          addBlock("tool", `🔧 ${b.name}`, ""),
        );
        entry.el.querySelector(".body").textContent = stringify(b.input);
        break;
      }

      case "tool.result": {
        const entry = items.get(`tool:${b.toolUseId}`);
        if (!entry) break;
        const result = document.createElement("div");
        result.className = `result ${b.isError ? "error" : "ok"}`;
        result.textContent = b.preview;
        entry.el.appendChild(result);
        break;
      }

      case "turn.started": {
        dotEl.className = "dot busy";
        agentBusy = true;
        if (b.promptId) {
          turnPrompts.set(b.turnId, b.promptId);
          const at = queuedPrompts.indexOf(b.promptId);
          if (at >= 0) queuedPrompts.splice(at, 1);
        }
        // Replayed history already contains the outcome; a placeholder would
        // just be a stale spinner in the middle of the transcript.
        if (!replay) showPending();
        break;
      }

      case "turn.completed": {
        clearPending();
        agentBusy = false;
        const cost = b.usage.costUsd ?? 0;
        creditCost(b.turnId, cost);
        meta(
          `turn complete · $${cost.toFixed(4)} · ${b.usage.durationMs ?? "?"}ms`,
        );
        dotEl.className = "dot";
        break;
      }

      case "turn.interrupted": {
        clearPending();
        agentBusy = false;
        meta("turn interrupted");
        dotEl.className = "dot";
        break;
      }

      case "file.changed": {
        changedFiles.set(b.path, (changedFiles.get(b.path) ?? 0) + 1);
        meta(`✎ ${b.tool} changed ${basename(b.path)}`);
        break;
      }

      case "doc.merged": {
        const detail = [`${b.applied} change(s)`];
        if (b.moved > 0) detail.push(`${b.moved} shifted around live edits`);
        const open = b.holders.length ? ` · open by ${b.holders.join(", ")}` : "";
        meta(`⇄ merged into ${basename(b.path)} — ${detail.join(", ")}${open}`);

        // A skipped hunk means part of the agent's change is simply not in the
        // file. Nobody would guess that from a status line, so it gets said
        // properly, next to the transcript it belongs to.
        if (b.conflicts > 0) {
          transcriptEl.appendChild(
            addBlock(
              "conflict",
              `${basename(b.path)}`,
              `${b.conflicts} of the agent's changes were not applied: someone had already ` +
                "rewritten those lines. Their version was kept — ask the agent to look again.",
            ),
          );
        }
        break;
      }

      // ---- concurrency control ------------------------------------------
      case "driver.granted": {
        driver = { userId: b.userId, name: b.name };
        driverRequests = driverRequests.filter((r) => r.userId !== b.userId);
        meta(
          b.reason === "handoff" && b.from
            ? `${b.from.name} handed the wheel to ${b.name}`
            : b.reason === "idle"
              ? `${b.name} took the wheel (previous driver idle)`
              : b.reason === "offline"
                ? `${b.name} took the wheel (previous driver disconnected)`
                : `${b.name} is driving`,
        );
        break;
      }

      case "driver.released": {
        if (driver && driver.userId === b.userId) driver = null;
        meta(`${b.name} released the wheel`);
        break;
      }

      case "driver.requested": {
        if (!driverRequests.some((r) => r.userId === b.userId)) {
          driverRequests.push({ userId: b.userId, name: b.name });
        }
        meta(`${b.name} asked to drive`);
        break;
      }

      case "suggestion.queued": {
        suggestions.set(b.suggestionId, {
          text: b.text,
          author: {
            userId: event.actor.kind === "user" ? event.actor.userId : "agent",
            name: who,
          },
        });
        break;
      }

      case "suggestion.promoted": {
        suggestions.delete(b.suggestionId);
        break;
      }

      case "suggestion.dismissed": {
        suggestions.delete(b.suggestionId);
        meta(`${who} dismissed a suggestion`);
        break;
      }

      case "tool.approval.requested": {
        approvals.set(b.requestId, { toolName: b.toolName, input: b.input });
        meta(`⏸ waiting for approval to run ${b.toolName}`);
        break;
      }

      case "tool.approval.decided": {
        approvals.delete(b.requestId);
        meta(
          `${b.allow ? "✅" : "⛔"} ${who} ${b.allow ? "approved" : "denied"} the tool call` +
            (b.reason ? ` — ${b.reason}` : ""),
        );
        break;
      }

      case "room.joined": {
        meta(`${b.name} joined`);
        break;
      }

      case "room.left": {
        meta(`${b.name} left`);
        break;
      }

      case "agent.status": {
        meta(`agent ${b.state}${b.detail ? ` — ${b.detail}` : ""}`);
        break;
      }

      // ---- checkpoints, rewind and fork (M4) -----------------------------
      case "checkpoint.restored": {
        // The same rule the relay applies when replaying to a late joiner:
        // the superseded range stops counting. Doing it here as well is what
        // makes someone who watched the turn happen end up looking at the
        // same transcript as someone who arrives afterwards.
        dropRange(b.fromSeq, event.seq);
        const parts = [`⏪ ${who} rewound the session to “${b.label}”`];
        if (b.filesChanged.length > 0) {
          parts.push(
            `${b.filesChanged.length} file(s) restored (+${b.insertions}/-${b.deletions})`,
          );
        }
        if (b.skippedLinks > 0) {
          parts.push(
            `⚠️ ${b.skippedLinks} NOT restored — unsafe symlink or moved directory`,
          );
        }
        meta(parts.join(" · "));
        break;
      }

      case "checkpoint.failed": {
        meta(`⚠️ rewind failed — ${b.reason}`);
        break;
      }

      case "room.forked": {
        meta(
          b.toRoomId
            ? `🌿 ${who} forked “${b.label}” into room ${b.toRoomId} — this room carries on`
            : `🌿 branched from ${b.fromRoomId ?? "another room"} at “${b.label}”`,
        );
        break;
      }

      default: {
        // An event type nobody renders is almost always one somebody forgot,
        // and it used to fail silently: the transcript simply had a hole in it.
        // Types that are deliberately invisible are named in SILENT above, so
        // anything reaching here is worth a complaint in the devtools console.
        if (!SILENT.has(b.type)) {
          console.warn(`[panel] no renderer for event type "${b.type}"`);
        }
        break;
      }
    }

    // Stamp whatever this event just rendered, so a later rewind can find it.
    for (let i = renderedBefore; i < transcriptEl.childElementCount; i++) {
      transcriptEl.children[i].dataset.seq = String(event.seq);
    }

    scrollToEnd();
    scheduleRender();
  }

  /**
   * Take a superseded stretch of transcript back off the screen.
   *
   * Half-open `[from, to)`. This is the third implementation of that rule —
   * the relay and the extension share `withinRange` from `@mpa/protocol`, but
   * a webview script cannot import it, so this copy is deliberate. Keep it in
   * step with `protocol/src/checkpoints.ts`.
   *
   * Elements carry the seq that produced them, so this removes exactly the
   * range the rewind abandoned and leaves everything before it untouched.
   */
  function dropRange(from, to) {
    for (const el of [...transcriptEl.children]) {
      const seq = Number(el.dataset.seq);
      if (Number.isFinite(seq) && seq >= from && seq < to) el.remove();
    }
    // Anything keyed to a removed bubble would otherwise be reused by a later
    // message with the same id and reappear inside the rewound range.
    for (const [key, entry] of items) {
      if (!entry.el.isConnected) items.delete(key);
    }
  }

  /** Attribute a turn's cost to whoever's prompt started it. */
  function creditCost(turnId, cost) {
    totalCostUsd += cost;
    const author = promptAuthors.get(turnPrompts.get(turnId));
    const key = author ? author.userId : "agent";
    const name = author ? author.name : "Agent";
    const entry = ledger.get(key) ?? { name, costUsd: 0, turns: 0 };
    entry.name = name;
    entry.costUsd += cost;
    entry.turns += 1;
    ledger.set(key, entry);
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") {
      apply(msg.event, msg.replay === true);
    } else if (msg.type === "identity") {
      me = { userId: msg.you.userId, name: msg.you.name };
      scheduleRender();
    } else if (msg.type === "participants") {
      participants = msg.participants;
      participantsEl.textContent = participants
        .map((p) => (p.role === "agent-host" ? "🤖 Agent" : p.name))
        .join(" · ");
      scheduleRender();
    } else if (msg.type === "status") {
      statusEl.textContent = msg.text;
    }
  });

  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    // Deliberately the same message whether or not we are driving: the relay
    // decides, so a stale idea of who holds the token cannot jump the queue.
    vscode.postMessage({ type: "submit", text });
    inputEl.value = "";
  }

  sendEl.addEventListener("click", submit);
  document.getElementById("interrupt").addEventListener("click", () => {
    vscode.postMessage({ type: "interrupt" });
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  scheduleRender();
})();
