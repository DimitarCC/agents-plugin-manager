# Changelog

All notable changes to Agent Plugin Manager are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[1.0.2]: https://github.com/DimitarCC/agents-plugin-manager/releases/tag/v1.0.2
