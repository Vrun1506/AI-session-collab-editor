import { existsSync } from "node:fs";
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
  const configured = config().get<string>("displayName")?.trim();
  let name = configured;

  if (!name) {
    name = (
      await vscode.window.showInputBox({
        prompt: "Your name in the shared session",
        value: os.userInfo().username,
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.trim().length === 0 ? "Pick something your teammates will recognise" : null,
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
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "user";
}

/**
 * Find the agent-host entry point.
 *
 * The dev layout (sibling package in the monorepo) is the only one that exists
 * when running from source, and the only one that does *not* exist once the
 * extension is installed from a .vsix into ~/.vscode/extensions — where the
 * old unconditional guess pointed at a file that was never there and failed
 * silently.
 */
function resolveAgentHostEntry(
  context: vscode.ExtensionContext,
): { path: string } | { error: string } {
  const configured = config().get<string>("agentHostEntry")?.trim();
  if (configured) {
    return existsSync(configured)
      ? { path: configured }
      : { error: `mpa.agentHostEntry points at a file that does not exist: ${configured}` };
  }

  const candidates = [
    // Installed layout, if the agent-host is ever shipped inside the extension.
    path.join(context.extensionPath, "agent-host", "dist", "index.js"),
    // Dev layout: packages/vscode-ext -> packages/agent-host/dist/index.js
    path.join(context.extensionPath, "..", "agent-host", "dist", "index.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found) return { path: found };

  return {
    error:
      "Could not find the agent-host. Set `mpa.agentHostEntry` to the absolute " +
      "path of packages/agent-host/dist/index.js, or start it yourself with " +
      "`pnpm agent` and use Join Session instead.",
  };
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

  // Fail before tearing down a working session: nothing is worse than losing
  // the room you were in to a command that was never going to work.
  let agentHostEntry = "";
  if (host) {
    const resolved = resolveAgentHostEntry(context);
    if ("error" in resolved) {
      const pick = await vscode.window.showErrorMessage(
        resolved.error,
        "Open Settings",
        "Join Instead",
      );
      if (pick === "Open Settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "mpa.agentHostEntry",
        );
      } else if (pick === "Join Instead") {
        await startSession(context, false);
      }
      return;
    }
    agentHostEntry = resolved.path;
  }

  const workspaceDir =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const cfg = config();

  // One room at a time keeps things honest; multi-room comes with the sidebar.
  session?.dispose();
  panel?.dispose();

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
  });
  panel.show(`Shared Agent — ${roomId}`);

  session = new RoomSession(
    {
      relayUrl: cfg.get<string>("relayUrl") ?? "ws://127.0.0.1:7331",
      roomId,
      userId: identity.userId,
      name: identity.name,
      host,
      agentHostEntry,
      workspaceDir,
      allowedTools: cfg.get<string>("allowedTools") ?? "Read,Glob,Grep",
      disallowedTools:
        cfg.get<string>("disallowedTools") ?? "Write,Edit,MultiEdit,NotebookEdit",
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

  vscode.window.setStatusBarMessage(
    `Multiplayer Agent: ${host ? "hosting" : "joined"} “${roomId}” as ${identity.name}`,
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
    vscode.commands.registerCommand("mpa.requestDriver", () =>
      session?.requestDriver(),
    ),
    vscode.commands.registerCommand("mpa.releaseDriver", () =>
      session?.releaseDriver(),
    ),
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
