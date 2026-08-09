import * as os from "node:os";
import * as vscode from "vscode";
import { revealChangedFile, watchDirtyBuffers } from "./buffers.js";
import { ensureRelay, resolveServerPaths } from "./bootstrap.js";
import { AgentPanel } from "./panel.js";
import { RoomSession } from "./session.js";

let session: RoomSession | undefined;
let panel: AgentPanel | undefined;
let bufferWatch: vscode.Disposable | undefined;
let statusItem: vscode.StatusBarItem | undefined;

function config() {
  return vscode.workspace.getConfiguration("mpa");
}

function setting(key: string): string | undefined {
  return config().get<string>(key)?.trim() || undefined;
}

/**
 * A stable identity for this window.
 *
 * Both halves matter more than they look. The name is asked for rather than
 * taken from the OS because two windows on one machine otherwise both show up
 * as the same person, which makes attribution meaningless — and attribution is
 * the point of the log. The id is persisted in *workspace* state because it has
 * to survive a reload (so a reconnecting driver reclaims the token rather than
 * arriving as a stranger) while still differing between two windows.
 */
async function resolveIdentity(
  context: vscode.ExtensionContext,
): Promise<{ userId: string; name: string } | undefined> {
  let name = setting("displayName");

  if (!name) {
    name = (
      await vscode.window.showInputBox({
        prompt: "Your name in the shared session",
        value: os.userInfo().username,
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.trim().length === 0
            ? "Pick something your teammates will recognise"
            : null,
      })
    )?.trim();
    if (!name) return undefined;

    // Workspace scope where there is one, so a second window on a different
    // folder can be a different person. Falls back to global for a bare window.
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await config().update("displayName", name, target);
  }

  const key = "mpa.userId";
  let userId = context.workspaceState.get<string>(key);
  if (!userId) {
    userId = `${slug(name)}-${Math.random().toString(36).slice(2, 8)}`;
    await context.workspaceState.update(key, userId);
  }
  return { userId, name };
}

function slug(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "user"
  );
}

function showStatus(text: string, tooltip?: string): void {
  if (!statusItem) {
    statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    statusItem.command = "mpa.showPanel";
  }
  statusItem.text = text;
  statusItem.tooltip = tooltip ?? "Multiplayer Agent";
  statusItem.show();
}

async function startSession(
  context: vscode.ExtensionContext,
  host: boolean,
): Promise<void> {
  const roomId = (
    await vscode.window.showInputBox({
      prompt: host ? "Room name to host" : "Room name to join",
      value: "demo",
      ignoreFocusOut: true,
    })
  )?.trim();
  if (!roomId) return;

  const identity = await resolveIdentity(context);
  if (!identity) return;

  const paths = resolveServerPaths(context.extensionPath, {
    relay: setting("relayEntry"),
    agentHost: setting("agentHostEntry"),
  });
  if ("error" in paths) {
    const pick = await vscode.window.showErrorMessage(
      paths.error,
      "Open Settings",
    );
    if (pick === "Open Settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "mpa.");
    }
    return;
  }

  const relayUrl = setting("relayUrl") ?? "ws://127.0.0.1:7331";
  const workspaceDir =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const cfg = config();

  // One room at a time keeps things honest; multi-room comes with the sidebar.
  session?.dispose();
  panel?.dispose();
  bufferWatch?.dispose();

  // The panel comes up before the relay is contacted, so that starting one has
  // somewhere to report to. Watching a blank screen wondering whether anything
  // is happening is the failure this whole milestone keeps running into.
  panel = new AgentPanel(context.extensionUri, {
    submit: (text) => session?.submitPrompt(text),
    interrupt: () => session?.interrupt(),
    requestDriver: () => session?.requestDriver(),
    releaseDriver: () => session?.releaseDriver(),
    grantDriver: (userId) => session?.grantDriver(userId),
    promoteSuggestion: (id) => session?.promoteSuggestion(id),
    dismissSuggestion: (id) => session?.dismissSuggestion(id),
    decideApproval: (requestId, allow) =>
      session?.decideApproval(requestId, allow),
    openFile: (path) => void revealChangedFile(path),
  });
  panel.show(`Shared Agent — ${roomId}`);

  const ready = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Multiplayer Agent" },
    async (progress) => {
      progress.report({ message: "connecting to the relay…" });
      return ensureRelay(paths.relayEntry, relayUrl, setting("dbPath"), (line) =>
        panel?.postStatus(line),
      );
    },
  );
  if (!ready) {
    panel.postStatus(`could not reach the relay at ${relayUrl}`);
    void vscode.window.showErrorMessage(
      `Could not reach or start the relay at ${relayUrl}. If it should be running elsewhere, check the mpa.relayUrl setting.`,
    );
    return;
  }

  session = new RoomSession(
    {
      relayUrl,
      roomId,
      userId: identity.userId,
      name: identity.name,
      host,
      agentHostEntry: paths.agentHostEntry,
      workspaceDir,
      allowedTools: cfg.get<string>("allowedTools") ?? "Read,Glob,Grep",
      disallowedTools: cfg.get<string>("disallowedTools") ?? "",
      token: setting("token"),
      onFatal: (message) => {
        void vscode.window.showErrorMessage(message);
      },
    },
    {
      onEvent: (event, replay) => panel?.postEvent(event, replay),
      onParticipants: (participants) => panel?.postParticipants(participants),
      onStatus: (text) => panel?.postStatus(text),
      onIdentity: (you) => panel?.postIdentity(you),
    },
  );
  session.start();

  // The relay refuses agent writes to files anyone is still editing, which
  // only works if it knows what those are.
  bufferWatch = watchDirtyBuffers((paths) => session?.sendBufferState(paths));
  context.subscriptions.push(bufferWatch);

  showStatus(
    `$(broadcast) ${roomId}`,
    `Multiplayer Agent: ${host ? "hosting" : "joined"} “${roomId}” as ${identity.name}`,
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
    vscode.commands.registerCommand("mpa.showPanel", () =>
      panel?.reveal() ??
      vscode.window.showInformationMessage("No shared session is running."),
    ),
    vscode.commands.registerCommand("mpa.interrupt", () => session?.interrupt()),
    vscode.commands.registerCommand("mpa.requestDriver", () =>
      session?.requestDriver(),
    ),
    vscode.commands.registerCommand("mpa.releaseDriver", () =>
      session?.releaseDriver(),
    ),
    vscode.commands.registerCommand("mpa.stopAgent", async () => {
      const pick = await vscode.window.showWarningMessage(
        "Stop the shared agent? This ends the session for everyone in the room.",
        { modal: true },
        "Stop it",
      );
      if (pick === "Stop it") session?.stopAgent();
    }),
    { dispose: () => deactivate() },
  );
}

export function deactivate(): void {
  session?.dispose();
  session = undefined;
  panel?.dispose();
  panel = undefined;
  bufferWatch?.dispose();
  bufferWatch = undefined;
  statusItem?.dispose();
  statusItem = undefined;
}
