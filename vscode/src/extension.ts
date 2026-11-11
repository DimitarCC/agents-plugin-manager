import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AuthProvider } from './auth';
import { Host, Manager } from './core/manager';
import { ensureDir } from './core/fsutil';
import { ManagerPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const dataRoot = context.globalStorageUri.fsPath;
  ensureDir(dataRoot);
  const auth = new AuthProvider(context.secrets);

  const host: Host = {
    dataRoot,
    env: {
      home: os.homedir(),
      // <User>/globalStorage/<extension id>  ->  <User>  (holds mcp.json and the prompts folder of the active profile)
      userDir: path.resolve(dataRoot, '..', '..'),
      userPayloadRoot: path.join(dataRoot, 'plugins'),
    },
    async confirm(message, detail) {
      const yes = 'Yes';
      return (await vscode.window.showWarningMessage(message, { modal: true, detail }, yes)) === yes;
    },
    async pickFolder() {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
      return r?.[0]?.fsPath;
    },
    getWorkspaceFolder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    authHeader: (source, interactive) => auth.authHeader(source, interactive),
    getToken: id => auth.getToken(id),
    setToken: (id, token) => auth.setToken(id, token),
  };

  const manager = new Manager(host);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentPluginManager.open', () => ManagerPanel.show(context, manager)),
  );

  // Quiet background update check shortly after startup (never shows a sign-in prompt).
  const timer = setTimeout(() => {
    manager.runBackgroundUpdate().then(updated => {
      if (updated.length > 0) {
        vscode.window.setStatusBarMessage(`Agent Plugin Manager updated ${updated.length} plugin(s): ${updated.join(', ')}`, 15000);
      }
    }).catch(() => { /* offline etc. */ });
  }, 20000);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

export function deactivate(): void { /* nothing to clean up */ }
