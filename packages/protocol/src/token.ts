import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a locally-run relay and its local clients agree to find the shared
 * token.
 *
 * A fixed path under the user's home rather than next to the database, because
 * the relay's working directory is whatever spawned it — the VS Code extension
 * host, a terminal, a launch agent — and clients have no way to guess that.
 * Keeping the convention here means the relay and every client derive it from
 * one place instead of three that can drift.
 *
 * This is only the *local* convenience path. A client joining a relay on
 * another machine is given the token out of band and passes it explicitly;
 * there is nothing to read.
 */
export function tokenFilePath(): string {
  return (
    process.env.MPA_TOKEN_FILE ??
    join(homedir(), ".multiplayer-agent", "relay-token")
  );
}

/**
 * The token for a relay on this machine: an explicit one if given, otherwise
 * whatever the local relay minted. Undefined means "we have nothing to offer",
 * which the relay answers with a message saying so.
 */
export function readLocalToken(explicit?: string): string | undefined {
  const given = explicit?.trim() || process.env.MPA_TOKEN?.trim();
  if (given) return given;
  try {
    const token = readFileSync(tokenFilePath(), "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
