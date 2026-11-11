# Agent Plugin Manager

Browse and install [Agent Plugins](https://agent-plugins.org/) packages without leaving Visual Studio: pick a package from a repository, see what is inside it, choose exactly what to install and where it goes.

> Unofficial. Not affiliated with or endorsed by Anthropic, GitHub, Microsoft or agent-plugins.org. Product names are used only to describe compatibility.

Open it from **Tools > Agent Plugin Manager...**

## Features

- **Any repository as a source:** a Git repo (full URL or GitHub `owner/repo`, optional branch, tag or commit) or a local folder, containing one plugin or many.
- **Private and enterprise repos:**
  - **Single sign-on** through Git Credential Manager (browser sign-in for Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps).
  - **Personal access tokens**, stored encrypted for your Windows account.
- **See what is inside:** every package lists its skills, agents, prompts and MCP servers with descriptions and a preview of the content.
- **Install only what you need:** tick individual items, a whole package, or all packages.
- **Choose where it goes:** user folders (all projects) or the current repository, for GitHub Copilot, Claude Code or an agent-neutral `.agents` layout.
- **Shared with VS Code:** installs are recorded in a small `plugin-lock.json` at the destination (`~/.agents/` or `<repo>/.agents/`), which the VS Code edition also reads and writes. Each edition sees what the other installed. Commit the repository file to share it with your team.
- **Present but not tracked:** items already at a destination (installed by hand or by another tool) are marked, compared with the package (identical or different), and can be tracked with one click.
- **Updates:** installed packages are compared with the source on every refresh. Update manually, or turn on auto-update (also checks shortly after Visual Studio starts).
- **Uninstall:** remove a single item or a whole package.
- **Dark, light, blue and high-contrast themes:** the UI follows the Visual Studio theme.

## Where items are installed

| Client | User folders | This repository |
|---|---|---|
| GitHub Copilot | `~/.copilot/{skills,agents,prompts}`, `~/.mcp.json` | `.github/{skills,agents,prompts}`, `.mcp.json` |
| Claude Code | `~/.claude/{skills,agents,commands}`, `~/.claude.json` | `.claude/{skills,agents,commands}`, `.mcp.json` |
| Agent-neutral | `~/.agents/skills` | `.agents/skills` |

MCP servers are never selected by default. They are merged into the existing config file, and a `.bak` copy is written first.

## Requirements

- Visual Studio 2026
- `git` on PATH, in Program Files, or the Visual Studio Git component. For single sign-on, Git Credential Manager (included with Git for Windows).

## Links

- Source code and issues: https://github.com/DimitarCC/agents-plugin-manager
- Changelog: https://github.com/DimitarCC/agents-plugin-manager/blob/main/CHANGELOG.md
- License: MIT

## Privacy and security

- No telemetry. The extension talks only to the sources you add, through your local `git`.
- Access tokens are encrypted with Windows DPAPI for your user account. They are passed to git through the environment, never on a command line or in a log.
- Installing a package copies files, and optionally MCP server entries, into the folders shown above. MCP servers can run programs or reach the network, so install them only from sources you trust.
- Settings live in `%LOCALAPPDATA%\AgentsPluginsPackageManager`. Install records live next to what you install, in `.agents/plugin-lock.json`. The file lists package names, versions, source addresses and the items installed, never credentials.
