// @ts-check
/**
 * Folds the shared event log into a transcript.
 *
 * Replayed and live events run through the same reducer, so a participant who
 * joins ten minutes late sees exactly what everyone else sees. Ordering comes
 * from the relay's `seq`; this view never invents its own.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const transcriptEl = document.getElementById("transcript");
  const participantsEl = document.getElementById("participants");
  const statusEl = document.getElementById("status");
  const inputEl = /** @type {HTMLTextAreaElement} */ (
    document.getElementById("input")
  );
  const dotEl = document.getElementById("dot");

  /** id -> {el, kind} for items that get updated in place (streaming text, tool results). */
  const items = new Map();
  let lastSeq = -1;

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

  function apply(event, replay) {
    // The relay is the ordering authority; drop anything we've already folded.
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;

    const b = event.body;
    const who = actorName(event.actor);

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
        const el = addBlock("prompt", who, b.text);
        transcriptEl.appendChild(el);
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
        entry.el.querySelector(".body").textContent = JSON.stringify(
          b.input,
          null,
          1,
        );
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

      case "turn.completed": {
        clearPending();
        const cost = b.usage.costUsd;
        const el = addBlock(
          "meta",
          "",
          `turn complete · $${(cost ?? 0).toFixed(4)} · ${b.usage.durationMs ?? "?"}ms`,
        );
        transcriptEl.appendChild(el);
        dotEl.className = "dot";
        break;
      }

      case "turn.started": {
        dotEl.className = "dot busy";
        // Replayed history already contains the outcome; a placeholder would
        // just be a stale spinner in the middle of the transcript.
        if (!replay) showPending();
        break;
      }

      case "turn.interrupted": {
        clearPending();
        transcriptEl.appendChild(addBlock("meta", "", "turn interrupted"));
        dotEl.className = "dot";
        break;
      }

      case "room.joined": {
        transcriptEl.appendChild(addBlock("meta", "", `${b.name} joined`));
        break;
      }

      case "room.left": {
        transcriptEl.appendChild(addBlock("meta", "", `${b.name} left`));
        break;
      }

      case "agent.status": {
        transcriptEl.appendChild(
          addBlock("meta", "", `agent ${b.state}${b.detail ? ` — ${b.detail}` : ""}`),
        );
        break;
      }
    }
    scrollToEnd();
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") apply(msg.event, msg.replay === true);
    else if (msg.type === "participants") {
      participantsEl.textContent = msg.participants
        .map((p) => (p.role === "agent-host" ? "🤖 Agent" : p.name))
        .join(" · ");
    } else if (msg.type === "status") {
      statusEl.textContent = msg.text;
    }
  });

  function submit() {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "submit", text });
    inputEl.value = "";
  }

  document.getElementById("send").addEventListener("click", submit);
  document.getElementById("interrupt").addEventListener("click", () => {
    vscode.postMessage({ type: "interrupt" });
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
})();
