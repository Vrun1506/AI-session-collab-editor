import * as vscode from "vscode";
import {
  applyUpdate,
  diffText,
  encodeUpdate,
  stateVector,
  textOf,
  Y,
} from "@mpa/crdt";

/**
 * Two-way binding between VS Code's buffers and the room's shared documents.
 *
 * Until now the agent wrote to disk and everyone reloaded, which works right up
 * to the moment two people want to type in the same file, or somebody is
 * mid-sentence when a write lands. This is the part that fixes that: the text
 * lives in a CRDT, so concurrent edits merge instead of one of them winning.
 *
 * Three things make it fiddly, and all three are handled below:
 *
 *  - **Echo.** Applying a remote change produces a change event of its own. Sent
 *    back it would loop forever, so edits we are making ourselves are marked.
 *  - **Reloads.** VS Code silently rereads an unmodified file when it changes on
 *    disk. During an agent write that reload *is* the agent's change arriving by
 *    a second route; pushing it into the document would apply it twice.
 *  - **Adoption.** A file already open by someone else may hold unsaved work
 *    this window has never seen, so the shared copy wins on attach — except
 *    where that would throw away unsaved work of our own.
 */

export interface DocSyncTransport {
  openDoc(path: string, text: string, sv: string): void;
  closeDoc(path: string): void;
  sendUpdate(path: string, update: string): void;
  confirmSaved(path: string): void;
}

interface Bound {
  uri: vscode.Uri;
  doc: Y.Doc;
  text: Y.Text;
  /** False until `docState` arrives; local edits are not pushed before then,
   *  because their offsets would be relative to a document we do not have. */
  synced: boolean;
  /** The agent is writing this file right now. */
  locked: boolean;
  /** Depth counter: greater than zero while we are the ones editing. */
  applying: number;
}

/** How long an agent-written range stays highlighted. */
const HIGHLIGHT_MS = 20_000;

export class DocSync implements vscode.Disposable {
  private readonly bound = new Map<string, Bound>();
  /** In-flight buffer updates, one chain per file. */
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly highlights = new Map<string, vscode.Range[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    overviewRulerColor: new vscode.ThemeColor(
      "editorOverviewRuler.addedForeground",
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    isWholeLine: false,
  });
  private disposed = false;

  constructor(
    private readonly transport: DocSyncTransport,
    private readonly log: (message: string) => void,
  ) {}

  start(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.attach(document);
    }
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.attach(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.detach(d.uri.fsPath)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onLocalChange(e)),
      // A file we refused to bind because it had unsaved changes becomes
      // bindable the moment those changes are written out.
      vscode.workspace.onDidSaveTextDocument((d) => this.attach(d)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.redecorate()),
    );
  }

  /** Everything currently shared, for reattaching after a reconnect. */
  reattachAll(): void {
    const paths = [...this.bound.keys()];
    for (const path of paths) this.detach(path, { notify: false });
    for (const document of vscode.workspace.textDocuments) {
      this.attach(document);
    }
  }

  // ---- attaching ----------------------------------------------------------

  private syncable(document: vscode.TextDocument): boolean {
    return (
      document.uri.scheme === "file" &&
      !document.isUntitled &&
      vscode.workspace.getWorkspaceFolder(document.uri) !== undefined
    );
  }

  private attach(document: vscode.TextDocument): void {
    if (this.disposed) return;
    const path = document.uri.fsPath;
    if (this.bound.has(path) || !this.syncable(document)) return;

    const doc = new Y.Doc();
    const bound: Bound = {
      uri: document.uri,
      doc,
      text: textOf(doc),
      synced: false,
      locked: false,
      applying: 0,
    };
    this.bound.set(path, bound);

    // Only our own edits go out. Anything arriving from the relay is applied
    // with a non-local origin, so this never bounces a change back to sender.
    doc.on("update", (update: Uint8Array, _origin: unknown, _d, tr) => {
      if (!tr.local || !bound.synced) return;
      this.transport.sendUpdate(path, encodeUpdate(update));
    });

    bound.text.observe((_event, transaction) => {
      if (transaction.local) return;
      this.scheduleSync(path, transaction.origin === "agent");
    });

    this.transport.openDoc(path, document.getText(), stateVector(doc));
  }

  private detach(path: string, options?: { notify?: boolean }): void {
    const bound = this.bound.get(path);
    if (!bound) return;
    this.bound.delete(path);
    this.syncing.delete(path);
    bound.doc.destroy();
    this.clearHighlight(path);
    if (options?.notify !== false) this.transport.closeDoc(path);
  }

  // ---- relay -> editor ----------------------------------------------------

  /**
   * The shared copy of a document we just opened.
   *
   * `seeded` means we created it, so it already says what our buffer says and
   * anything typed since the round trip started is safely pushed on top.
   * Otherwise somebody else's copy is authoritative and ours gives way to it.
   */
  onState(path: string, update: string, seeded: boolean): void {
    const bound = this.bound.get(path);
    if (!bound) return;

    applyUpdate(bound.doc, update, "remote");
    const document = this.documentFor(path);
    if (!document) {
      this.detach(path);
      return;
    }

    const shared = bound.text.toString();
    const buffer = document.getText();

    if (seeded) {
      bound.synced = true;
      // Push the gap, not the whole buffer: keystrokes from the last few
      // milliseconds, if any.
      if (shared !== buffer) {
        bound.doc.transact(() => {
          let drift = 0;
          for (const hunk of diffText(shared, buffer)) {
            const at = hunk.at + drift;
            if (hunk.remove.length > 0) bound.text.delete(at, hunk.remove.length);
            if (hunk.insert.length > 0) bound.text.insert(at, hunk.insert);
            drift += hunk.insert.length - hunk.remove.length;
          }
        }, "local");
      }
      return;
    }

    if (shared === buffer) {
      bound.synced = true;
      return;
    }

    // Somebody else's live copy differs from ours, and we have unsaved work of
    // our own. Adopting theirs would destroy it and imposing ours would destroy
    // theirs, so this window stays out until the ambiguity is gone.
    if (document.isDirty) {
      this.detach(path);
      this.log(
        `not sharing ${vscode.workspace.asRelativePath(path)}: it is open ` +
          "elsewhere with different content and you have unsaved changes. " +
          "Save or revert to join the shared copy.",
      );
      void vscode.window.showWarningMessage(
        `${vscode.workspace.asRelativePath(path)} is being edited in the shared session and your copy differs. Save or revert your changes to join it.`,
      );
      return;
    }

    void this.syncBufferToDoc(path, false).then(() => {
      bound.synced = true;
    });
  }

  onUpdate(path: string, update: string, by: "peer" | "agent"): void {
    const bound = this.bound.get(path);
    if (!bound) return;
    applyUpdate(bound.doc, update, by === "agent" ? "agent" : "remote");
  }

  onLock(path: string, locked: boolean): void {
    const bound = this.bound.get(path);
    if (bound) bound.locked = locked;
  }

  /** The relay wants this buffer on disk before the agent reads it. */
  async onSaveRequest(path: string): Promise<void> {
    const document = this.documentFor(path);
    try {
      if (document && document.isDirty) await document.save();
    } catch (err) {
      this.log(`could not save ${path}: ${describe(err)}`);
    } finally {
      this.transport.confirmSaved(path);
    }
  }

  // ---- applying to the buffer ---------------------------------------------

  /**
   * Bring the buffer into line with the shared document.
   *
   * The obvious implementation is to replay the Yjs delta as a workspace edit,
   * and it is wrong in one case that happens constantly: VS Code rereads an
   * unmodified file when it changes on disk, so after an agent write the buffer
   * may *already* contain the change by the time the merge arrives. Replaying
   * the delta on top of it inserts the agent's code twice.
   *
   * Diffing what the buffer says against what the document says has no such
   * failure. It costs a scan of the file per remote change and is idempotent by
   * construction: a buffer that is already correct produces no edits at all.
   */
  private async syncBufferToDoc(path: string, fromAgent: boolean): Promise<void> {
    const bound = this.bound.get(path);
    const document = this.documentFor(path);
    if (!bound || !document) return;

    const target = bound.text.toString();
    const current = document.getText();
    if (current === target) return;

    const edit = new vscode.WorkspaceEdit();
    const written: Array<{ at: number; length: number }> = [];
    let drift = 0;

    for (const hunk of diffText(current, target)) {
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(hunk.at),
          document.positionAt(hunk.at + hunk.remove.length),
        ),
        hunk.insert,
      );
      if (hunk.insert.length > 0) {
        // Highlights are drawn against the document as it will be.
        written.push({ at: hunk.at + drift, length: hunk.insert.length });
      }
      drift += hunk.insert.length - hunk.remove.length;
    }

    bound.applying++;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      bound.applying--;
    }

    if (fromAgent && written.length > 0) this.highlight(path, written);
  }

  /**
   * One buffer update at a time, per file.
   *
   * `applyEdit` is asynchronous, so two overlapping runs would resolve their
   * ranges against different versions of the document. Queueing also coalesces
   * a burst of remote changes for free, since each run reads the shared text as
   * it is when it starts rather than as it was when it was queued.
   */
  private scheduleSync(path: string, fromAgent: boolean): void {
    const previous = this.syncing.get(path) ?? Promise.resolve();
    const next = previous
      .then(() => this.syncBufferToDoc(path, fromAgent))
      .catch((err: unknown) => {
        this.log(`could not update ${path}: ${describe(err)}`);
      });
    this.syncing.set(path, next);
  }

  // ---- editor -> relay ----------------------------------------------------

  private onLocalChange(event: vscode.TextDocumentChangeEvent): void {
    const path = event.document.uri.fsPath;
    const bound = this.bound.get(path);
    if (!bound || !bound.synced || event.contentChanges.length === 0) return;

    // Our own application of a remote change, coming back around.
    if (bound.applying > 0) return;

    // While the agent is writing this file, a change that leaves the buffer
    // clean is VS Code rereading it from disk — the same edit we are about to
    // receive as a merge. Applying both would insert the agent's text twice.
    if (bound.locked && !event.document.isDirty) return;

    // Later changes in one event are positioned against the document as it was
    // before any of them, so they are applied last first.
    const changes = [...event.contentChanges].sort(
      (a, b) => b.rangeOffset - a.rangeOffset,
    );

    bound.doc.transact(() => {
      for (const change of changes) {
        if (change.rangeLength > 0) {
          bound.text.delete(change.rangeOffset, change.rangeLength);
        }
        if (change.text.length > 0) {
          bound.text.insert(change.rangeOffset, change.text);
        }
      }
    }, "local");
  }

  // ---- attribution --------------------------------------------------------

  /**
   * Mark what the agent wrote.
   *
   * Not decoration for its own sake: a merge means the change is scattered
   * through text you were already editing, so "the file changed" is not enough
   * to know what to look at.
   */
  private highlight(
    path: string,
    written: Array<{ at: number; length: number }>,
  ): void {
    const document = this.documentFor(path);
    if (!document) return;

    const ranges = written.map(
      (range) =>
        new vscode.Range(
          document.positionAt(range.at),
          document.positionAt(range.at + range.length),
        ),
    );
    this.highlights.set(path, [...(this.highlights.get(path) ?? []), ...ranges]);
    this.redecorate();

    clearTimeout(this.timers.get(path));
    const timer = setTimeout(() => this.clearHighlight(path), HIGHLIGHT_MS);
    timer.unref?.();
    this.timers.set(path, timer);
  }

  private clearHighlight(path: string): void {
    clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.highlights.delete(path);
    this.redecorate();
  }

  private redecorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = this.highlights.get(editor.document.uri.fsPath) ?? [];
      editor.setDecorations(this.decoration, ranges);
    }
  }

  // ---- plumbing -----------------------------------------------------------

  private documentFor(path: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
  }

  dispose(): void {
    this.disposed = true;
    for (const path of [...this.bound.keys()]) {
      this.detach(path, { notify: false });
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const s of this.subscriptions) s.dispose();
    this.decoration.dispose();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
