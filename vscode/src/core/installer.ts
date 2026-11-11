import * as fs from 'fs';
import * as path from 'path';
import { copyTree, ensureDir, exists, forceDelete, readJsonFile, safeName, writeJsonFile } from './fsutil';
import { contentBlock } from './hash';
import {
  ClientLayout, InstallRecord, InstallScope, InstalledComponent, PluginComponent, PluginPackage,
} from './types';

/** Machine specific locations the layouts are resolved against. */
export interface InstallEnv {
  /** The user's home folder. */
  home: string;
  /** VS Code's "User" settings folder (holds mcp.json and the prompts folder). */
  userDir: string;
  /** Where plugin files are copied for MCP servers installed at user scope. */
  userPayloadRoot: string;
}

export interface InstallLayout {
  skillsDir?: string;
  agentsDir?: string;
  promptsDir?: string;
  mcpFile?: string;
  /** JSON property that holds the servers map ("mcpServers" or "servers"). */
  mcpSection: 'mcpServers' | 'servers';
  agentSuffix: string;
  promptSuffix: string;
  payloadRoot: string;
}

export function resolveLayout(scope: InstallScope, layout: ClientLayout, repoRoot: string | undefined, env: InstallEnv): InstallLayout {
  const user = scope === 'user';
  const base = user ? env.home : repoRoot ?? '';
  const l: InstallLayout = { mcpSection: 'mcpServers', agentSuffix: '.md', promptSuffix: '.md', payloadRoot: '' };
  switch (layout) {
    case 'claude':
      l.skillsDir = path.join(base, '.claude', 'skills');
      l.agentsDir = path.join(base, '.claude', 'agents');
      l.promptsDir = path.join(base, '.claude', 'commands');
      l.mcpFile = path.join(base, user ? '.claude.json' : '.mcp.json');
      l.mcpSection = 'mcpServers';
      break;
    case 'copilot':
      l.agentSuffix = '.agent.md';
      l.promptSuffix = '.prompt.md';
      l.mcpSection = 'servers';
      if (user) {
        // VS Code reads user-level prompt files, custom agents and MCP servers from the profile folder.
        l.skillsDir = path.join(env.home, '.copilot', 'skills');
        l.agentsDir = path.join(env.userDir, 'prompts');
        l.promptsDir = path.join(env.userDir, 'prompts');
        l.mcpFile = path.join(env.userDir, 'mcp.json');
      } else {
        l.skillsDir = path.join(base, '.github', 'skills');
        l.agentsDir = path.join(base, '.github', 'agents');
        l.promptsDir = path.join(base, '.github', 'prompts');
        l.mcpFile = path.join(base, '.vscode', 'mcp.json');
      }
      break;
    default:
      l.skillsDir = path.join(base, '.agents', 'skills');
      break;
  }
  l.payloadRoot = user ? env.userPayloadRoot : path.join(base, '.agents', 'plugins');
  return l;
}

export interface InstallRequest {
  pkg: PluginPackage;
  components: PluginComponent[];
  scope: InstallScope;
  layout: ClientLayout;
  repoRoot?: string;
  overwrite: boolean;
  env: InstallEnv;
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
  /** Components that were actually written (not skipped). */
  installedComponents: PluginComponent[];
}

export function install(req: InstallRequest): InstallResult {
  if (req.scope === 'repo' && !req.repoRoot) {
    throw new Error('No repository is open.');
  }
  const layout = resolveLayout(req.scope, req.layout, req.repoRoot, req.env);
  const res: InstallResult = { installed: [], skipped: [], installedComponents: [] };
  const mcp: PluginComponent[] = [];

  for (const c of req.components.filter(c => c.installable)) {
    switch (c.kind) {
      case 'skill':
        copyDirectoryComponent(req.pkg, c, layout.skillsDir, req.overwrite, res);
        break;
      case 'agent':
        copyFileComponent(req.pkg, c, layout.agentsDir, layout.agentSuffix, req.overwrite, res);
        break;
      case 'prompt':
        copyFileComponent(req.pkg, c, layout.promptsDir, layout.promptSuffix, req.overwrite, res);
        break;
      case 'mcp':
        mcp.push(c);
        break;
    }
  }
  if (mcp.length > 0) {
    installMcp(req, mcp, layout, res);
  }
  return res;
}

function copyDirectoryComponent(pkg: PluginPackage, c: PluginComponent, root: string | undefined, overwrite: boolean, res: InstallResult): void {
  if (!root) {
    res.skipped.push(`${c.name}: skills aren't supported by this client layout`);
    return;
  }
  const src = path.join(pkg.rootPath, ...c.relativePath.split('/'));
  const target = path.join(root, safeName(c.name));
  if (exists(target)) {
    if (!overwrite) {
      skipExisting(c, src, target, true, res);
      return;
    }
    forceDelete(target);
  }
  copyTree(src, target);
  res.installed.push(`skill ${c.name} → ${target}`);
  res.installedComponents.push(c);
}

function copyFileComponent(pkg: PluginPackage, c: PluginComponent, dir: string | undefined, suffix: string, overwrite: boolean, res: InstallResult): void {
  if (!dir) {
    res.skipped.push(`${c.name}: ${c.kind}s aren't supported by this client layout`);
    return;
  }
  const src = path.join(pkg.rootPath, ...c.relativePath.split('/'));
  const target = path.join(dir, safeName(c.name) + suffix);
  if (exists(target) && !overwrite) {
    skipExisting(c, src, target, false, res);
    return;
  }
  ensureDir(dir);
  fs.copyFileSync(src, target);
  res.installed.push(`${c.kind} ${c.name} → ${target}`);
  res.installedComponents.push(c);
}

/** An item is already there: if it is identical to this package's version, just start tracking it; otherwise skip. */
function skipExisting(c: PluginComponent, src: string, target: string, isDir: boolean, res: InstallResult): void {
  if (contentBlock(src, isDir) === contentBlock(target, isDir)) {
    res.installed.push(`${c.kind} ${c.name}: already up to date, now tracked (${target})`);
    res.installedComponents.push(c);
  } else {
    res.skipped.push(`${c.name}: already exists and differs from this version (${target}); tick "Overwrite existing" to replace it`);
  }
}

/** Where a component is installed for a layout, or undefined when the layout doesn't support its kind. */
export function targetPath(layout: InstallLayout, c: { kind: string; name: string }): string | undefined {
  switch (c.kind) {
    case 'skill': return layout.skillsDir ? path.join(layout.skillsDir, safeName(c.name)) : undefined;
    case 'agent': return layout.agentsDir ? path.join(layout.agentsDir, safeName(c.name) + layout.agentSuffix) : undefined;
    case 'prompt': return layout.promptsDir ? path.join(layout.promptsDir, safeName(c.name) + layout.promptSuffix) : undefined;
    default: return undefined;
  }
}

/** '' = not there; same / differs = present with identical / different content; present = MCP server (not comparable). */
export type Presence = '' | 'same' | 'differs' | 'present';

export function presenceOf(pkg: PluginPackage, c: PluginComponent, scope: InstallScope, layout: ClientLayout, repoRoot: string | undefined, env: InstallEnv): Presence {
  if (!c.installable || (scope === 'repo' && !repoRoot)) {
    return '';
  }
  const l = resolveLayout(scope, layout, repoRoot, env);
  if (c.kind === 'mcp') {
    if (!l.mcpFile || !exists(l.mcpFile)) {
      return '';
    }
    const section = readJsonFile<any>(l.mcpFile)?.[l.mcpSection];
    return section && typeof section === 'object' && c.name in section ? 'present' : '';
  }
  const target = targetPath(l, c);
  if (!target || !exists(target)) {
    return '';
  }
  const src = path.join(pkg.rootPath, ...c.relativePath.split('/'));
  return contentBlock(src, c.isDirectory) === contentBlock(target, c.isDirectory) ? 'same' : 'differs';
}

function installMcp(req: InstallRequest, servers: PluginComponent[], layout: InstallLayout, res: InstallResult): void {
  if (!layout.mcpFile) {
    for (const s of servers) {
      res.skipped.push(`${s.name}: MCP servers aren't supported by this client layout`);
    }
    return;
  }

  let doc: any = {};
  if (exists(layout.mcpFile)) {
    const parsed = readJsonFile<any>(layout.mcpFile);
    if (!parsed || typeof parsed !== 'object') {
      for (const s of servers) {
        res.skipped.push(`${s.name}: cannot parse existing ${layout.mcpFile} (comments or invalid JSON); left untouched`);
      }
      return;
    }
    doc = parsed;
  }
  if (!doc[layout.mcpSection] || typeof doc[layout.mcpSection] !== 'object') {
    doc[layout.mcpSection] = {};
  }
  const section = doc[layout.mcpSection];

  let pluginRoot: string | undefined;
  let pluginData: string | undefined;
  let changed = false;
  for (const s of servers) {
    const def = JSON.parse(JSON.stringify(s.mcp ?? {}));
    if (section[s.name] !== undefined && !req.overwrite) {
      res.skipped.push(`${s.name}: MCP server already configured`);
      continue;
    }
    // Servers that reference plugin files (./cmd, ${PLUGIN_ROOT}) need the plugin payload on disk.
    if (needsPayload(def)) {
      if (!pluginRoot) {
        pluginRoot = path.join(layout.payloadRoot, safeName(req.pkg.name));
        pluginData = pluginRoot + '-data';
        if (exists(pluginRoot)) {
          forceDelete(pluginRoot);
        }
        copyTree(req.pkg.rootPath, pluginRoot);
        ensureDir(pluginData);
      }
      expand(def, pluginRoot, pluginData!);
    }
    section[s.name] = toClientFormat(def);
    changed = true;
    res.installed.push(`MCP server ${s.name} → ${layout.mcpFile}`);
    res.installedComponents.push(s);
  }

  if (changed) {
    ensureDir(path.dirname(layout.mcpFile));
    if (exists(layout.mcpFile)) {
      fs.copyFileSync(layout.mcpFile, layout.mcpFile + '.bak');
    }
    writeJsonFile(layout.mcpFile, doc);
  }
}

function needsPayload(def: any): boolean {
  const text = JSON.stringify(def);
  if (text.includes('${PLUGIN_ROOT}') || text.includes('${PLUGIN_DATA}')) {
    return true;
  }
  return typeof def.command === 'string' && (def.command.startsWith('./') || def.command.startsWith('.\\'));
}

/** Applies the spec's ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion and resolves plugin-relative paths. */
function expand(def: any, root: string, data: string): void {
  const sub = (s: string) => s.split('${PLUGIN_ROOT}').join(root).split('${PLUGIN_DATA}').join(data);
  if (Array.isArray(def.args)) {
    def.args = def.args.map((a: unknown) => sub(String(a ?? '')));
  }
  if (def.env && typeof def.env === 'object') {
    for (const k of Object.keys(def.env)) {
      def.env[k] = sub(String(def.env[k] ?? ''));
    }
  }
  if (typeof def.command === 'string' && (def.command.startsWith('./') || def.command.startsWith('.\\'))) {
    def.command = path.resolve(root, def.command.substring(2));
  }
  if (typeof def.cwd !== 'string') {
    def.cwd = root;
  } else if (def.cwd.startsWith('./') || def.cwd.startsWith('.\\')) {
    def.cwd = path.resolve(root, def.cwd.substring(2));
  } else {
    def.cwd = sub(def.cwd);
  }
}

function toClientFormat(def: any): any {
  const o = JSON.parse(JSON.stringify(def));
  if (o.type === 'streamable-http') {
    o.type = 'http';
  } else if (o.type === undefined) {
    o.type = o.url ? 'http' : 'stdio';
  }
  return o;
}

// ───────── uninstall ─────────

export interface UninstallResult {
  removed: string[];
  skipped: string[];
  removedComponents: InstalledComponent[];
}

/** Deletes previously installed items of a record from its destination. */
export function uninstall(rec: InstallRecord, items: InstalledComponent[], env: InstallEnv): UninstallResult {
  const res: UninstallResult = { removed: [], skipped: [], removedComponents: [] };
  const layout = resolveLayout(rec.scope, rec.layout, rec.repoRoot, env);

  for (const item of items.filter(i => i.kind !== 'mcp')) {
    let target: string | undefined;
    if (item.kind === 'skill' && layout.skillsDir) {
      target = path.join(layout.skillsDir, safeName(item.name));
    } else if (item.kind === 'agent' && layout.agentsDir) {
      target = path.join(layout.agentsDir, safeName(item.name) + layout.agentSuffix);
    } else if (item.kind === 'prompt' && layout.promptsDir) {
      target = path.join(layout.promptsDir, safeName(item.name) + layout.promptSuffix);
    }
    if (!target) {
      res.skipped.push(`${item.name}: not supported by this client layout`);
      continue;
    }
    try {
      if (exists(target)) {
        forceDelete(target);
        res.removed.push(`${item.kind} ${item.name} ← ${target}`);
      } else {
        res.removed.push(`${item.kind} ${item.name}: already gone`);
      }
      res.removedComponents.push(item);
    } catch (ex: any) {
      res.skipped.push(`${item.name}: ${ex.message}`);
    }
  }

  const mcp = items.filter(i => i.kind === 'mcp');
  if (mcp.length > 0 && layout.mcpFile) {
    try {
      if (exists(layout.mcpFile)) {
        const doc = readJsonFile<any>(layout.mcpFile);
        if (!doc) {
          throw new Error('invalid JSON');
        }
        const section = doc[layout.mcpSection];
        let changed = false;
        for (const m of mcp) {
          if (section && typeof section === 'object' && m.name in section) {
            delete section[m.name];
            changed = true;
            res.removed.push(`MCP server ${m.name} ← ${layout.mcpFile}`);
          } else {
            res.removed.push(`MCP server ${m.name}: already gone`);
          }
          res.removedComponents.push(m);
        }
        if (changed) {
          fs.copyFileSync(layout.mcpFile, layout.mcpFile + '.bak');
          writeJsonFile(layout.mcpFile, doc);
        }
      } else {
        for (const m of mcp) {
          res.removed.push(`MCP server ${m.name}: already gone`);
          res.removedComponents.push(m);
        }
      }
    } catch (ex: any) {
      for (const m of mcp) {
        res.skipped.push(`${m.name}: cannot edit ${layout.mcpFile} (${ex.message})`);
      }
    }
  } else if (mcp.length > 0) {
    for (const m of mcp) {
      res.skipped.push(`${m.name}: not supported by this client layout`);
    }
  }

  // Once no MCP server of the package remains, drop the copied plugin payload (the -data folder is kept).
  const remaining = rec.components.filter(c => c.kind === 'mcp').length - res.removedComponents.filter(c => c.kind === 'mcp').length;
  if (mcp.length > 0 && remaining <= 0) {
    const payload = path.join(layout.payloadRoot, safeName(rec.packageName));
    try {
      if (exists(payload)) {
        forceDelete(payload);
        res.removed.push('plugin files ← ' + payload);
      }
    } catch (ex: any) {
      res.skipped.push('plugin files: ' + ex.message);
    }
  }
  return res;
}

/** Walks up from a folder to the nearest directory containing .git. */
export function findRepoRoot(start: string | undefined): string | undefined {
  let d = start;
  while (d) {
    if (exists(path.join(d, '.git'))) {
      return d;
    }
    const parent = path.dirname(d);
    if (parent === d) {
      break;
    }
    d = parent;
  }
  return start;
}
