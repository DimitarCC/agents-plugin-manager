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
export type ComponentKind = 'skill' | 'agent' | 'prompt' | 'mcp' | 'hook';

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

/** What was installed from a package, where, and at which version. */
export interface InstallRecord {
  packageName: string;
  sourceId: string;
  version: string;
  /** Content hash of the installed components; detects changes when a package has no version. */
  fingerprint: string;
  scope: InstallScope;
  repoRoot?: string;
  layout: ClientLayout;
  components: InstalledComponent[];
  installedUtc: string;
}

export function recordKey(sourceId: string, packageName: string, scope: InstallScope, repoRoot: string | undefined, layout: ClientLayout): string {
  return [sourceId, packageName, scope, scope === 'repo' ? repoRoot ?? '' : '', layout].join('|');
}

export function keyOf(r: InstallRecord): string {
  return recordKey(r.sourceId, r.packageName, r.scope, r.repoRoot, r.layout);
}

export function sameComponent(a: InstalledComponent, b: InstalledComponent): boolean {
  return a.kind === b.kind && a.name.toLowerCase() === b.name.toLowerCase();
}

export function whereLabel(r: Pick<InstallRecord, 'scope' | 'layout'>): string {
  const layout = r.layout === 'copilot' ? 'Copilot' : r.layout === 'claude' ? 'Claude' : 'Agents';
  return (r.scope === 'user' ? 'User' : 'Repo') + ' · ' + layout;
}
