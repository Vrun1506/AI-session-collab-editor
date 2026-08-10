import * as Y from "yjs";
import { diffText, place, type Hunk } from "./diff.js";

/**
 * Applying changes to a shared document.
 *
 * Origins are how every peer answers "did I cause this?" — the editor binding
 * must not echo a remote change straight back, and the panel wants to know
 * whether a line was written by a person or by the agent.
 */
export const LOCAL_ORIGIN = "local";
export const REMOTE_ORIGIN = "remote";
export const AGENT_ORIGIN = "agent";

/** Where the shared text of a document lives inside its Y.Doc. */
export const TEXT_KEY = "content";

export function textOf(doc: Y.Doc): Y.Text {
  return doc.getText(TEXT_KEY);
}

export interface Range {
  at: number;
  length: number;
}

export interface MergeReport {
  /** Hunks that landed. */
  applied: number;
  /** Hunks whose surrounding text had been edited away, so they were skipped
   *  rather than applied somewhere they no longer belong. */
  conflicts: number;
  /** Hunks that landed somewhere other than where they were computed, because
   *  somebody had inserted or removed text above them in the meantime. */
  moved: number;
  /** What the writer added, in final-text coordinates, for highlighting. */
  inserted: Range[];
}

const EMPTY: MergeReport = { applied: 0, conflicts: 0, moved: 0, inserted: [] };

/**
 * Merge a before/after pair into a document that may have moved on.
 *
 * This is the heart of the milestone. The agent computed its change against
 * `before`; by the time we hear about it, people may have typed. Each hunk is
 * placed by matching its surrounding text rather than trusting its offset, so
 * an agent edit at line 200 still lands correctly when someone added a line at
 * the top — and an agent edit to a line somebody has just rewritten is reported
 * as a conflict instead of silently overwriting them.
 */
export function mergeText(
  ytext: Y.Text,
  before: string,
  after: string,
  origin: unknown = AGENT_ORIGIN,
): MergeReport {
  return applyHunks(ytext, diffText(before, after), origin);
}

export function applyHunks(
  ytext: Y.Text,
  hunks: Hunk[],
  origin: unknown = AGENT_ORIGIN,
): MergeReport {
  if (hunks.length === 0) return { ...EMPTY, inserted: [] };

  const report: MergeReport = { applied: 0, conflicts: 0, moved: 0, inserted: [] };

  const run = (): void => {
    let drift = 0;
    for (const hunk of hunks) {
      const current = ytext.toString();
      const spot = place(current, hunk, drift);
      if (spot.at === null) {
        report.conflicts++;
        continue;
      }
      if (spot.moved) report.moved++;

      if (hunk.remove.length > 0) ytext.delete(spot.at, hunk.remove.length);
      if (hunk.insert.length > 0) ytext.insert(spot.at, hunk.insert);

      if (hunk.insert.length > 0) {
        report.inserted.push({ at: spot.at, length: hunk.insert.length });
      }
      report.applied++;
      // Positions after this hunk have shifted by however far it moved plus
      // however much longer it made the text.
      drift = spot.at - hunk.at + hunk.insert.length - hunk.remove.length;
    }
  };

  // One transaction, so every peer sees the whole merge arrive at once rather
  // than watching it assemble itself hunk by hunk.
  if (ytext.doc) ytext.doc.transact(run, origin);
  else run();

  return report;
}

/**
 * Force the document to say exactly this.
 *
 * Used where there is no question of concurrency — seeding a new document, or
 * catching a freshly attached editor up — so it takes the shortest edit rather
 * than trying to place anything.
 */
export function setText(
  ytext: Y.Text,
  target: string,
  origin: unknown = LOCAL_ORIGIN,
): MergeReport {
  const current = ytext.toString();
  if (current === target) return { ...EMPTY, inserted: [] };

  const hunks = diffText(current, target);
  const report: MergeReport = { applied: 0, conflicts: 0, moved: 0, inserted: [] };

  const run = (): void => {
    let drift = 0;
    for (const hunk of hunks) {
      const at = hunk.at + drift;
      if (hunk.remove.length > 0) ytext.delete(at, hunk.remove.length);
      if (hunk.insert.length > 0) ytext.insert(at, hunk.insert);
      report.applied++;
      if (hunk.insert.length > 0) {
        report.inserted.push({ at, length: hunk.insert.length });
      }
      drift += hunk.insert.length - hunk.remove.length;
    }
  };

  if (ytext.doc) ytext.doc.transact(run, origin);
  else run();

  return report;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Yjs speaks binary and our wire protocol is JSON, so updates travel base64.
 *
 * A second socket carrying binary frames would be faster, but one ordered
 * channel means a document update can never overtake the event that explains
 * it — worth more than the third of a byte per byte that base64 costs.
 */
export function encodeUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString("base64");
}

export function decodeUpdate(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

/** What this peer already has, so a sync reply carries only the difference. */
export function stateVector(doc: Y.Doc): string {
  return encodeUpdate(Y.encodeStateVector(doc));
}

/** Everything the holder of `sinceStateVector` is missing. */
export function stateSince(doc: Y.Doc, sinceStateVector?: string): string {
  return encodeUpdate(
    Y.encodeStateAsUpdate(
      doc,
      sinceStateVector ? decodeUpdate(sinceStateVector) : undefined,
    ),
  );
}

export function applyUpdate(doc: Y.Doc, encoded: string, origin: unknown): void {
  Y.applyUpdate(doc, decodeUpdate(encoded), origin);
}
