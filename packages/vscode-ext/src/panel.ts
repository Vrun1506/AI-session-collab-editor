import * as vscode from "vscode";
import type { Participant, SessionEvent } from "@mpa/protocol";

/**
 * The shared agent panel.
 *
 * The webview folds raw log events into the transcript itself, so replayed
 * history and live events go through exactly one rendering path — a late
 * joiner sees the same thing as someone who was there from the start.
 */
export class AgentPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSubmit: (text: string) => void,
    private readonly onInterrupt: () => void,
  ) {}

  show(title: string): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "mpa.agentPanel",
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );

    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg: { type: string; text?: string }) => {
      if (msg.type === "submit" && msg.text) this.onSubmit(msg.text);
      else if (msg.type === "interrupt") this.onInterrupt();
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  postEvent(event: SessionEvent, replay: boolean): void {
    void this.panel?.webview.postMessage({ type: "event", event, replay });
  }

  postParticipants(participants: Participant[]): void {
    void this.panel?.webview.postMessage({ type: "participants", participants });
  }

  postStatus(text: string): void {
    void this.panel?.webview.postMessage({ type: "status", text });
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private html(webview: vscode.Webview): string {
    const uri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "media", file),
      );
    const nonce = Math.random().toString(36).slice(2);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri("panel.css")}" rel="stylesheet">
<title>Shared Agent</title>
</head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <span id="participants">connecting…</span>
    <button id="interrupt" title="Anyone may interrupt a running turn">Interrupt</button>
  </header>
  <main id="transcript"></main>
  <footer>
    <textarea id="input" rows="2" placeholder="Prompt the shared agent… (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
  </footer>
  <div id="status"></div>
  <script nonce="${nonce}" src="${uri("panel.js")}"></script>
</body>
</html>`;
  }
}
