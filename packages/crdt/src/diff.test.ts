import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffText, place, splitLines } from "./diff.js";

test("identical text produces no hunks", () => {
  assert.deepEqual(diffText("a\nb\n", "a\nb\n"), []);
});

test("splitLines keeps newlines and a bare final line", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a\n", "b\n"]);
  assert.deepEqual(splitLines("a\nb"), ["a\n", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("a hunk reproduces the after text when applied", () => {
  const before = "one\ntwo\nthree\n";
  const after = "one\nTWO\nthree\n";
  const hunks = diffText(before, after);
  assert.equal(hunks.length, 1);

  const h = hunks[0]!;
  assert.equal(
    before.slice(0, h.at) + h.insert + before.slice(h.at + h.remove.length),
    after,
  );
});

test("a one-character change does not report the whole line", () => {
  // Line granularity would call this a replaced line, which highlights badly
  // and collides with unrelated edits elsewhere on the same line.
  const hunks = diffText("const a = 1;\n", "const a = 2;\n");
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.remove, "1");
  assert.equal(hunks[0]!.insert, "2");
});

test("separate edits stay separate hunks", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\n";
  const after = "a\nB\nc\nd\ne\nF\ng\n";
  const hunks = diffText(before, after);
  assert.equal(hunks.length, 2);
  assert.ok(hunks[0]!.at < hunks[1]!.at);
});

test("a pure insertion carries the text before it as an anchor", () => {
  const before = "line one\nline two\n";
  const after = "line one\ninserted\nline two\n";
  const hunks = diffText(before, after);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.remove, "");
  assert.equal(hunks[0]!.insert, "inserted\n");
  assert.ok(hunks[0]!.anchor.endsWith("line one\n"));
});

test("deletion to empty is a single hunk", () => {
  const hunks = diffText("gone\n", "");
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.remove, "gone\n");
  assert.equal(hunks[0]!.insert, "");
});

test("applying every hunk in order rebuilds the after text", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
  const after = before
    .replace("line 5\n", "line five\n")
    .replace("line 20\n", "")
    .replace("line 30\n", "line 30\nextra\n");

  let text = before;
  let drift = 0;
  for (const hunk of diffText(before, after)) {
    const at = hunk.at + drift;
    text = text.slice(0, at) + hunk.insert + text.slice(at + hunk.remove.length);
    drift += hunk.insert.length - hunk.remove.length;
  }
  assert.equal(text, after);
});

// ---- placing hunks in text that has moved ---------------------------------

test("a hunk is found where it is expected when nothing moved", () => {
  const before = "alpha\nbravo\ncharlie\n";
  const hunk = diffText(before, "alpha\nBRAVO\ncharlie\n")[0]!;
  const spot = place(before, hunk, 0);
  assert.equal(spot.moved, false);
  assert.equal(spot.at, hunk.at);
});

test("a hunk relocates when text was inserted above it", () => {
  const before = "alpha\nbravo\ncharlie\n";
  const hunk = diffText(before, "alpha\nbravo\nCHARLIE\n")[0]!;
  // Somebody typed a new first line while the agent was thinking.
  const current = `typed by a human\n${before}`;

  const spot = place(current, hunk, 0);
  assert.equal(spot.moved, true);
  assert.ok(spot.at !== null);
  assert.ok(current.startsWith(hunk.remove, spot.at!));
});

test("a hunk whose text was rewritten is reported unplaceable", () => {
  const before = "alpha\nbravo\ncharlie\n";
  const hunk = diffText(before, "alpha\nBRAVO\ncharlie\n")[0]!;
  // The line the agent meant to change no longer exists in any form.
  const current = "alpha\ncompletely different\ncharlie\n";

  assert.equal(place(current, hunk, 0).at, null);
});

test("an insertion relocates by its anchor", () => {
  const before = "alpha\nbravo\ncharlie\n";
  const hunk = diffText(before, "alpha\nbravo\ninserted\ncharlie\n")[0]!;
  const current = `header\n${before}`;

  const spot = place(current, hunk, 0);
  assert.equal(spot.moved, true);
  assert.equal(spot.at, "header\nalpha\nbravo\n".length);
});

test("a large rewrite falls back to one replacement rather than a huge table", () => {
  const before = Array.from({ length: 3_000 }, (_, i) => `a${i}\n`).join("");
  const after = Array.from({ length: 3_000 }, (_, i) => `b${i}\n`).join("");
  const hunks = diffText(before, after);
  assert.equal(hunks.length, 1);

  const h = hunks[0]!;
  assert.equal(
    before.slice(0, h.at) + h.insert + before.slice(h.at + h.remove.length),
    after,
  );
});
