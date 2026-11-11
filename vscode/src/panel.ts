import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Manager, SourceInput } from './core/manager';
import { InstalledComponent } from './core/types';

type FromWebview =
  | { type: 'ready' }
  | { type: 'selectSource'; id: string }
  | { type: 'saveSource'; source: SourceInput; token?: string }
  | { type: 'testSource'; source: SourceInput; token?: string }
  | { type: 'removeSource'; id: string }
  | { type: 'refresh' }
  | { type: 'setTarget'; scope: 'user' | 'repo'; layout: 'copilot' | 'claude' | 'agents' }
  | { type: 'setAutoUpdate'; value: boolean }
  | { type: 'install'; items: Array<{ pkg: string; components: InstalledComponent[] }>; overwrite: boolean }
  | { type: 'update'; pkg: string }
  | { type: 'updateAll' }
  | { type: 'uninstall'; pkg: string; items: InstalledComponent[] | 'all' }
  | { type: 'preview'; pkg: string; kind: string; name: string }
  | { type: 'openLink'; pkg: string }
  | { type: 'browseFolder' };

/** The manager UI, shown as an editor tab (like the Visual Studio tool window). */
export class ManagerPanel {
  private static current: ManagerPanel | undefined;

  static show(context: vscode.ExtensionContext, manager: Manager): void {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('agentPluginManager', 'Agent Plugin Manager', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');
    ManagerPanel.current = new ManagerPanel(panel, context, manager);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel, context: vscode.ExtensionContext, private readonly manager: Manager) {
    panel.webview.html = this.html(panel.webview, context.extensionUri);
    panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m), undefined, this.disposables);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    manager.onChange = () => void this.pushState();
    manager.onLog = text => void panel.webview.postMessage({ type: 'log', text });
    // Repo-scope destinations depend on the open folder.
    vscode.workspace.onDidChangeWorkspaceFolders(() => void this.pushState(), undefined, this.disposables);
  }

  private dispose(): void {
    ManagerPanel.current = undefined;
    this.manager.onChange = () => { /* no panel */ };
    this.manager.onLog = () => { /* no panel */ };
    this.disposables.forEach(d => d.dispose());
  }

  private async pushState(): Promise<void> {
    try {
      await this.panel.webview.postMessage({ type: 'state', state: await this.manager.viewState() });
    } catch { /* panel closed */ }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          await this.pushState();
          if (!this.manager.packagesSourceId && this.manager.currentSource && !this.manager.busy) {
            await this.manager.init();
          }
          break;
        case 'selectSource': await this.manager.selectSource(m.id); break;
        case 'saveSource':
          try {
            await this.manager.saveSource(m.source, m.token);
            this.post({ type: 'dialogResult', ok: true });
          } catch (ex: any) {
            this.post({ type: 'dialogResult', ok: false, error: ex?.message ?? String(ex) });
            await this.pushState();
          }
          break;
        case 'testSource':
          try {
            this.post({ type: 'testResult', ok: true, message: await this.manager.test(m.source, m.token) });
          } catch (ex: any) {
            this.post({ type: 'testResult', ok: false, message: ex?.message ?? String(ex) });
          }
          break;
        case 'removeSource': await this.manager.removeSource(m.id); break;
        case 'refresh': await this.manager.loadSource(); break;
        case 'setTarget': this.manager.setTarget(m.scope, m.layout); break;
        case 'setAutoUpdate': await this.manager.setAutoUpdate(m.value); break;
        case 'install': await this.manager.install(m.items, m.overwrite); break;
        case 'update': await this.manager.updatePackage(m.pkg); break;
        case 'updateAll': await this.manager.updateAll(); break;
        case 'uninstall': await this.manager.uninstall(m.pkg, m.items); break;
        case 'preview':
          this.post({ type: 'preview', pkg: m.pkg, kind: m.kind, name: m.name, text: this.manager.getPreview(m.pkg, m.kind, m.name) });
          break;
        case 'openLink': {
          const url = this.manager.getHomepage(m.pkg);
          if (/^https?:\/\//i.test(url)) {
            await vscode.env.openExternal(vscode.Uri.parse(url));
          }
          break;
        }
        case 'browseFolder': {
          const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select plugin source folder' });
          this.post({ type: 'folder', path: picked?.[0]?.fsPath });
          break;
        }
      }
    } catch (ex: any) {
      this.post({ type: 'log', text: 'Error: ' + (ex?.message ?? String(ex)) });
    }
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Agent Plugin Manager</title>
</head>
<body>
<div class="root">
  <header>
    <h1>Agent Plugin Manager</h1>
    <p class="muted">Browse agent-plugins.org packages and install the skills, agents, prompts and MCP servers you need.</p>
  </header>

  <section class="panel source">
    <div class="row">
      <span class="label">SOURCE</span>
      <select id="source" class="grow"></select>
      <div class="btns">
        <button class="accent" data-a="addSource">Add source</button>
        <button id="btnEdit" data-a="editSource">Edit</button>
        <button id="btnRemove" data-a="removeSource">Remove</button>
        <button id="btnRefresh" data-a="refresh">Refresh</button>
      </div>
    </div>
    <div class="row status">
      <div class="grow">
        <div id="busy" class="progress hidden"></div>
        <div id="status" class="muted"></div>
      </div>
      <label class="check"><input type="checkbox" id="auto"><span class="box"></span>Auto-update installed plugins</label>
      <button id="btnUpdateAll" class="accent hidden" data-a="updateAll"></button>
    </div>
  </section>

  <main class="body">
    <section class="panel list">
      <input id="search" type="text" placeholder="Search packages…" title="Filter packages by name, description, keyword or component">
      <div class="selall">
        <label class="check"><input type="checkbox" id="selAll"><span class="box"></span>Select all packages</label>
        <span id="pkgCount" class="muted"></span>
      </div>
      <div id="pkgList" class="scroll"></div>
    </section>
    <section class="panel detail" id="detail"></section>
  </main>

  <section class="panel install">
    <div class="install-main">
      <div class="row wrap">
        <span class="label">INSTALL TO</span>
        <div class="segment" id="scope">
          <button data-scope="user">User folders</button>
          <button data-scope="repo">This repository</button>
        </div>
        <span class="label">CLIENT</span>
        <select id="layout">
          <option value="copilot">GitHub Copilot  (.github / .copilot)</option>
          <option value="claude">Claude Code  (.claude)</option>
          <option value="agents">Agent-neutral  (.agents, skills only)</option>
        </select>
        <label class="check"><input type="checkbox" id="overwrite"><span class="box"></span>Overwrite existing</label>
      </div>
      <pre id="destination" class="muted mono"></pre>
    </div>
    <button id="btnInstall" class="accent big" data-a="install" disabled>Install</button>
  </section>

  <pre id="log" class="log hidden"></pre>
</div>

<div id="modal" class="modal hidden"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
