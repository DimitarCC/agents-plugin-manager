export type SourceKind = 'git' | 'local';

/**
 * none   - public repository
 * sso    - Git Credential Manager (browser sign-in: Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps)
 * vscode - sign in with VS Code's built-in GitHub / Microsoft accounts
 * pat    - personal access token (must be SSO-authorized for SAML orgs)
 */
export type AuthMode = 'none' | 'sso' | 'vscode' | 'pat';

export type InstallScope = 'user' | 'repo';
export type ClientLayout = 'copilot' | 'claude' | 'agents';
export type ComponentKind = 'skill' | 'agent' | 'prompt' | 'rule' | 'mcp' | 'hook';

/** Clients that have their own namespace folders in a plugin (com.github.copilot, com.anthropic.claude, …). */
export type ClientId = 'copilot' | 'claude';

export interface PluginSource {
  id: string;
  name: string;
  kind: SourceKind;
  /** Git URL, GitHub "owner/repo" shorthand, or local folder. */
  location: string;
  /** Optional branch, tag or commit. */
  ref: string;
  auth: AuthMode;
}

export interface Settings {
  sources: PluginSource[];
  lastSourceId?: string;
  scope: InstallScope;
  layout: ClientLayout;
  /** Apply updates to installed plugins automatically (on refresh and shortly after startup). */
  autoUpdate: boolean;
}

export interface PluginComponent {
  kind: ComponentKind;
  name: string;
  description: string;
  /** Relative to the plugin root (file or directory), always with forward slashes. */
  relativePath: string;
  isDirectory: boolean;
  installable: boolean;
  /** Text preview (SKILL.md, agent, prompt) or masked JSON for MCP servers. */
  preview: string;
  /** Raw MCP server definition (only for kind === 'mcp'). */
  mcp?: Record<string, any>;
  /** For items found in a client namespace folder (e.g. com.github.copilot/agents): the client they are made for. */
  client?: ClientId;
  /** The namespace folder the item came from, e.g. "com.github.copilot". Unset for the portable top-level folders. */
  namespace?: string;
}

export function layoutClient(layout: ClientLayout): ClientId | undefined {
  return layout === 'copilot' ? 'copilot' : layout === 'claude' ? 'claude' : undefined;
}

export function clientLabel(c: ClientId): string {
  return c === 'copilot' ? 'GitHub Copilot' : 'Claude Code';
}

export interface PluginPackage {
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string;
  license: string;
  keywords: string[];
  rootPath: string;
  hasManifest: boolean;
  components: PluginComponent[];
  warnings: string[];
  // Runtime annotations (set by the update service)
  installedSummary?: string;
  hasUpdate?: boolean;
  updateText?: string;
}

export interface InstalledComponent {
  kind: ComponentKind;
  name: string;
}

/**
 * What was installed from a package, where, and at which version.
 * Persisted in `<scope root>/.agents/plugin-lock.json` (see docs/plugin-lock.md), shared with the Visual Studio edition.
 * `scope` and `repoRoot` come from which lock file the record was read from; they are not stored inside it.
 */
export interface InstallRecord {
  packageName: string;
  /** Source key (see sourcekey.ts): identifies the repository regardless of how it was entered. */
  sourceKey: string;
  sourceKind: SourceKind;
  sourceLocation: string;
  ref: string;
  version: string;
  /** Content hash of the installed components; detects changes when a package has no version. */
  fingerprint: string;
  scope: InstallScope;
  repoRoot?: string;
  layout: ClientLayout;
  components: InstalledComponent[];
  installedUtc: string;
  /** "<tool> <version>" of the last writer. */
  installedBy: string;
}

/** Identifies the source a record or install belongs to. */
export interface SourceInfo {
  key: string;
  kind: SourceKind;
  location: string;
  ref: string;
}

export function recordKey(sourceKey: string, packageName: string, scope: InstallScope, repoRoot: string | undefined, layout: ClientLayout): string {
  return [sourceKey, packageName.toLowerCase(), scope, scope === 'repo' ? (repoRoot ?? '').toLowerCase() : '', layout].join('|');
}

export function keyOf(r: InstallRecord): string {
  return recordKey(r.sourceKey, r.packageName, r.scope, r.repoRoot, r.layout);
}

export function sameComponent(a: InstalledComponent, b: InstalledComponent): boolean {
  return a.kind === b.kind && a.name.toLowerCase() === b.name.toLowerCase();
}

export function whereLabel(r: Pick<InstallRecord, 'scope' | 'layout'>): string {
  const layout = r.layout === 'copilot' ? 'Copilot' : r.layout === 'claude' ? 'Claude' : 'Agents';
  return (r.scope === 'user' ? 'User' : 'Repo') + ' · ' + layout;
}
