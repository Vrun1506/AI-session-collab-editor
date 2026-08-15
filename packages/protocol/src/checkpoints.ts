/**
 * What a rewind leaves behind.
 *
 * A `checkpoint.restored` event does not delete anything — it declares the
 * stretch of log from the rewound turn's prompt up to itself **superseded**.
 * Every reader of the log has to apply that same rule, and there are three of
 * them: the relay when replaying to a late joiner, the extension when keeping
 * its rewind menu honest, and the webview when taking the turn back off the
 * screen.
 *
 * The rule is small enough that it was copied into each, which is exactly the
 * kind of duplication that drifts silently — an off-by-one at one end would
 * show up as one client offering a checkpoint the others had discarded. It
 * lives here so the two TypeScript readers share it. (The webview folds the log
 * in plain JavaScript and cannot import this; its copy is marked as such.)
 */

/** Half-open `[fromSeq, toSeq)`: the events a rewind abandoned. */
export interface SupersededRange {
  /** The seq of the prompt that opened the rewound turn. */
  fromSeq: number;
  /** The seq of the `checkpoint.restored` event itself, exclusive. */
  toSeq: number;
}

/**
 * Whether an event sits inside a superseded range.
 *
 * Half-open at the top on purpose: the `checkpoint.restored` event is the
 * record that the rewind happened and must survive it. Rewinding twice can
 * legitimately supersede an earlier rewind's own event, which is why callers
 * check against every range rather than only the newest.
 */
export function isSuperseded(
  ranges: readonly SupersededRange[],
  seq: number,
): boolean {
  return ranges.some((r) => seq >= r.fromSeq && seq < r.toSeq);
}

/** Whether one range covers a seq — the single-range form of the same rule. */
export function withinRange(range: SupersededRange, seq: number): boolean {
  return seq >= range.fromSeq && seq < range.toSeq;
}
