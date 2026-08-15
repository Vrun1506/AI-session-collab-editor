import * as vscode from "vscode";
import { applyUpdate, encodeUpdate, stateVector, textOf, Y } from "@mpa/crdt";
import {
  decideAdoption,
  inReverseOrder,
  isSyncable,
  judgeLocalChange,
  planEdits,
} from "./buffer-rules.js";

/**
 * Two-way binding between VS Code's buffers and the room's shared documents.
 *
 * Until now the agent wrote to disk and everyone reloaded, which works right up
 * to the moment two people want to type in the same file, or somebody is
 * mid-sentence when a write lands. This is the part that fixes that: the text
 * lives in a CRDT, so concurrent edits merge instead of one of them winning.
 *
 * **This file is an adapter.** The rules it applies — what may be shared, whose
 * copy wins on attach, which buffer changes are ours to send, and how to turn
 * one text into another — live in `buffer-rules.ts`, with no editor attached
 * and a test each. What is left here is the part that genuinely needs VS Code:
 * watching documents, applying workspace edits, and drawing decorations.
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

  private attach(document: vscode.TextDocument): void {
    if (this.disposed) return;
    const path = document.uri.fsPath;
    if (this.bound.has(path)) return;
    if (
      !isSyncable({
        scheme: document.uri.scheme,
        isUntitled: document.isUntitled,
        inWorkspace:
          vscode.workspace.getWorkspaceFolder(document.uri) !== undefined,
      })
    ) {
      return;
    }

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
   * Otherwise somebody else's copy is authoritative — see `decideAdoption`.
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
    const decision = decideAdoption({
      seeded,
      shared,
      buffer,
      isDirty: document.isDirty,
    });

    switch (decision.kind) {
      case "push-drift": {
        bound.synced = true;
        // Push the gap, not the whole buffer: keystrokes from the last few
        // milliseconds, if any.
        if (shared !== buffer) {
          bound.doc.transact(() => {
            for (const edit of planEdits(shared, buffer).edits) {
              if (edit.removeLength > 0) {
                bound.text.delete(edit.finalAt, edit.removeLength);
              }
              if (edit.insert.length > 0) {
                bound.text.insert(edit.finalAt, edit.insert);
              }
            }
          }, "local");
        }
        return;
      }

      case "already-in-sync": {
        bound.synced = true;
        return;
      }

      case "refuse": {
        this.detach(path);
        const name = vscode.workspace.asRelativePath(path);
        this.log(`not sharing ${name}: ${decision.reason}`);
        void vscode.window.showWarningMessage(
          `${name} is being edited in the shared session and your copy differs. Save or revert your changes to join it.`,
        );
        return;
      }

      case "adopt-shared": {
        void this.syncBufferToDoc(path, false).then(() => {
          bound.synced = true;
        });
        return;
      }
    }
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

  /** Bring the buffer into line with the shared document. */
  private async syncBufferToDoc(path: string, fromAgent: boolean): Promise<void> {
    const bound = this.bound.get(path);
    const document = this.documentFor(path);
    if (!bound || !document) return;

    const { edits, written } = planEdits(document.getText(), bound.text.toString());
    if (edits.length === 0) return;

    // Every range is resolved against the document as it is now, because
    // `applyEdit` applies the whole set atomically against that version.
    const edit = new vscode.WorkspaceEdit();
    for (const planned of edits) {
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(planned.at),
          document.positionAt(planned.at + planned.removeLength),
        ),
        planned.insert,
      );
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
    if (!bound) return;

    const verdict = judgeLocalChange({
      synced: bound.synced,
      changeCount: event.contentChanges.length,
      applying: bound.applying,
      locked: bound.locked,
      isDirty: event.document.isDirty,
    });
    if (!verdict.push) return;

    bound.doc.transact(() => {
      for (const change of inReverseOrder(event.contentChanges)) {
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
