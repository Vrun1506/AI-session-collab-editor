import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readLocalToken, tokenFilePath } from "@mpa/protocol/token";

/**
 * Who is allowed into a room.
 *
 * A shared token is the right answer for a local MVP and the wrong one for a
 * hosted service: it proves you were told a secret, not that you are who you
 * say you are. So the check sits behind this interface, the same way storage
 * sits behind `EventStore` — swapping in real accounts later should be a new
 * implementation, not a rewrite of the relay.
 *
 * The seam is deliberately drawn at *identity*, not just admission. An
 * `Authenticator` returns the identity it verified rather than a boolean, so a
 * future implementation can overrule the name and id a client asked for. Under
 * shared-token auth it cannot — everyone holding the token can claim any name —
 * and that limitation is the honest reason this is not the end state.
 */

export interface Credentials {
  token?: string;
  userId: string;
  name: string;
  roomId: string;
}

export type AuthResult =
  | { ok: true; userId: string; name: string }
  | { ok: false; reason: string };

export interface Authenticator {
  authenticate(credentials: Credentials): AuthResult;
  /** Shown once at startup so an operator knows which gate is in force. */
  describe(): string;
}

/** No gate at all. Explicit, so it can never be reached by accident. */
export class OpenAuth implements Authenticator {
  authenticate(c: Credentials): AuthResult {
    return { ok: true, userId: c.userId, name: c.name };
  }
  describe(): string {
    return "DISABLED — any client that can reach this port may join any room";
  }
}

export class SharedTokenAuth implements Authenticator {
  private readonly expected: Buffer;

  constructor(token: string) {
    this.expected = Buffer.from(token, "utf8");
  }

  authenticate(c: Credentials): AuthResult {
    if (!c.token) {
      return { ok: false, reason: "this relay requires a token" };
    }
    const given = Buffer.from(c.token, "utf8");
    // Length must be checked separately: timingSafeEqual throws on a mismatch,
    // and comparing lengths first is not a leak worth caring about here.
    const matches =
      given.length === this.expected.length &&
      timingSafeEqual(given, this.expected);

    if (!matches) return { ok: false, reason: "invalid token" };

    // A shared secret says nothing about *which* holder this is, so the client's
    // claimed identity is taken at face value. Real accounts fix this.
    return { ok: true, userId: c.userId, name: c.name };
  }

  describe(): string {
    return "shared token";
  }
}

/**
 * The token this relay should use, minting one on first run.
 *
 * Generating rather than defaulting to something well-known is the whole point:
 * a shipped default token is not a gate, it is a formality. Written 0600 so
 * this user's own editor windows can read it and nobody else's can — which is
 * what makes local use zero-config without making it open.
 */
export function provisionToken(path = tokenFilePath()): {
  token: string;
  created: boolean;
} {
  const existing = readLocalToken();
  if (existing) return { token: existing, created: false };

  const token = randomBytes(32).toString("base64url");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { token, created: true };
}

/** Build the gate this process should enforce, from its environment. */
export function authenticatorFromEnv(): Authenticator {
  if (process.env.MPA_NO_AUTH === "1") return new OpenAuth();
  const { token, created } = provisionToken();
  if (created) {
    console.log(`[relay] minted a new relay token at ${tokenFilePath()}`);
  }
  return new SharedTokenAuth(token);
}

export { tokenFilePath };
