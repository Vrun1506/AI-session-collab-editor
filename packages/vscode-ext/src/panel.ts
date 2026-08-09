import * as vscode from "vscode";
import type { Participant, SessionEvent } from "@mpa/protocol";

/** Everything the webview can ask the session to do. */
export interface PanelActions {
  submit(text: string): void;
  interrupt(): void;
  requestDriver(): void;
  releaseDriver(): void;
  grantDriver(userId: string): void;
  promoteSuggestion(suggestionId: string): void;
  dismissSuggestion(suggestionId: string): void;
  decideApproval(requestId: string, allow: boolean): void;
}

interface WebviewMessage {
  type: string;
  text?: string;
  userId?: string;
  suggestionId?: string;
  requestId?: string;
  allow?: boolean;
}

/**
 * The shared agent panel.
 *
 * The webview folds raw log events into the transcript, the driver token, the
 * suggestion queue and the cost ledger itself, so replayed history and live
 * events go through exactly one rendering path — a late joiner sees the same
 * thing as someone who was there from the start. This class is only a pipe.
 */
export class AgentPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: PanelActions,
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
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      switch (msg.type) {
        case "submit":
          if (msg.text) this.actions.submit(msg.text);
          break;
        case "interrupt":
          this.actions.interrupt();
          break;
        case "requestDriver":
          this.actions.requestDriver();
          break;
        case "releaseDriver":
          this.actions.releaseDriver();
          break;
        case "grantDriver":
          if (msg.userId) this.actions.grantDriver(msg.userId);
          break;
        case "promoteSuggestion":
          if (msg.suggestionId) this.actions.promoteSuggestion(msg.suggestionId);
          break;
        case "dismissSuggestion":
          if (msg.suggestionId) this.actions.dismissSuggestion(msg.suggestionId);
          break;
        case "decideApproval":
          if (msg.requestId) {
            this.actions.decideApproval(msg.requestId, msg.allow === true);
          }
          break;
      }
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

  postIdentity(you: Participant): void {
    void this.panel?.webview.postMessage({ type: "identity", you });
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
    <span class="spacer"></span>
    <span id="ledger" class="ledger" title="Cost of this room, by who asked"></span>
    <button id="interrupt" title="Anyone may interrupt a running turn">Interrupt</button>
  </header>
  <div id="driverbar" class="driverbar"></div>
  <div id="approvals"></div>
  <div id="queue"></div>
  <main id="transcript"></main>
  <footer>
    <textarea id="input" rows="2"></textarea>
    <button id="send">Send</button>
  </footer>
  <div id="status"></div>
  <script nonce="${nonce}" src="${uri("panel.js")}"></script>
</body>
</html>`;
  }
}
