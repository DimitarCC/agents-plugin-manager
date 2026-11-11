import * as fs from 'fs';
import * as path from 'path';
import { parseFrontMatter } from './frontmatter';
import { exists, isDir, readJsonFile } from './fsutil';
import { PluginComponent, PluginPackage } from './types';

const MAX_DEPTH = 4;
const MAX_PREVIEW = 6000;

/**
 * Reads plugin packages laid out per https://agent-plugins.org (plugin.json, skills/<n>/SKILL.md, mcp.json)
 * plus the common non-standard agents/, prompts/ and commands/ folders.
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

function looksLikePlugin(dir: string): boolean {
  return ['skills', 'agents', 'prompts', 'commands'].some(d => isDir(path.join(dir, d))) || exists(path.join(dir, 'mcp.json'));
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

  loadSkills(pkg, dir);
  loadMarkdownFolder(pkg, dir, 'agents', 'agent');
  loadMarkdownFolder(pkg, dir, 'prompts', 'prompt');
  loadMarkdownFolder(pkg, dir, 'commands', 'prompt');
  loadMcp(pkg, dir);
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

function loadSkills(pkg: PluginPackage, dir: string): void {
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
    pkg.components.push({
      kind: 'skill', name: folder, description: fm['description'] ?? '', relativePath: 'skills/' + folder,
      isDirectory: true, installable: true, preview,
    });
  }
}

function loadMarkdownFolder(pkg: PluginPackage, dir: string, folder: string, kind: 'agent' | 'prompt'): void {
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
    if (/\.(agent|prompt)$/i.test(name)) {
      name = name.replace(/\.(agent|prompt)$/i, '');
    }
    pkg.components.push({
      kind, name, description: fm['description'] ?? '', relativePath: folder + '/' + f, isDirectory: false, installable: true, preview: clip(text),
    });
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
    pkg.components.push({
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
      pkg.components.push({
        kind: 'hook', name: n.toLowerCase() === 'hooks' ? 'hooks' : n + '/hooks',
        description: 'Client-specific hook definitions; not supported by the installer.',
        relativePath: n, isDirectory: true, installable: false, preview: '',
      });
    }
  }
}

export function kindOrder(k: PluginComponent['kind']): number {
  return ['skill', 'mcp', 'agent', 'prompt', 'hook'].indexOf(k);
}
