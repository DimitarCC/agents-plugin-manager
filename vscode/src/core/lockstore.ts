import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, exists, readJsonFile } from './fsutil';
import { sourceKey } from './sourcekey';
import {
  ClientLayout, ComponentKind, InstallRecord, InstallScope, InstalledComponent, PluginSource, keyOf, sameComponent,
} from './types';

/**
 * Install records live in `<scope root>/.agents/plugin-lock.json` (see docs/plugin-lock.md):
 * `~/.agents` for user scope, `<repo>/.agents` for repository scope. Both editions read and write the same files.
 */
export class LockStore {
  constructor(private readonly home: string, private readonly dataRoot: string, private readonly toolName: string) { }

  lockPath(scope: InstallScope, repoRoot?: string): string {
    return path.join(scope === 'user' ? this.home : repoRoot ?? '', '.agents', 'plugin-lock.json');
  }

  // ───────── reading ─────────

  load(scope: InstallScope, repoRoot?: string): InstallRecord[] {
    if (scope === 'repo' && !repoRoot) {
      return [];
    }
    const doc = readJsonFile<any>(this.lockPath(scope, repoRoot));
    if (!doc || !Array.isArray(doc.installs)) {
      return [];
    }
    const out: InstallRecord[] = [];
    for (const e of doc.installs) {
      const r = fromJson(e, scope, repoRoot);
      if (r) {
        out.push(r);
      }
    }
    return out;
  }

  /** User records plus the records of every repository this tool knows about (and the current one). */
  loadAll(currentRepo?: string): InstallRecord[] {
    const all = this.load('user');
    const repos = new Set(this.knownRepos());
    if (currentRepo && exists(this.lockPath('repo', currentRepo))) {
      this.addKnownRepo(currentRepo);
      repos.add(currentRepo);
    }
    for (const repo of repos) {
      if (exists(this.lockPath('repo', repo))) {
        all.push(...this.load('repo', repo));
      }
    }
    return all;
  }

  // ───────── writing ─────────

  upsert(rec: InstallRecord): void {
    const list = this.load(rec.scope, rec.repoRoot).filter(r => keyOf(r) !== keyOf(rec));
    list.push(rec);
    this.write(rec.scope, rec.repoRoot, list);
    if (rec.scope === 'repo' && rec.repoRoot) {
      this.addKnownRepo(rec.repoRoot);
    }
  }

  /** Forgets removed items; deletes the whole record when nothing is left. */
  removeComponents(rec: InstallRecord, removed: InstalledComponent[]): void {
    const list = this.load(rec.scope, rec.repoRoot);
    const mine = list.find(r => keyOf(r) === keyOf(rec));
    if (!mine) {
      return;
    }
    mine.components = mine.components.filter(c => !removed.some(g => sameComponent(g, c)));
    this.write(rec.scope, rec.repoRoot, mine.components.length === 0 ? list.filter(r => r !== mine) : list);
  }

  private write(scope: InstallScope, repoRoot: string | undefined, list: InstallRecord[]): void {
    const file = this.lockPath(scope, repoRoot);
    if (list.length === 0) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      return;
    }
    const sorted = [...list].sort((a, b) => cmp(a.packageName, b.packageName) || cmp(a.layout, b.layout) || cmp(a.sourceKey, b.sourceKey));
    const text = JSON.stringify({ version: 1, installs: sorted.map(toJson) }, null, 2) + '\n';
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file); // atomic replace, so the other edition never reads a half-written file
  }

  stamp(): string {
    return this.toolName;
  }

  // ───────── repositories this tool has installed into (so background updates can find them) ─────────

  private get reposFile(): string {
    return path.join(this.dataRoot, 'known-repos.json');
  }

  knownRepos(): string[] {
    const v = readJsonFile<string[]>(this.reposFile);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  }

  private addKnownRepo(repo: string): void {
    const repos = this.knownRepos();
    if (!repos.some(r => r.toLowerCase() === repo.toLowerCase())) {
      repos.push(repo);
      ensureDir(this.dataRoot);
      fs.writeFileSync(this.reposFile, JSON.stringify(repos, null, 2), 'utf8');
    }
  }

  // ───────── migration of the old per-tool records ─────────

  /** Moves records from the previous per-tool `installed.json` into the shared lock files. Idempotent. */
  migrateLegacy(sources: PluginSource[]): number {
    const legacyFile = path.join(this.dataRoot, 'installed.json');
    const legacy = readJsonFile<any[]>(legacyFile);
    if (!Array.isArray(legacy)) {
      return 0;
    }
    let moved = 0;
    for (const e of legacy) {
      const src = sources.find(s => s.id === e.sourceId);
      const scope: InstallScope = e.scope === 'repo' ? 'repo' : 'user';
      if (!src || !e.packageName || !Array.isArray(e.components) || (scope === 'repo' && (!e.repoRoot || !exists(e.repoRoot)))) {
        continue;
      }
      const rec: InstallRecord = {
        packageName: e.packageName, sourceKey: sourceKey(src), sourceKind: src.kind, sourceLocation: src.location, ref: src.ref ?? '',
        version: e.version ?? '', fingerprint: e.fingerprint ?? '', scope, repoRoot: scope === 'repo' ? e.repoRoot : undefined,
        layout: parseLayout(e.layout), components: e.components.map((c: any) => ({ kind: parseKind(c.kind), name: String(c.name) })),
        installedUtc: e.installedUtc ?? new Date().toISOString(), installedBy: this.toolName + ' (migrated)',
      };
      if (!this.load(scope, rec.repoRoot).some(r => keyOf(r) === keyOf(rec))) {
        this.upsert(rec);
        moved++;
      }
    }
    try { fs.renameSync(legacyFile, legacyFile + '.migrated'); } catch { /* ignore */ }
    return moved;
  }
}

function cmp(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function parseLayout(v: unknown): ClientLayout {
  return v === 'claude' || v === 'agents' ? v : 'copilot';
}

function parseKind(v: unknown): ComponentKind {
  return v === 'agent' || v === 'prompt' || v === 'rule' || v === 'mcp' || v === 'hook' ? v : 'skill';
}

function toJson(r: InstallRecord): Record<string, unknown> {
  return {
    package: r.packageName,
    source: r.sourceKey,
    sourceKind: r.sourceKind,
    sourceLocation: r.sourceLocation,
    ref: r.ref,
    version: r.version,
    fingerprint: r.fingerprint,
    layout: r.layout,
    components: r.components.map(c => ({ kind: c.kind, name: c.name })),
    installedAt: r.installedUtc,
    installedBy: r.installedBy,
  };
}

function fromJson(e: any, scope: InstallScope, repoRoot: string | undefined): InstallRecord | undefined {
  if (!e || typeof e.package !== 'string' || typeof e.source !== 'string' || !Array.isArray(e.components)) {
    return undefined;
  }
  return {
    packageName: e.package,
    sourceKey: e.source,
    sourceKind: e.sourceKind === 'local' ? 'local' : 'git',
    sourceLocation: typeof e.sourceLocation === 'string' ? e.sourceLocation : '',
    ref: typeof e.ref === 'string' ? e.ref : '',
    version: typeof e.version === 'string' ? e.version : '',
    fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : '',
    scope,
    repoRoot: scope === 'repo' ? repoRoot : undefined,
    layout: parseLayout(e.layout),
    components: e.components.filter((c: any) => c && typeof c.name === 'string').map((c: any) => ({ kind: parseKind(c.kind), name: c.name })),
    installedUtc: typeof e.installedAt === 'string' ? e.installedAt : '',
    installedBy: typeof e.installedBy === 'string' ? e.installedBy : '',
  };
}
