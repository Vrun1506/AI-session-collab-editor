import { diffText } from "@mpa/crdt";

/**
 * The decisions behind two-way buffer binding, with no editor attached.
 *
 * `docsync.ts` used to hold both these rules and the VS Code calls that carry
 * them out, which made the hardest logic in the repo the least testable: the
 * only way to ask "what happens when a file is open elsewhere with different
 * content and we have unsaved changes?" was to open two windows and try it.
 *
 * Everything here is a pure function of what the editor reported. That is also
 * why it survives the move to a VS Code fork: the questions are the same, only
 * the API answering them changes.
 */

// ---------------------------------------------------------------------------
// What may be shared
// ---------------------------------------------------------------------------

export interface DocumentFacts {
  /** URI scheme. Only real files on disk are shared. */
  scheme: string;
  isUntitled: boolean;
  /** Whether the file sits inside a workspace folder. */
  inWorkspace: boolean;
}

/**
 * Untitled buffers have no path to agree on, non-`file` schemes are things like
 * diff views and git blobs, and a file outside every workspace folder is not
 * part of the project the room is working on.
 */
export function isSyncable(doc: DocumentFacts): boolean {
  return doc.scheme === "file" && !doc.isUntitled && doc.inWorkspace;
}

// ---------------------------------------------------------------------------
// Adopting the shared copy
// ---------------------------------------------------------------------------

export type Adoption =
  /** We created the shared copy; push anything typed since the round trip. */
  | { kind: "push-drift" }
  /** The two already agree. */
  | { kind: "already-in-sync" }
  /** Someone else's copy is authoritative and ours is clean, so take theirs. */
  | { kind: "adopt-shared" }
  /** Neither copy may win without destroying work. Stay out. */
  | { kind: "refuse"; reason: string };

export interface AdoptionInput {
  /** True when this peer's text is what created the shared document. */
  seeded: boolean;
  shared: string;
  buffer: string;
  /** Whether this window holds unsaved changes to the file. */
  isDirty: boolean;
}

/**
 * Decide what to do when the shared copy of a document arrives.
 *
 * The case that matters is the last one. A file already open by someone else
 * may hold unsaved work this window has never seen; adopting theirs would
 * destroy ours and imposing ours would destroy theirs. There is no correct
 * merge — the two texts have no common history to merge *from* — so the honest
 * move is to stay out and say why, rather than pick a loser silently.
 */
export function decideAdoption(input: AdoptionInput): Adoption {
  if (input.seeded) return { kind: "push-drift" };
  if (input.shared === input.buffer) return { kind: "already-in-sync" };
  if (input.isDirty) {
    return {
      kind: "refuse",
      reason:
        "it is open elsewhere with different content and you have unsaved " +
        "changes. Save or revert to join the shared copy.",
    };
  }
  return { kind: "adopt-shared" };
}

// ---------------------------------------------------------------------------
// Pushing local edits
// ---------------------------------------------------------------------------

export type LocalChangeVerdict =
  | { push: true }
  | {
      push: false;
      /** Why it was dropped — each of these is a real bug if got wrong. */
      because: "not-synced" | "no-changes" | "our-own-edit" | "disk-reload";
    };

export interface LocalChangeInput {
  /** False until `docState` arrives; offsets before that mean nothing. */
  synced: boolean;
  changeCount: number;
  /** Depth counter: greater than zero while we are the ones editing. */
  applying: number;
  /** The agent is writing this file right now. */
  locked: boolean;
  isDirty: boolean;
}

/**
 * Whether a change the editor just reported is ours to send.
 *
 * Three of the four rejections exist because the same edit can reach a buffer
 * by more than one route, and sending it twice corrupts the document:
 *
 * - **`our-own-edit`** — applying a remote change produces a change event of
 *   its own. Sent back it would loop forever.
 * - **`disk-reload`** — while the agent is writing a file, a change that leaves
 *   the buffer *clean* is VS Code silently rereading it from disk. That reload
 *   is the agent's own change arriving by a second route, and we are about to
 *   receive it properly as a merge. Pushing it would apply it twice. A change
 *   that leaves the buffer dirty is a person typing, and must go.
 * - **`not-synced`** — before the shared document arrives, local offsets are
 *   relative to a text the room does not have.
 */
export function judgeLocalChange(input: LocalChangeInput): LocalChangeVerdict {
  if (!input.synced) return { push: false, because: "not-synced" };
  if (input.changeCount === 0) return { push: false, because: "no-changes" };
  if (input.applying > 0) return { push: false, because: "our-own-edit" };
  if (input.locked && !input.isDirty) {
    return { push: false, because: "disk-reload" };
  }
  return { push: true };
}

/**
 * Content changes, ordered so they can be applied one at a time.
 *
 * Every change in one editor event is positioned against the document as it was
 * *before any of them*, so applying them front-to-back would shift every
 * offset after the first. Last-first leaves earlier offsets untouched.
 */
export function inReverseOrder<T extends { rangeOffset: number }>(
  changes: readonly T[],
): T[] {
  return [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
}

// ---------------------------------------------------------------------------
// Turning one text into another
// ---------------------------------------------------------------------------

export interface PlannedEdit {
  /** Offset in the text as it is *now* — what a whole-document edit wants. */
  at: number;
  removeLength: number;
  insert: string;
  /**
   * Offset in the text as it *will be*, once earlier hunks have been applied.
   *
   * Needed by callers that apply hunks one at a time (a CRDT text) and by
   * anything pointing at the result (a highlight), where `at` would be wrong by
   * the length every preceding hunk added or removed.
   */
  finalAt: number;
}

export interface EditPlan {
  edits: PlannedEdit[];
  /** Where new text ended up, for attribution. Empty for pure deletions. */
  written: Array<{ at: number; length: number }>;
}

/**
 * Plan the edits that turn `current` into `target`.
 *
 * Deliberately a diff rather than a replay of the CRDT's own delta. The obvious
 * implementation — apply the Yjs delta to the buffer — is wrong in a case that
 * happens constantly: VS Code rereads an unmodified file when it changes on
 * disk, so after an agent write the buffer may *already* contain the change by
 * the time the merge arrives, and replaying the delta inserts it twice.
 *
 * Diffing has no such failure and is idempotent by construction: a buffer that
 * already matches produces no edits at all. It costs one scan of the file per
 * remote change, which is the right trade.
 */
export function planEdits(current: string, target: string): EditPlan {
  const edits: PlannedEdit[] = [];
  const written: Array<{ at: number; length: number }> = [];
  let drift = 0;

  for (const hunk of diffText(current, target)) {
    const finalAt = hunk.at + drift;
    edits.push({
      at: hunk.at,
      removeLength: hunk.remove.length,
      insert: hunk.insert,
      finalAt,
    });
    if (hunk.insert.length > 0) {
      written.push({ at: finalAt, length: hunk.insert.length });
    }
    drift += hunk.insert.length - hunk.remove.length;
  }

  return { edits, written };
}
