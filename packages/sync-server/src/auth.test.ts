import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenAuth, SharedTokenAuth, provisionToken } from "./auth.js";

const peer = { userId: "u1", name: "Alice", roomId: "r" };

test("a matching token is admitted", () => {
  const auth = new SharedTokenAuth("s3cret");
  assert.deepEqual(auth.authenticate({ ...peer, token: "s3cret" }), {
    ok: true,
    userId: "u1",
    name: "Alice",
  });
});

test("a wrong token is refused", () => {
  const auth = new SharedTokenAuth("s3cret");
  const result = auth.authenticate({ ...peer, token: "wrong" });
  assert.equal(result.ok, false);
});

test("a missing token is refused, and says why", () => {
  const auth = new SharedTokenAuth("s3cret");
  const result = auth.authenticate({ ...peer });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /requires a token/);
});

test("a token that is merely a prefix of the real one is refused", () => {
  // Guards the length check in front of timingSafeEqual, which throws on
  // mismatched lengths rather than returning false.
  const auth = new SharedTokenAuth("s3cret");
  assert.equal(auth.authenticate({ ...peer, token: "s3cre" }).ok, false);
  assert.equal(auth.authenticate({ ...peer, token: "s3cretX" }).ok, false);
  assert.equal(auth.authenticate({ ...peer, token: "" }).ok, false);
});

test("the open gate admits anyone, and admits to it", () => {
  const auth = new OpenAuth();
  assert.equal(auth.authenticate({ ...peer }).ok, true);
  assert.match(auth.describe(), /DISABLED/);
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

function withTempToken(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mpa-auth-"));
  const saved = process.env.MPA_TOKEN;
  delete process.env.MPA_TOKEN;
  try {
    fn(join(dir, "nested", "relay-token"));
  } finally {
    if (saved === undefined) delete process.env.MPA_TOKEN;
    else process.env.MPA_TOKEN = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a first run mints a token and stores it readable only by its owner", () => {
  withTempToken((path) => {
    const saved = process.env.MPA_TOKEN_FILE;
    process.env.MPA_TOKEN_FILE = path;
    try {
      const first = provisionToken(path);
      assert.equal(first.created, true);
      assert.ok(first.token.length >= 32, "must not be guessable");

      // 0600: this user's own editor windows can read it, nobody else's can.
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(readFileSync(path, "utf8").trim(), first.token);

      // A restart must reuse it, or every restart locks out live clients.
      const second = provisionToken(path);
      assert.equal(second.created, false);
      assert.equal(second.token, first.token);
    } finally {
      if (saved === undefined) delete process.env.MPA_TOKEN_FILE;
      else process.env.MPA_TOKEN_FILE = saved;
    }
  });
});

test("an explicit MPA_TOKEN wins and nothing is written", () => {
  withTempToken((path) => {
    process.env.MPA_TOKEN = "from-the-environment";
    const result = provisionToken(path);
    assert.equal(result.token, "from-the-environment");
    assert.equal(result.created, false);
    assert.throws(() => statSync(path), "must not have created a file");
  });
});
