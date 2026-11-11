# Agent Plugin Manager

Browse and install [Agent Plugins](https://agent-plugins.org/) packages without leaving VS Code: pick a package from a repository, see what is inside it, choose exactly what to install and where it goes.

> Unofficial. Not affiliated with or endorsed by Anthropic, GitHub, Microsoft or agent-plugins.org. Product names are used only to describe compatibility.

Open it from the Command Palette: **Agent Plugin Manager: Open**. It opens as an editor tab.

## Features

- **Any repository as a source:** a Git repo (full URL or GitHub `owner/repo`, optional branch, tag or commit) or a local folder, containing one plugin or many.
- **Private and enterprise repos:**
  - **Sign in with VS Code:** uses the GitHub or Microsoft account you already use in VS Code (github.com and Azure DevOps).
  - **Single sign-on** through Git Credential Manager (browser sign-in for Entra ID, GitHub Enterprise / SAML SSO, Azure DevOps).
  - **Personal access tokens**, kept in VS Code's secret storage.
- **See what is inside:** every package lists its skills, agents, prompts, rules and MCP servers with descriptions and a preview of the content. Client folders such as `com.github.copilot/` and `com.anthropic.claude/` are read too, and their items are installed only for that client.
- **Install only what you need:** tick individual items, a whole package, or all packages.
- **Choose where it goes:** user folders (all projects) or the open repository, for GitHub Copilot, Claude Code or an agent-neutral `.agents` layout.
- **Shared with Visual Studio:** installs are recorded in a small `plugin-lock.json` at the destination (`~/.agents/` or `<repo>/.agents/`). The Visual Studio edition uses the same file, so each sees what the other installed. Commit the repository file to share it with your team.
- **Present but not tracked:** items already at a destination (installed by hand or by another tool) are marked, compared with the package (identical or different), and can be tracked with one click.
- **Updates:** installed packages are compared with the source on every refresh. Update manually, or turn on auto-update (also checks shortly after VS Code starts).
- **Uninstall:** remove a single item or a whole package.
- **Follows your theme:** dark, light and high-contrast.

## Where items are installed

| Client | User folders | This repository |
|---|---|---|
| GitHub Copilot | skills: `~/.copilot/skills`<br>agents, prompts and instructions: `<VS Code User>/prompts`<br>MCP: `<VS Code User>/mcp.json` | `.github/{skills,agents,prompts,instructions}`<br>MCP: `.vscode/mcp.json` |
| Claude Code | `~/.claude/{skills,agents,commands,rules}`, `~/.claude.json` | `.claude/{skills,agents,commands,rules}`, `.mcp.json` |
| Agent-neutral | `~/.agents/skills` | `.agents/skills` |

MCP servers are never selected by default. They are merged into the existing config file, and a `.bak` copy is written first. A config file that contains comments is left untouched.

## Requirements

- VS Code 1.90 or later
- `git` on your PATH. For single sign-on, Git Credential Manager (included with Git for Windows).

## Privacy and security

- No telemetry. The extension talks only to the sources you add, through your local `git`.
- Access tokens are kept in VS Code's secret storage. They are passed to git through the environment, never on a command line or in a log.
- Installing a package copies files, and optionally MCP server entries, into the folders shown above. MCP servers can run programs or reach the network, so install them only from sources you trust.
- Settings live in the extension's global storage folder. Install records live next to what you install, in `.agents/plugin-lock.json` (format: [docs/plugin-lock.md](https://github.com/DimitarCC/agents-plugin-manager/blob/main/docs/plugin-lock.md)). The file lists package names, versions, source addresses and the items installed, never credentials.

## Links

- Source code and issues: https://github.com/DimitarCC/agents-plugin-manager
- Also available for Visual Studio 2026 (same repository).
- License: MIT
