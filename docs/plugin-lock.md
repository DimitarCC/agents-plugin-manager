# `plugin-lock.json` — shared install records

The Visual Studio and VS Code editions of Agent Plugin Manager record what they install in a small JSON file
**at the destination**, so either edition (and teammates) can see what is installed, from where, and at which version.

| Scope | File |
|---|---|
| User folders | `~/.agents/plugin-lock.json` |
| Repository | `<repo>/.agents/plugin-lock.json` (meant to be committed) |

One file holds the installs for every client layout (Copilot, Claude, agent-neutral) of that scope.
Files are written as UTF-8 without BOM, LF line endings, 2-space indent, entries sorted by `package` then `layout`
then `source` (case-insensitive ordinal), so the same content always produces the same bytes.
[`shared/fixtures/plugin-lock.sample.json`](../shared/fixtures/plugin-lock.sample.json) is a reference file that both
editions must read and rewrite byte for byte.
The file is deleted when the last entry is removed.

```json
{
  "version": 1,
  "installs": [
    {
      "package": "code-review-kit",
      "source": "github.com/owner/repo",
      "sourceKind": "git",
      "sourceLocation": "https://github.com/Owner/Repo.git",
      "ref": "",
      "version": "1.4.0",
      "fingerprint": "base64-sha1…",
      "layout": "copilot",
      "components": [
        { "kind": "skill", "name": "review-checklist" },
        { "kind": "agent", "name": "reviewer" }
      ],
      "installedAt": "2026-11-12T09:30:00.000Z",
      "installedBy": "vscode 1.1.0"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `package` | Plugin name (`plugin.json` `name`). |
| `source` | **Source key** (below). Identifies the repository independent of how it was typed or which tool added it. |
| `sourceKind` / `sourceLocation` / `ref` | Informational: `git` or `local`, the location as entered, optional branch/tag/commit. |
| `version` | Package version at install time. Empty when unknown (e.g. adopted items that differ from the package). |
| `fingerprint` | Content hash (below) of the installed components as they were in the package. |
| `layout` | `copilot`, `claude` or `agents`. |
| `components[].kind` | `skill`, `agent`, `prompt` or `mcp`. |
| `installedAt`, `installedBy` | UTC timestamp and `<tool> <version>` of the last writer. |

An entry is unique by (`source`, `package`, `layout`). Unknown fields must be preserved by readers where practical
and ignored otherwise. A reader that sees `version` greater than 1 should treat the file as read-only.

## Source key

Both editions must compute identical keys.

**Git** (`sourceKind: git`)
1. Trim the location.
2. `owner/repo` shorthand (`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`) → host `github.com`, path = the shorthand.
3. scp-like `user@host:path` (`^[A-Za-z0-9_.-]+@([^:/]+):(.+)$`, no `scheme://`) → host and path from the groups.
4. Otherwise drop `scheme://`, split at the first `/` into authority and path, drop everything up to the last `@` of the
   authority (credentials), drop a `:port`.
5. Remove `?query` and `#fragment` from the path, trim `/` from both ends, remove a trailing `.git` (case-insensitive).
6. `key = lower(host) + "/" + lower(path)` (just the host when the path is empty).

**Local** (`sourceKind: local`): replace `\` with `/`, trim trailing `/`, lower-case the whole string if it starts with a
drive letter (`X:`) or `//`, then prefix `file:`.

Shared test vectors: [`shared/test-vectors.json`](../shared/test-vectors.json).

## Fingerprint

`fingerprint = base64(sha1(utf8(text)))`, where `text` is the concatenation, for every component sorted by kind
(`skill`, `mcp`, `agent`, `prompt`, `hook`) and then by name (ordinal, case-sensitive), of:

```
<kind>:<name>\n
<content block>
```

Content block:
- **MCP server:** the canonical JSON of its definition, then `\n`. Canonical JSON: object keys sorted ordinally, no
  whitespace, strings escaped as `\"`, `\\` and `\uXXXX` (lower-case hex) for every code unit below 0x20 or above 0x7e.
- **Skill (directory):** for every file below the directory, sorted ordinally by relative path:
  `/<relative path with / separators>:<base64(sha1(bytes with 0x0D removed))>\n`.
- **Agent / prompt (single file):** `:<base64(sha1(bytes with 0x0D removed))>\n`.

Removing `0x0D` makes CRLF and LF checkouts hash the same.

## Items that are present but not tracked

If an item exists at a destination but no lock entry lists it, the editions show it as **present** and compare its
content block with the package's: **identical** or **differs**. MCP servers can only be reported as present.
The user can **track** such items (identical ones are recorded with the package version; ones that differ are recorded
with an empty version so the next update replaces them). Installing without *Overwrite* over an identical item also
tracks it.
