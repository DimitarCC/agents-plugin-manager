# Agent Plugin Manager for Visual Studio

> Unofficial. Not affiliated with Anthropic, GitHub, Microsoft or agent-plugins.org.

Browse and install [Agent Plugins](https://agent-plugins.org/) packages from inside Visual Studio.
Open it from **Tools > Agent Plugin Manager...**

## Editions
This repository contains two editions with the same features and layout:
- **Visual Studio 2026** (`AgentsPluginsPackageManager/`): a VSIX built with the Visual Studio SDK.
- **VS Code** (`vscode/`): a TypeScript extension that shows the same UI in an editor tab. See [vscode/README.md](vscode/README.md).

Both editions share one install record per destination: `.agents/plugin-lock.json` in your home folder (user folders) or in the
repository (commit it). See [docs/plugin-lock.md](docs/plugin-lock.md). Items already at a destination without a lock entry
are shown as **PRESENT** (identical or different) and can be tracked with one click.

## Sources
A source is a git repository (or local folder) containing one or more plugin packages
(a folder with `plugin.json`, `skills/<name>/SKILL.md`, `mcp.json`; `agents/`, `prompts/`, `commands/` and `rules/`
folders are also recognised). A repo whose root is a single plugin works too.

**Client folders.** The Agent Plugins spec lets a client keep its own files in a top-level folder named after a reverse
domain. Those folders are scanned too, for `agents/`, `prompts/`, `commands/`, `rules/` (or `instructions/`) and `skills/`:
- `com.github.copilot/…` is shown with a **COPILOT** chip and is only installed when the GitHub Copilot client is selected.
- `com.anthropic.claude*/…` is shown with a **CLAUDE** chip and is only installed for the Claude Code client.
- Any other namespace (for example `com.example.client`) is listed but can't be installed, since this tool doesn't know
  its format. Hooks are listed for information only.
- If the same item exists both at the top level and in a client folder, only the first is listed (with a warning).

Authentication for private/enterprise repos:
- **Single sign-on**: uses your installed `git` + Git Credential Manager, which opens the organization's
  browser sign-in (Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps). Credentials are cached by GCM.
- **Personal access token**: must be SSO-authorized for SAML orgs. Stored DPAPI-encrypted (current Windows user)
  in `%LOCALAPPDATA%\AgentsPluginsPackageManager\settings.json` and passed to git via environment, never on a command line.
- **None**: public repos.

## Installing
Pick a package, tick the skills / agents / prompts / rules / MCP servers you want (descriptions are shown),
then choose the destination:

| Client | User folders | This repository |
|---|---|---|
| GitHub Copilot | `~/.copilot/{skills,agents,prompts,instructions}`, `~/.mcp.json` | `.github/{skills,agents,prompts,instructions}`, `.mcp.json` |
| Claude Code | `~/.claude/{skills,agents,commands,rules}`, `~/.claude.json` | `.claude/{skills,agents,commands,rules}`, `.mcp.json` |
| Agent-neutral | `~/.agents/skills` | `.agents/skills` |

MCP servers are opt-in (unticked by default), merged into the existing JSON (a `.bak` is written first),
and `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are expanded per the spec.

## Updates
Every install is recorded in the destination's `.agents/plugin-lock.json` (package, version, source, items).
On each source refresh the manager compares the installed version with the source:
- Packages show **Installed vX** and an **Update: vA → vB** badge; the detail pane has an **Update** button and the
  source bar has **Update all (N)**.
- Only the items you originally installed are updated (overwritten); new items in the package are not added automatically.
- Packages without a `version` are compared by content hash.
- **Auto-update installed plugins** applies updates on refresh and ~20 s after Visual Studio starts. The startup
  check never opens a sign-in window: if a private source needs sign-in it is skipped until you refresh manually.

## Uninstalling
Select a package and pick the destination in the install bar. Items installed there show an **INSTALLED** tag with an
**Uninstall** button, and the package gets an **Uninstall package** button. Deleted: skill folders, agent/prompt files and MCP
entries (the config file gets a `.bak` first).

## Build
Requires Visual Studio 2026 with the *Visual Studio extension development* workload.
Open `AgentsPluginsPackageManager.slnx` and press F5 (experimental instance), or build the Release configuration to get
`AgentsPluginsPackageManager\bin\Release\net472\AgentsPluginsPackageManager.vsix`.

## Publishing
Marketplace metadata lives in `Marketplace/` (`publishManifest.json`, `overview.md`). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License
[MIT](LICENSE)
