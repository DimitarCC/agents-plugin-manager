import * as fs from 'fs';
import * as path from 'path';
import { parseFrontMatter } from './frontmatter';
import { exists, isDir, readJsonFile } from './fsutil';
import { ClientId, ComponentKind, PluginComponent, PluginPackage } from './types';

const MAX_DEPTH = 4;
const MAX_PREVIEW = 6000;

/**
 * Reads plugin packages laid out per https://agent-plugins.org (plugin.json, skills/<n>/SKILL.md, mcp.json), plus the
 * common non-standard agents/, prompts/, commands/ and rules/ folders, and client namespace folders such as
 * com.github.copilot/ or com.anthropic.claude/ (the spec leaves their content to each client).
 */
export function discover(sourceRoot: string): PluginPackage[] {
  const result: PluginPackage[] = [];
  for (const dir of findPluginRoots(sourceRoot, 0)) {
    try {
      result.push(load(dir));
    } catch (ex: any) {
      result.push({
        name: path.basename(dir), version: '', description: 'Invalid plugin: ' + ex.message, author: '', homepage: '', license: '',
        keywords: [], rootPath: dir, hasManifest: false, components: [], warnings: [String(ex.message)],
      });
    }
  }
  if (result.length === 0 && looksLikePlugin(sourceRoot)) {
    const p = load(sourceRoot);
    p.warnings.push('No plugin.json found; treated the folder as an unmanifested plugin.');
    result.push(p);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function* findPluginRoots(dir: string, depth: number): Generator<string> {
  if (manifestPath(dir)) {
    yield dir;
    return;
  }
  if (depth >= MAX_DEPTH) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') {
      continue;
    }
    yield* findPluginRoots(path.join(dir, e.name), depth + 1);
  }
}

function manifestPath(dir: string): string | undefined {
  const a = path.join(dir, 'plugin.json');
  if (exists(a)) {
    return a;
  }
  const b = path.join(dir, '.claude-plugin', 'plugin.json');
  return exists(b) ? b : undefined;
}

/** A namespace folder is a top-level folder named like a reverse domain: com.github.copilot, com.example.client, … */
function isNamespaceDir(name: string): boolean {
  return !name.startsWith('.') && name.indexOf('.') > 0 && name !== 'node_modules';
}

function clientOf(namespace: string): ClientId | undefined {
  const n = namespace.toLowerCase();
  if (n.includes('copilot')) { return 'copilot'; }
  if (n.includes('claude') || n.includes('anthropic')) { return 'claude'; }
  return undefined;
}

function looksLikePlugin(dir: string): boolean {
  if (['skills', 'agents', 'prompts', 'commands', 'rules', 'instructions'].some(d => isDir(path.join(dir, d))) || exists(path.join(dir, 'mcp.json'))) {
    return true;
  }
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(e => e.isDirectory() && isNamespaceDir(e.name) && clientOf(e.name) !== undefined);
  } catch {
    return false;
  }
}

export function load(dir: string): PluginPackage {
  const pkg: PluginPackage = {
    name: path.basename(dir.replace(/[\\/]+$/, '')), version: '', description: '', author: '', homepage: '', license: '',
    keywords: [], rootPath: dir, hasManifest: false, components: [], warnings: [],
  };
  const manifest = manifestPath(dir);
  pkg.hasManifest = manifest !== undefined;
  if (manifest) {
    const j = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^﻿/, ''));
    pkg.name = typeof j.name === 'string' ? j.name : pkg.name;
    pkg.version = typeof j.version === 'string' ? j.version : '';
    pkg.description = typeof j.description === 'string' ? j.description : '';
    pkg.homepage = typeof j.homepage === 'string' ? j.homepage : typeof j.repository === 'string' ? j.repository : '';
    pkg.license = typeof j.license === 'string' ? j.license : '';
    pkg.author = typeof j.author === 'string' ? j.author : typeof j.author?.name === 'string' ? j.author.name : '';
    if (Array.isArray(j.keywords)) {
      pkg.keywords = j.keywords.filter((k: unknown) => typeof k === 'string');
    }
    if (j.$schema === undefined) {
      pkg.warnings.push('plugin.json has no $schema (required by the Agent Plugins v1 spec).');
    }
  }

  // Portable, top-level folders
  loadSkills(pkg, dir);
  loadMarkdownFolder(pkg, dir, 'agents', 'agent');
  loadMarkdownFolder(pkg, dir, 'prompts', 'prompt');
  loadMarkdownFolder(pkg, dir, 'commands', 'prompt');
  loadMarkdownFolder(pkg, dir, 'rules', 'rule');
  loadMarkdownFolder(pkg, dir, 'instructions', 'rule');
  loadMcp(pkg, dir);
  // Client namespace folders (com.github.copilot/, com.anthropic.claude/, …)
  loadNamespaces(pkg, dir);
  loadHooks(pkg, dir);
  return pkg;
}

function clip(text: string): string {
  return text.length > MAX_PREVIEW ? text.substring(0, MAX_PREVIEW) + '\n…' : text;
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

function sortedDirs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** Where an item came from: the portable top-level folders, or a client namespace folder. */
interface Origin {
  prefix: string;
  namespace?: string;
  client?: ClientId;
  /** False for a namespace of a client this tool doesn't know how to install for. */
  installable: boolean;
}

const PORTABLE: Origin = { prefix: '', installable: true };

function add(pkg: PluginPackage, c: PluginComponent): void {
  if (pkg.components.some(x => x.kind === c.kind && x.name === c.name)) {
    pkg.warnings.push(`${c.kind} "${c.name}" exists more than once (${c.relativePath}); only the first is listed.`);
    return;
  }
  pkg.components.push(c);
}

function loadSkills(pkg: PluginPackage, dir: string, origin: Origin = PORTABLE): void {
  const skills = path.join(dir, 'skills');
  if (!isDir(skills)) {
    return;
  }
  for (const folder of sortedDirs(skills)) {
    const sd = path.join(skills, folder);
    const md = path.join(sd, 'SKILL.md');
    if (!exists(md)) {
      continue;
    }
    const text = readText(md);
    const fm = parseFrontMatter(text);
    const extras = ['scripts', 'references', 'assets'].filter(s => isDir(path.join(sd, s))).map(s => s + '/');
    let preview = clip(text);
    if (extras.length > 0) {
      preview = '[bundled: ' + extras.join(', ') + ']\n\n' + preview;
    }
    add(pkg, {
      kind: 'skill', name: folder, description: fm['description'] ?? '', relativePath: origin.prefix + 'skills/' + folder,
      isDirectory: true, installable: origin.installable, preview, client: origin.client, namespace: origin.namespace,
    });
  }
}

function loadMarkdownFolder(pkg: PluginPackage, dir: string, folder: string, kind: 'agent' | 'prompt' | 'rule', origin: Origin = PORTABLE): void {
  const d = path.join(dir, folder);
  if (!isDir(d)) {
    return;
  }
  const files = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md')).map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const f of files) {
    const text = readText(path.join(d, f));
    const fm = parseFrontMatter(text);
    let name = f.replace(/\.md$/i, '');
    if (/\.(agent|prompt|instructions)$/i.test(name)) {
      name = name.replace(/\.(agent|prompt|instructions)$/i, '');
    }
    add(pkg, {
      kind, name, description: fm['description'] ?? '', relativePath: origin.prefix + folder + '/' + f, isDirectory: false,
      installable: origin.installable, preview: clip(text), client: origin.client, namespace: origin.namespace,
    });
  }
}

/** Items in client namespace folders, e.g. com.github.copilot/agents and com.github.copilot/rules. */
function loadNamespaces(pkg: PluginPackage, dir: string): void {
  for (const ns of sortedDirs(dir).filter(isNamespaceDir)) {
    const client = clientOf(ns);
    const origin: Origin = { prefix: ns + '/', namespace: ns, client, installable: client !== undefined };
    const nsDir = path.join(dir, ns);
    const before = pkg.components.length;
    loadSkills(pkg, nsDir, origin);
    loadMarkdownFolder(pkg, nsDir, 'agents', 'agent', origin);
    loadMarkdownFolder(pkg, nsDir, 'prompts', 'prompt', origin);
    loadMarkdownFolder(pkg, nsDir, 'commands', 'prompt', origin);
    loadMarkdownFolder(pkg, nsDir, 'rules', 'rule', origin);
    loadMarkdownFolder(pkg, nsDir, 'instructions', 'rule', origin);
    if (client === undefined && pkg.components.length > before) {
      pkg.warnings.push(`${ns}: client not recognised; its items are listed but can't be installed.`);
    }
  }
}

function loadMcp(pkg: PluginPackage, dir: string): void {
  const file = ['mcp.json', '.mcp.json'].map(n => path.join(dir, n)).find(exists);
  if (!file) {
    return;
  }
  const root = readJsonFile<any>(file);
  if (!root) {
    pkg.warnings.push('mcp.json is invalid or not valid JSON.');
    return;
  }
  const servers = root.mcpServers ?? root.servers;
  if (!servers || typeof servers !== 'object') {
    return;
  }
  for (const [name, def] of Object.entries<any>(servers)) {
    if (!def || typeof def !== 'object') {
      continue;
    }
    const type: string = def.type ?? (def.url ? 'http' : 'stdio');
    const desc = type === 'stdio'
      ? `stdio: ${def.command ?? ''} ${Array.isArray(def.args) ? def.args.join(' ') : ''}`.trim()
      : `${type}: ${def.url ?? ''}`;
    const shown = JSON.parse(JSON.stringify(def));
    if (shown.env && typeof shown.env === 'object') {
      for (const k of Object.keys(shown.env)) {
        shown.env[k] = '…'; // never preview secrets
      }
    }
    add(pkg, {
      kind: 'mcp', name, description: desc, relativePath: path.basename(file), isDirectory: false, installable: true,
      preview: JSON.stringify(shown, null, 2), mcp: JSON.parse(JSON.stringify(def)),
    });
  }
}

function loadHooks(pkg: PluginPackage, dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      continue;
    }
    const n = e.name;
    const hasHooks = isDir(path.join(dir, n, 'hooks'));
    if (n.toLowerCase() === 'hooks' || (n.indexOf('.') > 0 && hasHooks)) {
      add(pkg, {
        kind: 'hook', name: n.toLowerCase() === 'hooks' ? 'hooks' : n + '/hooks',
        description: 'Client-specific hook definitions; not supported by the installer.',
        relativePath: n, isDirectory: true, installable: false, preview: '',
      });
    }
  }
}

/** Display order of the groups in the UI. */
export function kindOrder(k: ComponentKind): number {
  return ['skill', 'mcp', 'agent', 'prompt', 'rule', 'hook'].indexOf(k);
}
