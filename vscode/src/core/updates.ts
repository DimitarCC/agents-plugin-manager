import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, exists, readJsonFile, writeJsonFile } from './fsutil';
import { SyncContext, syncSource } from './git';
import { InstallEnv, InstallResult, install } from './installer';
import { discover } from './scanner';
import {
  ComponentKind, InstallRecord, InstallScope, InstalledComponent, PluginComponent, PluginPackage, PluginSource, Settings,
  ClientLayout, keyOf, recordKey, sameComponent, whereLabel,
} from './types';

export interface UpdateInfo {
  record: InstallRecord;
  pkg: PluginPackage;
  /** Components of the new package version that correspond to what is installed. */
  components: PluginComponent[];
  fromVersion: string;
  toVersion: string;
}

/** Persists which packages were installed where, so updates can be detected and re-applied. */
export class RecordStore {
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'installed.json');
  }

  load(): InstallRecord[] {
    const v = readJsonFile<InstallRecord[]>(this.file);
    return Array.isArray(v) ? v : [];
  }

  private save(all: InstallRecord[]): void {
    ensureDir(path.dirname(this.file));
    writeJsonFile(this.file, all);
  }

  upsert(record: InstallRecord): void {
    const all = this.load().filter(r => keyOf(r) !== keyOf(record));
    all.push(record);
    this.save(all);
  }

  /** Forgets removed items; deletes the whole record when nothing is left. */
  removeComponents(key: string, removed: InstalledComponent[]): void {
    const all = this.load();
    const rec = all.find(r => keyOf(r) === key);
    if (!rec) {
      return;
    }
    rec.components = rec.components.filter(c => !removed.some(g => sameComponent(g, c)));
    this.save(rec.components.length === 0 ? all.filter(r => keyOf(r) !== key) : all);
  }
}

// ───────── detection ─────────

function parseVersion(s: string): number[] | undefined {
  const m = /^v?(\d+(?:\.\d+){0,3})/.exec(s ?? '');
  return m ? m[1].split('.').map(Number) : undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

export function isUpdateAvailable(installedVersion: string, installedFingerprint: string, available: Pick<PluginPackage, 'version'>, availableFingerprint: string): boolean {
  const a = available.version ?? '';
  const i = installedVersion ?? '';
  if (a.length > 0) {
    const av = parseVersion(a);
    const iv = parseVersion(i);
    if (av && iv) {
      return compareVersions(av, iv) > 0;
    }
    return a.toLowerCase() !== i.toLowerCase();
  }
  // Unversioned package: fall back to content comparison.
  return i.length === 0 && installedFingerprint.length > 0 && installedFingerprint !== availableFingerprint;
}

function matching(pkg: PluginPackage, r: InstallRecord): PluginComponent[] {
  return pkg.components.filter(c => c.installable && r.components.some(ic => sameComponent(ic, c)));
}

/** Finds updates for installed records belonging to the given source. */
export function findUpdates(packages: PluginPackage[], sourceId: string, records: InstallRecord[]): UpdateInfo[] {
  const result: UpdateInfo[] = [];
  const byName = new Map<string, PluginPackage>();
  for (const p of packages) {
    if (!byName.has(p.name.toLowerCase())) {
      byName.set(p.name.toLowerCase(), p);
    }
  }
  for (const r of records.filter(r => r.sourceId === sourceId)) {
    const pkg = byName.get(r.packageName.toLowerCase());
    if (!pkg) {
      continue;
    }
    const comps = matching(pkg, r);
    if (comps.length === 0) {
      continue;
    }
    if (isUpdateAvailable(r.version, r.fingerprint, pkg, fingerprint(pkg, comps))) {
      result.push({
        record: r, pkg, components: comps,
        fromVersion: r.version ? 'v' + r.version : 'unversioned',
        toVersion: pkg.version ? 'v' + pkg.version : 'new content',
      });
    }
  }
  return result;
}

/** Applies per-package install state (installed / update available) used by the UI. */
export function annotate(packages: PluginPackage[], sourceId: string, records: InstallRecord[]): UpdateInfo[] {
  const recs = records.filter(r => r.sourceId === sourceId);
  const updates = findUpdates(packages, sourceId, recs);
  for (const p of packages) {
    const mine = recs.filter(r => r.packageName.toLowerCase() === p.name.toLowerCase());
    if (mine.length === 0) {
      p.installedSummary = '';
      p.hasUpdate = false;
      p.updateText = '';
      continue;
    }
    p.installedSummary = 'Installed ' + mine.map(r => (r.version ? 'v' + r.version + ' ' : '') + '(' + whereLabel(r) + ')').join(', ');
    const ups = updates.filter(u => u.pkg === p);
    p.hasUpdate = ups.length > 0;
    p.updateText = ups.length === 0 ? '' : ups[0].fromVersion + ' → ' + ups[0].toVersion;
  }
  return updates;
}

// ───────── applying ─────────

export function applyUpdate(u: UpdateInfo, store: RecordStore, env: InstallEnv): InstallResult {
  const r = u.record;
  if (r.scope === 'repo' && (!r.repoRoot || !fs.existsSync(r.repoRoot))) {
    throw new Error('Repository not found: ' + r.repoRoot);
  }
  const res = install({ pkg: u.pkg, components: u.components, scope: r.scope, layout: r.layout, repoRoot: r.repoRoot, overwrite: true, env });
  recordInstall(store, u.pkg, r.sourceId, r.scope, r.repoRoot, r.layout, res.installedComponents, true);
  return res;
}

/** Remembers an install. Merges with earlier installs of the same package/target unless replacing. */
export function recordInstall(
  store: RecordStore, pkg: PluginPackage, sourceId: string, scope: InstallScope, repoRoot: string | undefined,
  layout: ClientLayout, installed: PluginComponent[], replace = false,
): void {
  const key = recordKey(sourceId, pkg.name, scope, repoRoot, layout);
  const existing = store.load().find(r => keyOf(r) === key);
  const items: InstalledComponent[] = existing && !replace ? [...existing.components] : [];
  for (const c of installed) {
    if (!items.some(i => sameComponent(i, c))) {
      items.push({ kind: c.kind as ComponentKind, name: c.name });
    }
  }
  if (items.length === 0) {
    return;
  }
  const rec: InstallRecord = {
    packageName: pkg.name, sourceId, scope, repoRoot: scope === 'repo' ? repoRoot : undefined, layout,
    components: items, version: pkg.version ?? '', fingerprint: '', installedUtc: new Date().toISOString(),
  };
  rec.fingerprint = fingerprint(pkg, matching(pkg, rec));
  store.upsert(rec);
}

// ───────── fingerprint ─────────

export function fingerprint(pkg: PluginPackage, components: PluginComponent[]): string {
  const sha = crypto.createHash('sha1');
  const order = ['skill', 'mcp', 'agent', 'prompt', 'hook'];
  const sorted = [...components].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
  for (const c of sorted) {
    sha.update(`${c.kind}:${c.name}\n`);
    if (c.kind === 'mcp') {
      sha.update(JSON.stringify(c.mcp ?? {}) + '\n');
      continue;
    }
    const p = path.join(pkg.rootPath, ...c.relativePath.split('/'));
    const files = c.isDirectory && exists(p) ? listFiles(p) : exists(p) ? [p] : [];
    for (const f of files) {
      // normalise line endings so CRLF/LF checkouts hash the same
      const bytes = fs.readFileSync(f).filter(b => b !== 13);
      sha.update(f.substring(p.length).replace(/\\/g, '/') + ':');
      sha.update(crypto.createHash('sha1').update(bytes).digest('base64') + '\n');
    }
  }
  return sha.digest('base64');
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listFiles(p));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

// ───────── background run ─────────

/** Checks every source that has installed packages and applies available updates without prompting. */
export async function runAutoUpdate(
  settings: Settings, store: RecordStore, env: InstallEnv,
  ctxFor: (source: PluginSource) => Promise<SyncContext>,
): Promise<string[]> {
  const log: string[] = [];
  const records = store.load();
  for (const src of settings.sources.filter(s => records.some(r => r.sourceId === s.id))) {
    try {
      const root = await syncSource(src, await ctxFor(src));
      const pkgs = discover(root);
      for (const u of findUpdates(pkgs, src.id, store.load())) {
        try {
          applyUpdate(u, store, env);
          log.push(`${u.pkg.name} ${u.fromVersion} → ${u.toVersion}`);
        } catch (ex: any) {
          log.push(`${u.pkg.name}: update failed — ${ex.message}`);
        }
      }
    } catch {
      /* offline or sign-in required: try again next time */
    }
  }
  return log;
}
