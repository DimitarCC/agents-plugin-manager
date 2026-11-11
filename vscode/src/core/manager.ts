import * as crypto from 'crypto';
import * as path from 'path';
import { ensureDir, readJsonFile, writeJsonFile } from './fsutil';
import { GitError, SyncContext, basicAuthHeader, syncSource, testSource } from './git';
import { InstallEnv, install, resolveLayout, uninstall, findRepoRoot } from './installer';
import { discover, kindOrder } from './scanner';
import {
  annotate, applyUpdate, findUpdates, recordInstall, RecordStore, UpdateInfo, runAutoUpdate,
} from './updates';
import {
  AuthMode, ClientLayout, InstallRecord, InstallScope, InstalledComponent, PluginComponent, PluginPackage,
  PluginSource, Settings, SourceKind, keyOf, recordKey, sameComponent, whereLabel,
} from './types';

/** Everything the manager needs from the hosting application (VS Code, or a test). */
export interface Host {
  dataRoot: string;
  env: InstallEnv;
  confirm(message: string, detail?: string): Promise<boolean>;
  pickFolder(): Promise<string | undefined>;
  /** Folder of the open workspace, if any. */
  getWorkspaceFolder(): string | undefined;
  /** Resolves the HTTP auth header for a source (token, VS Code account, …). */
  authHeader(source: PluginSource, interactive: boolean): Promise<string | undefined>;
  getToken(sourceId: string): Promise<string | undefined>;
  setToken(sourceId: string, token: string | undefined): Promise<void>;
}

export interface SourceInput {
  id?: string;
  name: string;
  kind: SourceKind;
  location: string;
  ref: string;
  auth: AuthMode;
}

export interface InstallItem {
  pkg: string;
  components: InstalledComponent[];
}

// ───────── view state sent to the webview ─────────

export interface ViewComponent {
  kind: PluginComponent['kind'];
  name: string;
  description: string;
  relativePath: string;
  installable: boolean;
  installedHere: boolean;
}

export interface ViewPackage {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  homepage: string;
  keywords: string[];
  warnings: string[];
  summary: string;
  installedSummary: string;
  hasUpdate: boolean;
  updateText: string;
  installedHere?: { where: string; version: string; count: number };
  components: ViewComponent[];
}

export interface ViewState {
  sources: Array<SourceInput & { id: string; hasToken: boolean }>;
  currentSourceId: string;
  scope: InstallScope;
  layout: ClientLayout;
  autoUpdate: boolean;
  repoAvailable: boolean;
  busy: boolean;
  status: string;
  destination: string[];
  updateCount: number;
  packages: ViewPackage[];
}

function newId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function summarize(p: PluginPackage): string {
  const n = (k: string) => p.components.filter(c => c.kind === k).length;
  const parts: string[] = [];
  if (n('skill') > 0) { parts.push(`${n('skill')} skill${n('skill') === 1 ? '' : 's'}`); }
  if (n('agent') > 0) { parts.push(`${n('agent')} agent${n('agent') === 1 ? '' : 's'}`); }
  if (n('prompt') > 0) { parts.push(`${n('prompt')} prompt${n('prompt') === 1 ? '' : 's'}`); }
  if (n('mcp') > 0) { parts.push(`${n('mcp')} MCP`); }
  return parts.length === 0 ? 'no components' : parts.join(' · ');
}

export class Manager {
  settings: Settings;
  readonly store: RecordStore;
  packages: PluginPackage[] = [];
  packagesSourceId = '';
  updates: UpdateInfo[] = [];
  busy = false;
  status = '';
  onChange: () => void = () => { /* set by host */ };
  onLog: (text: string) => void = () => { /* set by host */ };

  private abort?: AbortController;
  private readonly tokenFlags = new Map<string, boolean>();

  constructor(private readonly host: Host) {
    this.settings = this.loadSettings();
    this.store = new RecordStore(host.dataRoot);
  }

  // ───────── settings ─────────

  private get settingsFile(): string {
    return path.join(this.host.dataRoot, 'settings.json');
  }

  private loadSettings(): Settings {
    const s = readJsonFile<Partial<Settings>>(this.settingsFile) ?? {};
    return {
      sources: Array.isArray(s.sources) ? s.sources : [],
      lastSourceId: s.lastSourceId,
      scope: s.scope === 'repo' ? 'repo' : 'user',
      layout: s.layout === 'claude' || s.layout === 'agents' ? s.layout : 'copilot',
      autoUpdate: s.autoUpdate === true,
    };
  }

  private save(): void {
    ensureDir(this.host.dataRoot);
    writeJsonFile(this.settingsFile, this.settings);
  }

  get currentSource(): PluginSource | undefined {
    return this.settings.sources.find(s => s.id === this.settings.lastSourceId) ?? this.settings.sources[0];
  }

  // ───────── repository / target ─────────

  getRepoRoot(): string | undefined {
    const ws = this.host.getWorkspaceFolder();
    return ws ? findRepoRoot(ws) : undefined;
  }

  private destinationLines(): string[] {
    const repo = this.getRepoRoot();
    if (this.settings.scope === 'repo' && !repo) {
      return ['No folder is open — open one to install into a repository.'];
    }
    const l = resolveLayout(this.settings.scope, this.settings.layout, repo, this.host.env);
    const lines: string[] = [];
    if (l.skillsDir) { lines.push('skills   ' + l.skillsDir); }
    if (l.agentsDir) { lines.push('agents   ' + l.agentsDir); }
    if (l.promptsDir) { lines.push('prompts  ' + l.promptsDir); }
    if (l.mcpFile) { lines.push('mcp      ' + l.mcpFile); }
    return lines;
  }

  setTarget(scope: InstallScope, layout: ClientLayout): void {
    this.settings.scope = scope;
    this.settings.layout = layout;
    this.save();
    this.onChange();
  }

  setAutoUpdate(on: boolean): Promise<void> {
    this.settings.autoUpdate = on;
    this.save();
    this.onChange();
    return on && this.updates.length > 0 ? this.applyUpdates(this.updates.slice(), true) : Promise.resolve();
  }

  /** The install record of a package at the destination currently chosen in the install bar. */
  private currentRecord(pkgName: string): InstallRecord | undefined {
    const repo = this.settings.scope === 'repo' ? this.getRepoRoot() : undefined;
    if (this.settings.scope === 'repo' && !repo) {
      return undefined;
    }
    const key = recordKey(this.packagesSourceId, pkgName, this.settings.scope, repo, this.settings.layout);
    return this.store.load().find(r => keyOf(r) === key);
  }

  // ───────── sources ─────────

  async init(): Promise<void> {
    if (this.currentSource) {
      await this.loadSource();
    }
  }

  async selectSource(id: string): Promise<void> {
    this.settings.lastSourceId = id;
    this.save();
    await this.loadSource();
  }

  async saveSource(input: SourceInput, token: string | undefined): Promise<PluginSource> {
    const location = input.location.trim();
    if (!location) {
      throw new Error('Location is required.');
    }
    let name = input.name.trim();
    if (!name) {
      name = input.kind === 'git' ? location.replace(/\/+$/, '') : path.basename(location.replace(/[\\/]+$/, ''));
    }
    const src: PluginSource = {
      id: input.id ?? newId(), name, kind: input.kind, location, ref: input.kind === 'git' ? input.ref.trim() : '',
      auth: input.kind === 'git' ? input.auth : 'none',
    };
    const i = this.settings.sources.findIndex(s => s.id === src.id);
    if (i >= 0) { this.settings.sources[i] = src; } else { this.settings.sources.push(src); }
    this.settings.lastSourceId = src.id;
    this.save();
    this.tokenFlags.delete(src.id);

    if (src.auth !== 'pat') {
      await this.host.setToken(src.id, undefined);
    } else if (token !== undefined) {
      if (token === '') {
        throw new Error('Enter an access token.');
      }
      await this.host.setToken(src.id, token);
    } else if (!(await this.host.getToken(src.id))) {
      throw new Error('Enter an access token.');
    }
    await this.loadSource();
    return src;
  }

  async removeSource(id: string): Promise<void> {
    const src = this.settings.sources.find(s => s.id === id);
    if (!src) {
      return;
    }
    if (!(await this.host.confirm(`Remove source '${src.name}'?`))) {
      return;
    }
    this.settings.sources = this.settings.sources.filter(s => s.id !== id);
    if (this.settings.lastSourceId === id) {
      this.settings.lastSourceId = this.settings.sources[0]?.id;
    }
    await this.host.setToken(id, undefined);
    this.save();
    this.packages = [];
    this.updates = [];
    this.packagesSourceId = '';
    this.status = this.settings.sources.length === 0 ? 'Add a source repository to get started.' : '';
    this.onChange();
    if (this.currentSource) {
      await this.loadSource();
    }
  }

  async test(input: SourceInput, token: string | undefined): Promise<string> {
    const location = input.location.trim();
    if (!location) {
      throw new Error('Enter a location first.');
    }
    const src: PluginSource = {
      id: input.id ?? '__test__', name: input.name, kind: input.kind, location, ref: input.ref, auth: input.kind === 'git' ? input.auth : 'none',
    };
    const header = await this.headerFor(src, true, token);
    const ctx: SyncContext = { cacheRoot: path.join(this.host.dataRoot, 'cache'), authHeader: header, interactive: true };
    await testSource(src, ctx);
    return 'Connection OK.';
  }

  private async headerFor(src: PluginSource, interactive: boolean, tokenOverride?: string): Promise<string | undefined> {
    if (src.auth === 'pat' && tokenOverride) {
      return basicAuthHeader(src.location, tokenOverride);
    }
    return this.host.authHeader(src, interactive);
  }

  async sourceHasToken(id: string): Promise<boolean> {
    return (await this.host.getToken(id)) !== undefined;
  }

  // ───────── loading ─────────

  async loadSource(): Promise<void> {
    const source = this.currentSource;
    this.abort?.abort();
    this.packages = [];
    this.updates = [];
    this.packagesSourceId = '';
    if (!source) {
      this.status = 'Add a source repository to get started.';
      this.onChange();
      return;
    }
    const ac = this.abort = new AbortController();
    this.busy = true;
    this.status = 'Connecting to ' + source.name + '…';
    this.onChange();
    try {
      const ctx: SyncContext = {
        cacheRoot: path.join(this.host.dataRoot, 'cache'),
        authHeader: await this.host.authHeader(source, true),
        interactive: true,
        signal: ac.signal,
        progress: m => { this.status = m; this.onChange(); },
      };
      const root = await syncSource(source, ctx);
      const found = discover(root);
      if (ac.signal.aborted) {
        return;
      }
      this.packages = found;
      this.packagesSourceId = source.id;
      this.refreshUpdateState();
      this.status = `${found.length} plugin package(s) in ${source.name}` + (this.updates.length > 0 ? ` · ${this.updates.length} update(s) available` : '');
      this.busy = false;
      this.onChange();
      if (this.settings.autoUpdate && this.updates.length > 0) {
        await this.applyUpdates(this.updates.slice(), true);
      }
    } catch (ex: any) {
      if (ac.signal.aborted) {
        return;
      }
      this.status = 'Failed to load source.';
      this.onLog(`Failed to load '${source.name}':\n${ex instanceof GitError ? ex.message : ex?.message ?? String(ex)}`);
    } finally {
      if (this.abort === ac) {
        this.busy = false;
        this.onChange();
      }
    }
  }

  private refreshUpdateState(): void {
    this.updates = annotate(this.packages, this.packagesSourceId, this.store.load());
  }

  // ───────── install / update / uninstall ─────────

  async install(items: InstallItem[], overwrite: boolean): Promise<void> {
    const work = items
      .map(i => {
        const pkg = this.packages.find(p => p.name === i.pkg);
        const comps = pkg ? pkg.components.filter(c => c.installable && i.components.some(ic => sameComponent(ic, c))) : [];
        return { pkg, comps };
      })
      .filter(w => w.pkg && w.comps.length > 0) as Array<{ pkg: PluginPackage; comps: PluginComponent[] }>;
    if (work.length === 0) {
      this.onLog('Nothing selected. Tick the items or packages you want to install.');
      return;
    }

    const scope = this.settings.scope;
    const repo = this.getRepoRoot();
    if (scope === 'repo' && !repo) {
      this.onLog('No folder is open, so there is no repository to install into.');
      return;
    }
    if (work.some(w => w.comps.some(c => c.kind === 'mcp')) &&
      !(await this.host.confirm('Install MCP servers?', 'MCP servers can launch programs or connect to remote services. Only install servers from sources you trust.'))) {
      return;
    }

    const layout = this.settings.layout;
    const lines: string[] = [];
    for (const w of work) {
      try {
        const res = install({ pkg: w.pkg, components: w.comps, scope, layout, repoRoot: repo, overwrite, env: this.host.env });
        recordInstall(this.store, w.pkg, this.packagesSourceId, scope, repo, layout, res.installedComponents);
        lines.push(`${w.pkg.name}: installed ${res.installed.length}, skipped ${res.skipped.length}`);
        res.installed.forEach(s => lines.push('  + ' + s));
        res.skipped.forEach(s => lines.push('  - ' + s));
      } catch (ex: any) {
        lines.push(`${w.pkg.name}: FAILED — ${ex.message}`);
      }
    }
    lines.push("Restart the chat/agent session if the new items don't show up yet.");
    this.refreshUpdateState();
    this.onLog(lines.join('\n'));
    this.onChange();
  }

  async updatePackage(name: string): Promise<void> {
    await this.applyUpdates(this.updates.filter(u => u.pkg.name === name), false);
  }

  async updateAll(): Promise<void> {
    await this.applyUpdates(this.updates.slice(), false);
  }

  private async applyUpdates(updates: UpdateInfo[], auto: boolean): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const lines = [auto ? 'Auto-updated installed plugins:' : 'Updated installed plugins:'];
    for (const u of updates) {
      try {
        applyUpdate(u, this.store, this.host.env);
        lines.push(`  ✓ ${u.pkg.name}  ${u.fromVersion} → ${u.toVersion}  (${whereLabel(u.record)})`);
      } catch (ex: any) {
        lines.push(`  ✗ ${u.pkg.name} (${whereLabel(u.record)}): ${ex.message}`);
      }
    }
    this.refreshUpdateState();
    this.onLog(lines.join('\n'));
    this.onChange();
  }

  /** Uninstalls the given items (or everything) of a package at the current destination. */
  async uninstall(pkgName: string, items: InstalledComponent[] | 'all'): Promise<void> {
    const rec = this.currentRecord(pkgName);
    if (!rec) {
      return;
    }
    const list = items === 'all' ? rec.components.slice() : items;
    const what = items === 'all' ? `all ${list.length} installed item(s) of '${pkgName}'` : list.length === 1 ? `'${list[0].name}'` : `${list.length} items`;
    if (!(await this.host.confirm(`Uninstall ${what} from ${whereLabel(rec)}?`, 'The installed files are deleted; local edits to them are lost.'))) {
      return;
    }
    try {
      const res = uninstall(rec, list, this.host.env);
      this.store.removeComponents(keyOf(rec), res.removedComponents);
      const lines = [`Uninstalled ${res.removedComponents.length} item(s) of '${rec.packageName}' from ${whereLabel(rec)}:`];
      res.removed.forEach(s => lines.push('  - ' + s));
      res.skipped.forEach(s => lines.push('  ! could not remove ' + s));
      this.onLog(lines.join('\n'));
    } catch (ex: any) {
      this.onLog('Uninstall failed: ' + ex.message);
    }
    this.refreshUpdateState();
    this.onChange();
  }

  /** Background check used at startup: never opens a sign-in prompt. */
  async runBackgroundUpdate(): Promise<string[]> {
    if (!this.settings.autoUpdate) {
      return [];
    }
    return runAutoUpdate(this.settings, this.store, this.host.env, async src => ({
      cacheRoot: path.join(this.host.dataRoot, 'cache'),
      authHeader: await this.host.authHeader(src, false),
      interactive: false,
    }));
  }

  getPreview(pkgName: string, kind: string, name: string): string {
    const p = this.packages.find(x => x.name === pkgName);
    const c = p?.components.find(x => x.kind === kind && x.name === name);
    return c ? (c.preview || c.description) : '';
  }

  getHomepage(pkgName: string): string {
    return this.packages.find(p => p.name === pkgName)?.homepage ?? '';
  }

  // ───────── view state ─────────

  async viewState(): Promise<ViewState> {
    const records = this.store.load();
    const repo = this.settings.scope === 'repo' ? this.getRepoRoot() : undefined;
    const hereKey = (p: string) => recordKey(this.packagesSourceId, p, this.settings.scope, repo, this.settings.layout);
    const sources = [];
    for (const s of this.settings.sources) {
      let hasToken = this.tokenFlags.get(s.id);
      if (hasToken === undefined) {
        hasToken = s.auth === 'pat' ? await this.sourceHasToken(s.id) : false;
        this.tokenFlags.set(s.id, hasToken);
      }
      sources.push({ ...s, hasToken });
    }

    const packages: ViewPackage[] = this.packages.map(p => {
      const here = (this.settings.scope === 'repo' && !repo) ? undefined : records.find(r => keyOf(r) === hereKey(p.name));
      const comps = [...p.components].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind));
      return {
        name: p.name, version: p.version, description: p.description, author: p.author, license: p.license, homepage: p.homepage,
        keywords: p.keywords, warnings: p.warnings, summary: summarize(p),
        installedSummary: p.installedSummary ?? '', hasUpdate: p.hasUpdate === true, updateText: p.updateText ?? '',
        installedHere: here ? { where: whereLabel(here), version: here.version, count: here.components.length } : undefined,
        components: comps.map(c => ({
          kind: c.kind, name: c.name, description: c.description, relativePath: c.relativePath, installable: c.installable,
          installedHere: !!here && here.components.some(ic => sameComponent(ic, c)),
        })),
      };
    });

    return {
      sources: sources as ViewState['sources'],
      currentSourceId: this.currentSource?.id ?? '',
      scope: this.settings.scope,
      layout: this.settings.layout,
      autoUpdate: this.settings.autoUpdate,
      repoAvailable: !!this.getRepoRoot(),
      busy: this.busy,
      status: this.status,
      destination: this.destinationLines(),
      updateCount: this.updates.length,
      packages,
    };
  }

  invalidateTokenFlag(id: string): void {
    this.tokenFlags.delete(id);
  }
}
