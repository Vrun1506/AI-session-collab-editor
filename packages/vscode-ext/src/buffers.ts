import * as vscode from "vscode";

/**
 * Reports which files this participant is holding unsaved edits to.
 *
 * The relay uses it to refuse an agent write that would destroy work nobody
 * else can see. Reporting the whole set on every change rather than deltas
 * means a reconnect resynchronises by itself and a missed message cannot leave
 * a phantom lock behind.
 */
export function watchDirtyBuffers(
  report: (paths: string[]) => void,
): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let last = "";

  const collect = (): string[] =>
    vscode.workspace.textDocuments
      .filter((d) => d.isDirty && d.uri.scheme === "file")
      .map((d) => d.uri.fsPath)
      .sort();

  const publish = (): void => {
    const paths = collect();
    // Typing fires a change per keystroke; the set itself rarely moves.
    const key = paths.join("\n");
    if (key === last) return;
    last = key;
    report(paths);
  };

  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(publish, 250);
  };

  const subscriptions = [
    vscode.workspace.onDidChangeTextDocument(schedule),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument(schedule),
  ];

  // Announce the current state immediately: files can already be dirty when
  // the session starts, and the first write may arrive before anyone types.
  publish();

  return {
    dispose() {
      clearTimeout(timer);
      for (const s of subscriptions) s.dispose();
    },
  };
}

/**
 * Bring a file the agent changed into view.
 *
 * VS Code reloads an unmodified open document from disk by itself, so the work
 * here is only making sure the reader is looking at it. Opened beside rather
 * than replacing what someone is working on.
 */
export async function revealChangedFile(path: string): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.One,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(`Could not open ${path}: ${detail}`);
  }
}
