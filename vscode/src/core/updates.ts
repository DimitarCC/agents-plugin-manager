import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { SyncContext, syncSource } from './git';
import { canonicalJson, contentBlock, ordinal } from './hash';
import { InstallEnv, InstallResult, Presence, install, presenceOf } from './installer';
import { LockStore } from './lockstore';
import { discover } from './scanner';
import { sourceKey } from './sourcekey';
import {
  ClientLayout, InstallRecord, InstallScope, InstalledComponent, PluginComponent, PluginPackage, PluginSource, Settings, SourceInfo,
  keyOf, recordKey, sameComponent, whereLabel,
} from './types';

export interface UpdateInfo {
  record: InstallRecord;
  pkg: PluginPackage;
  /** Components of the new package version that correspond to what is installed. */
  components: PluginComponent[];
  fromVersion: string;
  toVersion: string;
}

export function sourceInfoOf(source: PluginSource): SourceInfo {
  return { key: sourceKey(source), kind: source.kind, location: source.location, ref: source.ref ?? '' };
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

/** Finds updates for installed records belonging to the given source (by source key). */
export function findUpdates(packages: PluginPackage[], srcKey: string, records: InstallRecord[]): UpdateInfo[] {
  const result: UpdateInfo[] = [];
  const byName = new Map<string, PluginPackage>();
  for (const p of packages) {
    if (!byName.has(p.name.toLowerCase())) {
      byName.set(p.name.toLowerCase(), p);
    }
  }
  for (const r of records.filter(r => r.sourceKey === srcKey)) {
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
export function annotate(packages: PluginPackage[], srcKey: string, records: InstallRecord[]): UpdateInfo[] {
  const recs = records.filter(r => r.sourceKey === srcKey);
  const updates = findUpdates(packages, srcKey, recs);
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

export function applyUpdate(u: UpdateInfo, lock: LockStore, env: InstallEnv): InstallResult {
  const r = u.record;
  if (r.scope === 'repo' && (!r.repoRoot || !fs.existsSync(r.repoRoot))) {
    throw new Error('Repository not found: ' + r.repoRoot);
  }
  const res = install({ pkg: u.pkg, components: u.components, scope: r.scope, layout: r.layout, repoRoot: r.repoRoot, overwrite: true, env });
  recordInstall(lock, u.pkg, { key: r.sourceKey, kind: r.sourceKind, location: r.sourceLocation, ref: r.ref }, r.scope, r.repoRoot, r.layout, res.installedComponents, true);
  return res;
}

/** Remembers an install. Merges with earlier installs of the same package/target unless replacing. */
export function recordInstall(
  lock: LockStore, pkg: PluginPackage, source: SourceInfo, scope: InstallScope, repoRoot: string | undefined,
  layout: ClientLayout, installed: PluginComponent[], replace = false,
): void {
  const key = recordKey(source.key, pkg.name, scope, repoRoot, layout);
  const existing = lock.load(scope, repoRoot).find(r => keyOf(r) === key);
  const items: InstalledComponent[] = existing && !replace ? [...existing.components] : [];
  for (const c of installed) {
    if (!items.some(i => sameComponent(i, c))) {
      items.push({ kind: c.kind, name: c.name });
    }
  }
  if (items.length === 0) {
    return;
  }
  const rec: InstallRecord = {
    packageName: pkg.name, sourceKey: source.key, sourceKind: source.kind, sourceLocation: source.location, ref: source.ref,
    scope, repoRoot: scope === 'repo' ? repoRoot : undefined, layout, components: items,
    version: pkg.version ?? '', fingerprint: '', installedUtc: new Date().toISOString(), installedBy: lock.stamp(),
  };
  rec.fingerprint = fingerprint(pkg, matching(pkg, rec));
  lock.upsert(rec);
}

// ───────── items that exist but are not tracked ─────────

export interface PresenceItem {
  kind: PluginComponent['kind'];
  name: string;
  state: Exclude<Presence, ''>;
}

/** Items of the package that exist at the destination but are not listed in `tracked`. */
export function untrackedPresence(
  pkg: PluginPackage, tracked: InstallRecord | undefined, scope: InstallScope, layout: ClientLayout, repoRoot: string | undefined, env: InstallEnv,
): PresenceItem[] {
  const out: PresenceItem[] = [];
  for (const c of pkg.components) {
    if (!c.installable || tracked?.components.some(t => sameComponent(t, c))) {
      continue;
    }
    const state = presenceOf(pkg, c, scope, layout, repoRoot, env);
    if (state !== '') {
      out.push({ kind: c.kind, name: c.name, state });
    }
  }
  return out;
}

/**
 * Starts tracking untracked items. Identical items get the package version; items that differ are recorded with an
 * empty version when the record is new, so the next update replaces them.
 */
export function trackPresent(
  lock: LockStore, pkg: PluginPackage, source: SourceInfo, scope: InstallScope, repoRoot: string | undefined,
  layout: ClientLayout, env: InstallEnv,
): number {
  const key = recordKey(source.key, pkg.name, scope, repoRoot, layout);
  const existing = lock.load(scope, repoRoot).find(r => keyOf(r) === key);
  const found = untrackedPresence(pkg, existing, scope, layout, repoRoot, env);
  if (found.length === 0) {
    return 0;
  }
  const items: InstalledComponent[] = existing ? [...existing.components] : [];
  items.push(...found.map(f => ({ kind: f.kind, name: f.name })));
  const anyDiffers = found.some(f => f.state === 'differs');
  const rec: InstallRecord = existing ?? {
    packageName: pkg.name, sourceKey: source.key, sourceKind: source.kind, sourceLocation: source.location, ref: source.ref,
    scope, repoRoot: scope === 'repo' ? repoRoot : undefined, layout, components: [],
    version: anyDiffers ? '' : pkg.version ?? '', fingerprint: '', installedUtc: new Date().toISOString(), installedBy: lock.stamp(),
  };
  rec.components = items;
  rec.installedBy = lock.stamp();
  if (!existing) {
    rec.fingerprint = anyDiffers ? '' : fingerprint(pkg, matching(pkg, rec));
  }
  lock.upsert(rec);
  return found.length;
}

// ───────── fingerprint (see docs/plugin-lock.md) ─────────

export function fingerprint(pkg: PluginPackage, components: PluginComponent[]): string {
  const order = ['skill', 'mcp', 'agent', 'prompt', 'hook'];
  const sorted = [...components].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || ordinal(a.name, b.name));
  let text = '';
  for (const c of sorted) {
    text += `${c.kind}:${c.name}\n`;
    if (c.kind === 'mcp') {
      text += canonicalJson(c.mcp ?? {}) + '\n';
    } else {
      text += contentBlock(path.join(pkg.rootPath, ...c.relativePath.split('/')), c.isDirectory);
    }
  }
  return crypto.createHash('sha1').update(text, 'utf8').digest('base64');
}

// ───────── background run ─────────

/** Checks every source that has installed packages and applies available updates without prompting. */
export async function runAutoUpdate(
  settings: Settings, lock: LockStore, env: InstallEnv,
  ctxFor: (source: PluginSource) => Promise<SyncContext>,
): Promise<string[]> {
  const log: string[] = [];
  const records = lock.loadAll();
  for (const src of settings.sources.filter(s => records.some(r => r.sourceKey === sourceKey(s)))) {
    try {
      const root = await syncSource(src, await ctxFor(src));
      const pkgs = discover(root);
      for (const u of findUpdates(pkgs, sourceKey(src), lock.loadAll())) {
        try {
          applyUpdate(u, lock, env);
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
