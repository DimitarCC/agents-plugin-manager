# Changelog

All notable changes to the VS Code extension are documented here.
The Visual Studio extension has its own [changelog](../CHANGELOG.md).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-11-12

### Fixed
- **Single sign-on showed no sign-in window** and failed with `could not read Username … terminal prompts disabled` when the first `git` on PATH had no credential helper configured. On Windows, single sign-on now always uses Git Credential Manager and prefers Git for Windows over other copies of git. If it still can't prompt, the error names the git that was used and explains what to install.

## [1.1.0] - 2026-11-12

Matches Visual Studio edition 1.1.0.

### Added
- **Shared install records.** Installs are recorded in `plugin-lock.json` at the destination (`~/.agents/` for user folders, `<repo>/.agents/` for a repository) and shared with the Visual Studio edition, so each sees what the other installed, updated or removed. The repository file is meant to be committed. Format: [docs/plugin-lock.md](../docs/plugin-lock.md).
- **Present but not tracked.** Items that exist at a destination without a lock entry are marked **PRESENT**, or **PRESENT · DIFFERS** when their content differs from the package. **Track them** records them so they can be updated or uninstalled.
- Installing over an identical item that is already there now tracks it instead of skipping it.
- The installed banner shows which tool last changed the install; the destination list shows the lock file path.
- Source identity by address: the same repository added in both editions is recognised as one source.

### Changed
- Records from 1.0.0 (`installed.json` in the extension's storage) are migrated into the lock files on first run.
- Content fingerprints use a defined, cross-edition algorithm.

## [1.0.0] - 2026-11-11

First release. Feature parity with the Visual Studio extension 1.0.2.

### Added
- **Agent Plugin Manager: Open** command, showing the manager as an editor tab.
- **Sources:** Git repositories (URL or GitHub `owner/repo`, optional branch/tag/commit) and local folders, each holding one or many plugin packages.
- **Private and enterprise repositories:** sign in with the GitHub or Microsoft account in VS Code, single sign-on through Git Credential Manager (Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps), or a personal access token in VS Code secret storage. A "Test connection" button in the source dialog.
- **Package browser:** searchable package list with descriptions, versions, author, license, keywords and homepage; per-package contents grouped into skills, agents, prompts/commands, MCP servers and (informational) hooks, each with a content preview.
- **Selective install:** tick individual items, a whole package, or all packages; one install can span several packages.
- **Install targets:** user folders or the open repository, for GitHub Copilot, Claude Code or an agent-neutral `.agents` layout, with the destination paths shown before installing.
- **MCP servers:** opt-in, merged into the existing config file (a `.bak` copy is written first), with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expansion and plugin-file copying for bundled servers.
- **Updates:** installed packages are compared with their source on every refresh (semantic version, or content hash for unversioned packages). Manual **Update** and **Update all**, plus an **Auto-update** option that also checks shortly after VS Code starts (never shows a sign-in prompt).
- **Uninstall:** remove a single installed item or a whole package from the selected destination.
- Theme-aware interface (dark, light, high contrast).
