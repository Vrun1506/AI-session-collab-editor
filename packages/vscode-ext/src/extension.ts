import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentPanel } from "./panel.js";
import { RoomSession } from "./session.js";

let session: RoomSession | undefined;
let panel: AgentPanel | undefined;

function config() {
  return vscode.workspace.getConfiguration("mpa");
}

function defaultAgentHostEntry(context: vscode.ExtensionContext): string {
  // Dev layout: packages/vscode-ext -> packages/agent-host/dist/index.js
  return path.join(
    context.extensionPath,
    "..",
    "agent-host",
    "dist",
    "index.js",
  );
}

async function startSession(
  context: vscode.ExtensionContext,
  host: boolean,
): Promise<void> {
  const roomId = await vscode.window.showInputBox({
    prompt: host ? "Room name to host" : "Room name to join",
    value: "demo",
    ignoreFocusOut: true,
  });
  if (!roomId) return;

  const workspaceDir =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

  const cfg = config();
  const name =
    cfg.get<string>("displayName")?.trim() || os.userInfo().username;
  const agentHostEntry =
    cfg.get<string>("agentHostEntry")?.trim() ||
    defaultAgentHostEntry(context);

  // One room at a time keeps M0 honest; multi-room comes with the sidebar.
  session?.dispose();
  panel?.dispose();

  panel = new AgentPanel(
    context.extensionUri,
    (text) => session?.submitPrompt(text),
    () => session?.interrupt(),
  );
  panel.show(`Shared Agent — ${roomId}`);

  session = new RoomSession(
    {
      relayUrl: cfg.get<string>("relayUrl") ?? "ws://127.0.0.1:7331",
      roomId,
      userId: `${name}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      host,
      agentHostEntry,
      workspaceDir,
      allowedTools: cfg.get<string>("allowedTools") ?? "Read,Glob,Grep",
    },
    {
      onEvent: (event, replay) => panel?.postEvent(event, replay),
      onParticipants: (participants) => panel?.postParticipants(participants),
      onStatus: (text) => panel?.postStatus(text),
    },
  );
  session.start();

  vscode.window.setStatusBarMessage(
    `Multiplayer Agent: ${host ? "hosting" : "joined"} “${roomId}”`,
    4000,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("mpa.hostSession", () =>
      startSession(context, true),
    ),
    vscode.commands.registerCommand("mpa.joinSession", () =>
      startSession(context, false),
    ),
    vscode.commands.registerCommand("mpa.interrupt", () => session?.interrupt()),
    vscode.commands.registerCommand("mpa.stopAgent", () => {
      session?.stopAgent();
      vscode.window.showInformationMessage(
        "Shared agent stopped for everyone in the room.",
      );
    }),
    { dispose: () => deactivate() },
  );
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
  panel?.dispose();
  panel = undefined;
}
