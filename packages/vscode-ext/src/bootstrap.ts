import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";

/**
 * Getting from "extension installed" to "session running" without a terminal.
 *
 * The relay and the agent-host are separate processes on purpose — that seam is
 * what lets the agent move into a cloud sandbox later. But an MVP where the
 * first step is "open a terminal and run two commands you have to remember" is
 * one people bounce off, so the extension starts what is missing.
 */

export interface ResolvedPaths {
  relayEntry: string;
  agentHostEntry: string;
}

/**
 * Locate the two server entry points.
 *
 * The agent-host deliberately does not ship inside the .vsix: the Agent SDK
 * pulls in a ~270MB platform-specific native binary, which would make the
 * extension both enormous and wrong on every other OS. So the packages have to
 * exist on disk, and the honest thing is to say so clearly when they do not.
 */
export function resolveServerPaths(
  extensionPath: string,
  overrides: { relay?: string; agentHost?: string },
): ResolvedPaths | { error: string } {
  const relayEntry =
    firstExisting(
      overrides.relay,
      path.join(extensionPath, "..", "sync-server", "dist", "index.js"),
    ) ?? "";
  const agentHostEntry =
    firstExisting(
      overrides.agentHost,
      path.join(extensionPath, "agent-host", "dist", "index.js"),
      path.join(extensionPath, "..", "agent-host", "dist", "index.js"),
    ) ?? "";

  if (!relayEntry || !agentHostEntry) {
    return {
      error:
        "Could not find the Multiplayer Agent servers. Run `pnpm install && pnpm build` " +
        "in the repo, then set `mpa.relayEntry` and `mpa.agentHostEntry` to the built " +
        "dist/index.js files if you are running the extension from an installed .vsix.",
    };
  }
  return { relayEntry, agentHostEntry };
}

function firstExisting(...candidates: (string | undefined)[]): string | undefined {
  return candidates.find((c) => c && c.trim() && existsSync(c.trim()))?.trim();
}

/** Is something already listening on the relay's address? */
export function relayIsUp(url: string, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (up: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened is not interesting.
      }
      resolve(up);
    };

    const socket = new WebSocket(url);
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("open", () => done(true));
    socket.on("error", () => done(false));
  });
}

/**
 * Start the relay if nothing is serving yet, and wait until it answers.
 *
 * Detached, because the relay owns the shared log and must outlive the window
 * that happened to start it. Returns false if it never came up, so the caller
 * can say something useful instead of leaving a panel that silently never
 * connects.
 */
export async function ensureRelay(
  relayEntry: string,
  url: string,
  dbPath: string | undefined,
  log: (line: string) => void,
): Promise<boolean> {
  if (await relayIsUp(url)) return true;

  log("starting relay…");
  const child = spawn(process.execPath, [relayEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(dbPath ? { MPA_DB: dbPath } : {}),
      MPA_RELAY_PORT: String(portOf(url)),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.unref();
  child.stdout?.on("data", (d: Buffer) => log(`relay: ${d.toString().trim()}`));
  child.stderr?.on("data", (d: Buffer) => log(`relay: ${d.toString().trim()}`));

  // Racing the first connect against a process that is still binding its port
  // is the usual cause of "it works the second time".
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(250);
    if (await relayIsUp(url, 500)) return true;
  }
  return false;
}

function portOf(url: string): number {
  const parsed = Number(new URL(url).port);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7331;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
