import { resolve } from "node:path";
import {
  AGENT_ORIGIN,
  applyUpdate,
  encodeUpdate,
  mergeText,
  stateSince,
  textOf,
  Y,
  type MergeReport,
} from "@mpa/crdt";

/**
 * The live documents of a room.
 *
 * Up to now the agent wrote to disk and every editor reloaded, which is fine
 * until two people want to type in the same file, or until someone is
 * mid-sentence when a write lands. A CRDT fixes both, but only if something
 * owns the authoritative copy — that is this.
 *
 * A document is live only while at least one editor holds it open. That is a
 * deliberate limit: the moment nothing is holding a file, disk is the truth
 * again, and there is no stale shared copy waiting to overwrite it tomorrow.
 * Durability belongs to the filesystem; this layer only owns the part disk
 * cannot express, which is what the file says *right now*.
 */

export interface LiveDoc {
  doc: Y.Doc;
  /** Editors with this file open. Empty means the document is gone. */
  holders: Set<string>;
  /** True while the agent is writing this path — see `docLock` in the wire
   *  protocol for why editors must be told. */
  locked: boolean;
}

export interface MergeOutcome {
  report: MergeReport;
  /** The update to fan out, or null when the merge changed nothing. */
  update: string | null;
}

export class DocHub {
  private readonly rooms = new Map<string, Map<string, LiveDoc>>();

  private docsIn(roomId: string): Map<string, LiveDoc> {
    let docs = this.rooms.get(roomId);
    if (!docs) {
      docs = new Map();
      this.rooms.set(roomId, docs);
    }
    return docs;
  }

  /** Paths are compared as absolute: two editors on one machine must agree
   *  they mean the same file, and the agent reports resolved paths already. */
  static key(path: string): string {
    return resolve(path);
  }

  get(roomId: string, path: string): LiveDoc | undefined {
    return this.rooms.get(roomId)?.get(DocHub.key(path));
  }

  isLive(roomId: string, path: string): boolean {
    return this.get(roomId, path) !== undefined;
  }

  livePaths(roomId: string): string[] {
    return [...(this.rooms.get(roomId)?.keys() ?? [])];
  }

  holders(roomId: string, path: string): string[] {
    return [...(this.get(roomId, path)?.holders ?? [])];
  }

  /**
   * Attach an editor to a document, creating it from that editor's text if
   * nobody had it open.
   *
   * When it already exists the relay's copy wins and the caller adopts it. That
   * is the only safe direction: another participant may be holding unsaved
   * edits, and a joiner whose disk copy is older must not be allowed to erase
   * them just by opening the file.
   */
  open(
    roomId: string,
    path: string,
    userId: string,
    text: string,
    sinceStateVector: string,
  ): { update: string; seeded: boolean } {
    const key = DocHub.key(path);
    const docs = this.docsIn(roomId);

    let live = docs.get(key);
    const seeded = live === undefined;
    if (!live) {
      const doc = new Y.Doc();
      if (text.length > 0) textOf(doc).insert(0, text);
      live = { doc, holders: new Set(), locked: false };
      docs.set(key, live);
    }
    live.holders.add(userId);

    return { update: stateSince(live.doc, sinceStateVector), seeded };
  }

  /** Detach one editor. Returns true when that was the last one holding it. */
  close(roomId: string, path: string, userId: string): boolean {
    const key = DocHub.key(path);
    const docs = this.rooms.get(roomId);
    const live = docs?.get(key);
    if (!live) return false;

    live.holders.delete(userId);
    if (live.holders.size > 0) return false;

    live.doc.destroy();
    docs!.delete(key);
    if (docs!.size === 0) this.rooms.delete(roomId);
    return true;
  }

  /** Everything this participant was holding, dropped at once. Called when a
   *  peer disconnects; a document nobody is attached to must not survive them. */
  closeAll(roomId: string, userId: string): string[] {
    const docs = this.rooms.get(roomId);
    if (!docs) return [];
    const dropped: string[] = [];
    for (const path of [...docs.keys()]) {
      if (this.close(roomId, path, userId)) dropped.push(path);
    }
    return dropped;
  }

  /** Apply an editor's update. The caller fans the same bytes out to the other
   *  holders; re-encoding it here would only risk diverging from what was sent. */
  apply(roomId: string, path: string, update: string): boolean {
    const live = this.get(roomId, path);
    if (!live) return false;
    applyUpdate(live.doc, update, "peer");
    return true;
  }

  text(roomId: string, path: string): string | null {
    const live = this.get(roomId, path);
    return live ? textOf(live.doc).toString() : null;
  }

  setLock(roomId: string, path: string, locked: boolean): boolean {
    const live = this.get(roomId, path);
    if (!live) return false;
    live.locked = locked;
    return true;
  }

  /**
   * Fold an agent's file write into the live document.
   *
   * The agent gives us the file as it was and as it now is. Replacing the
   * document with the second would be simpler and would silently discard every
   * keystroke typed while the tool was running, so instead each hunk is placed
   * against the text that is actually there — see `@mpa/crdt`.
   */
  merge(
    roomId: string,
    path: string,
    before: string,
    after: string,
  ): MergeOutcome | null {
    const live = this.get(roomId, path);
    if (!live) return null;

    let captured: Uint8Array | null = null;
    const capture = (update: Uint8Array, origin: unknown): void => {
      if (origin === AGENT_ORIGIN) captured = update;
    };

    live.doc.on("update", capture);
    let report: MergeReport;
    try {
      report = mergeText(textOf(live.doc), before, after);
    } finally {
      live.doc.off("update", capture);
    }

    return {
      report,
      update: captured === null ? null : encodeUpdate(captured),
    };
  }
}
