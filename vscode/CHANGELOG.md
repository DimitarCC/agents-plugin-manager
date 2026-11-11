# Changelog

All notable changes to the VS Code extension are documented here.
The Visual Studio extension has its own [changelog](../CHANGELOG.md).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
