/**
 * Turning "the file used to say this, now it says that" into edits that can be
 * applied to a document somebody else is still typing in.
 *
 * The agent works on files, not on our CRDT: it reads a path, thinks, and
 * writes the path back. So the only thing we ever learn is a before-text and an
 * after-text. Replacing the whole document with the after-text would be simple
 * and would throw away every keystroke typed while the agent was thinking —
 * which is the exact failure this milestone exists to prevent.
 *
 * So we recover a set of hunks instead, and apply each one where its
 * surrounding text still is rather than where it used to be.
 */

/**
 * One contiguous change, positioned in the *before* text.
 *
 * `anchor` is the text immediately preceding the change. Pure insertions have
 * nothing to match on — deleting zero characters verifies nothing — so the
 * anchor is what lets an insertion still be placed correctly in a document that
 * has shifted underneath it.
 */
export interface Hunk {
  at: number;
  remove: string;
  insert: string;
  anchor: string;
}

/** How much preceding text an insertion carries with it to locate itself. */
const ANCHOR_LENGTH = 64;

/**
 * Above this many cells the line-level LCS stops being worth it and we fall
 * back to replacing the changed region wholesale. A minimal diff of a 5,000
 * line rewrite is not more useful to a human than "this section changed", and
 * the quadratic table would be gigabytes.
 */
const MAX_LCS_CELLS = 4_000_000;

/** Splits on newlines, keeping the newline attached to the line it ends. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) out.push(`${lines[i]!}\n`);
  const last = lines[lines.length - 1]!;
  if (last !== "") out.push(last);
  return out;
}

/** Minimal-ish edit script between two texts, at line granularity. */
export function diffText(before: string, after: string): Hunk[] {
  if (before === after) return [];

  const a = splitLines(before);
  const b = splitLines(after);

  // Common head and tail first. Real edits touch a handful of lines in a file
  // of hundreds, so this is what keeps the LCS table small enough to build.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  // Character offset of each line boundary in `before`.
  const offsets = lineOffsets(a);
  const base = offsets[prefix]!;

  let hunks: Hunk[];
  if (midA.length === 0 && midB.length === 0) {
    return [];
  } else if (midA.length * midB.length > MAX_LCS_CELLS) {
    hunks = [
      { at: base, remove: midA.join(""), insert: midB.join(""), anchor: "" },
    ];
  } else {
    hunks = scriptToHunks(midA, midB, offsets, prefix);
  }

  return hunks
    .map((hunk) => trim(hunk))
    .filter((hunk) => hunk.remove !== "" || hunk.insert !== "")
    .map((hunk) => ({
      ...hunk,
      anchor: before.slice(Math.max(0, hunk.at - ANCHOR_LENGTH), hunk.at),
    }));
}

function lineOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i + 1] = offsets[i]! + lines[i]!.length;
  }
  return offsets;
}

/**
 * Longest common subsequence over lines, walked forward into hunks.
 *
 * Consecutive deletes and inserts are merged into one hunk: a replaced line is
 * one change to a reader, not a deletion next to an unrelated insertion.
 */
function scriptToHunks(
  a: string[],
  b: string[],
  offsets: number[],
  lineBase: number,
): Hunk[] {
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: { line: number; remove: string[]; insert: string[] } | null = null;

  const close = (): void => {
    if (!open) return;
    hunks.push({
      at: offsets[lineBase + open.line]!,
      remove: open.remove.join(""),
      insert: open.insert.join(""),
      anchor: "",
    });
    open = null;
  };

  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { line: i, remove: [], insert: [] };
    if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      open.insert.push(b[j]!);
      j++;
    } else {
      open.remove.push(a[i]!);
      i++;
    }
  }
  close();
  return hunks;
}

/**
 * Shrink a hunk to the characters that actually differ.
 *
 * Line granularity would report a one-character rename as a whole replaced
 * line, which reads badly when the change is highlighted in an editor and makes
 * the hunk collide with unrelated edits on the same line for no reason.
 */
function trim(hunk: Hunk): Hunk {
  let start = 0;
  const max = Math.min(hunk.remove.length, hunk.insert.length);
  while (start < max && hunk.remove[start] === hunk.insert[start]) start++;

  let end = 0;
  while (
    end < max - start &&
    hunk.remove[hunk.remove.length - 1 - end] ===
      hunk.insert[hunk.insert.length - 1 - end]
  ) {
    end++;
  }

  return {
    at: hunk.at + start,
    remove: hunk.remove.slice(start, hunk.remove.length - end),
    insert: hunk.insert.slice(start, hunk.insert.length - end),
    anchor: hunk.anchor,
  };
}

// ---------------------------------------------------------------------------
// Locating a hunk in text that has moved
// ---------------------------------------------------------------------------

/** How far either side of the expected position a displaced hunk is hunted. */
const SEARCH_WINDOW = 4_096;

export interface Placement {
  /** Where this hunk should be applied in the current text, or null if the
   *  text it was written against is no longer recognisable. */
  at: number | null;
  /** True when the hunk was not where it was expected and had to be found. */
  moved: boolean;
}

/**
 * Decide where a hunk belongs in text that may have changed since it was
 * computed.
 *
 * `drift` is how far positions have already shifted — the hunks applied before
 * this one, plus whatever anyone else typed above it.
 */
export function place(current: string, hunk: Hunk, drift: number): Placement {
  const expected = clamp(hunk.at + drift, 0, current.length);

  if (hunk.remove !== "") {
    if (current.startsWith(hunk.remove, expected)) {
      return { at: expected, moved: false };
    }
    const found = search(current, hunk.remove, expected);
    return { at: found, moved: found !== null };
  }

  // A pure insertion: match on what came before it instead.
  if (hunk.anchor === "") return { at: expected, moved: false };
  if (current.startsWith(hunk.anchor, expected - hunk.anchor.length)) {
    return { at: expected, moved: false };
  }
  const found = search(current, hunk.anchor, expected - hunk.anchor.length);
  return {
    at: found === null ? null : found + hunk.anchor.length,
    moved: found !== null,
  };
}

/** Nearest occurrence of `needle` to `near`, within the search window. */
function search(haystack: string, needle: string, near: number): number | null {
  const from = Math.max(0, near - SEARCH_WINDOW);
  const limit = Math.min(haystack.length, near + SEARCH_WINDOW);

  let best: number | null = null;
  let index = haystack.indexOf(needle, from);
  while (index !== -1 && index <= limit) {
    if (best === null || Math.abs(index - near) < Math.abs(best - near)) {
      best = index;
    }
    // Once we start moving away from the target there is nothing better ahead.
    if (index > near) break;
    index = haystack.indexOf(needle, index + 1);
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
