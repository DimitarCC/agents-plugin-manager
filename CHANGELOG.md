# Changelog

All notable changes to Agent Plugin Manager are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-11-13

### Added
- **Client folders.** Plugins that keep client-specific files in a reverse-domain folder such as `com.github.copilot/` or `com.anthropic.claude/` are now read. Inside such a folder `agents/`, `prompts/`, `commands/`, `rules/` (or `instructions/`) and `skills/` are listed and installed.
- **Rules / instructions** are a new kind of item, with their own group in the package details: GitHub Copilot `.github/instructions/*.instructions.md` (`~/.copilot/instructions` for user folders), Claude Code `.claude/rules/*.md`. Top-level `rules/` and `instructions/` folders are read too.
- Items from a client folder carry a **COPILOT** or **CLAUDE** chip and are only installed when that client is selected (others are skipped with an explanation). Namespaces of unknown clients are listed but not installable. An item that exists both at the top level and in a client folder is listed once, with a warning.
- Shared test vectors and a sample plugin with client folders, checked identically by both editions.

### Changed
- `plugin-lock.json` and the content fingerprint now know the `rule` kind (see [docs/plugin-lock.md](docs/plugin-lock.md)). Existing lock files stay valid.

## [1.1.1] - 2026-11-12

### Fixed
- **Single sign-on showed no sign-in window** and failed with `could not read Username … terminal prompts disabled` when the first `git` on PATH had no credential helper configured (for example a git bundled with another tool). Single sign-on now always uses Git Credential Manager, and prefers Git for Windows over other copies of git. If it still can't prompt, the error names the git that was used and explains what to install.

## [1.1.0] - 2026-11-12

### Added
- **Shared install records.** Installs are now recorded in `plugin-lock.json` at the destination (`~/.agents/` for user folders, `<repo>/.agents/` for a repository) instead of a per-tool file. The Visual Studio and VS Code editions read and write the same file, so each sees what the other installed, updated or removed. The repository file is meant to be committed. Format: [docs/plugin-lock.md](docs/plugin-lock.md).
- **Present but not tracked.** Items that exist at a destination without a lock entry (installed by hand or by another tool) are marked **PRESENT**, or **PRESENT · DIFFERS** when their content differs from the package. A **Track them** button records them so they can be updated or uninstalled; items that differ are recorded without a version so the next update replaces them.
- Installing over an identical item that is already there now tracks it instead of skipping it. A modified item is skipped with an explanation.
- The installed banner shows which tool last changed the install; the install bar shows the lock file path.
- Source identity by address: the same repository added in both editions (or typed as `owner/repo` and as a full URL) is recognised as one source.
- Test project `tests/CoreTests` and shared test vectors (`shared/`) that both editions run, including a lock file that round-trips byte for byte.

### Changed
- Records from earlier versions (`%LOCALAPPDATA%\AgentsPluginsPackageManager\installed.json`) are migrated into the lock files on first run. The old file is kept as `installed.json.migrated`.
- JSON in `mcp.json` is read without reinterpreting date-like strings, so installed MCP entries keep their exact values.
- Content fingerprints use a defined, cross-edition algorithm (unversioned packages are re-evaluated once after upgrading).

## [1.0.2] - 2026-11-11

First public release.

### Added
- **Tools > Agent Plugin Manager...** tool window for browsing and installing [Agent Plugins](https://agent-plugins.org/) packages.
- **Sources:** Git repositories (URL or GitHub `owner/repo`, optional branch/tag/commit) and local folders, each holding one or many plugin packages.
- **Private and enterprise repositories:** single sign-on through Git Credential Manager (Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps) or a personal access token stored encrypted with Windows DPAPI. A "Test connection" button in the source dialog.
- **Package browser:** searchable package list with descriptions, versions, author, license, keywords and homepage; per-package contents grouped into skills, agents, prompts/commands, MCP servers and (informational) hooks, each with a content preview.
- **Selective install:** tick individual items, a whole package, or all packages; one install can span several packages.
- **Install targets:** user folders or the current repository, for GitHub Copilot, Claude Code or an agent-neutral `.agents` layout, with the destination paths shown before installing.
- **MCP servers:** opt-in, merged into the existing config file (a `.bak` copy is written first), with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expansion and plugin-file copying for bundled servers.
- **Updates:** installed packages are compared with their source on every refresh (semantic version, or content hash for unversioned packages). Manual **Update** and **Update all**, plus an **Auto-update** option that also checks shortly after Visual Studio starts (never shows a sign-in prompt).
- **Uninstall:** remove a single installed item or a whole package from the selected destination.
- **Theming:** WinUI-style interface that follows the Visual Studio theme (light, dark, blue, high contrast).
- Extension icon, preview image and Tools menu icon.

[1.2.0]: https://github.com/DimitarCC/agents-plugin-manager/releases/tag/v1.2.0
[1.1.1]: https://github.com/DimitarCC/agents-plugin-manager/releases/tag/v1.1.1
[1.1.0]: https://github.com/DimitarCC/agents-plugin-manager/releases/tag/v1.1.0
[1.0.2]: https://github.com/DimitarCC/agents-plugin-manager/releases/tag/v1.0.2
