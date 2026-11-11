using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using AgentsPluginsPackageManager.Models;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AgentsPluginsPackageManager.Services
{
    /// <summary>String forms of enums used in plugin-lock.json (shared with the VS Code edition).</summary>
    public static class LockFormat
    {
        public static string KindToString(ComponentKind k)
        {
            switch (k)
            {
                case ComponentKind.Skill: return "skill";
                case ComponentKind.McpServer: return "mcp";
                case ComponentKind.Agent: return "agent";
                case ComponentKind.Prompt: return "prompt";
                case ComponentKind.Rule: return "rule";
                default: return "hook";
            }
        }

        public static ComponentKind ParseKind(string? s)
        {
            switch (s)
            {
                case "mcp": return ComponentKind.McpServer;
                case "agent": return ComponentKind.Agent;
                case "prompt": return ComponentKind.Prompt;
                case "rule": return ComponentKind.Rule;
                case "hook": return ComponentKind.Hook;
                default: return ComponentKind.Skill;
            }
        }

        public static ClientLayout ParseLayout(string? s) => s == "claude" ? ClientLayout.Claude : s == "agents" ? ClientLayout.AgentsNeutral : ClientLayout.Copilot;
    }

    /// <summary>
    /// Install records live in <c>&lt;scope root&gt;/.agents/plugin-lock.json</c> (see docs/plugin-lock.md):
    /// <c>~/.agents</c> for user scope, <c>&lt;repo&gt;/.agents</c> for repository scope. Both editions read and write the same files.
    /// </summary>
    public static class LockStore
    {
        private static readonly object Gate = new object();

        public static string LockPath(InstallScope scope, string? repoRoot) =>
            Path.Combine(scope == InstallScope.User ? SettingsStore.Home : repoRoot ?? "", ".agents", "plugin-lock.json");

        // ───────── reading ─────────

        public static List<InstallRecord> Load(InstallScope scope, string? repoRoot)
        {
            var result = new List<InstallRecord>();
            if (scope == InstallScope.Repository && string.IsNullOrEmpty(repoRoot)) return result;
            var file = LockPath(scope, repoRoot);
            if (!File.Exists(file)) return result;
            try
            {
                var doc = Json.ParseObject(File.ReadAllText(file, Encoding.UTF8));
                if (doc?["installs"] is JArray arr)
                    foreach (var e in arr.OfType<JObject>())
                    {
                        var r = FromJson(e, scope, repoRoot);
                        if (r != null) result.Add(r);
                    }
            }
            catch { /* unreadable or being written: treat as empty */ }
            return result;
        }

        /// <summary>User records plus the records of every repository this tool knows about (and the current one).</summary>
        public static List<InstallRecord> LoadAll(string? currentRepo)
        {
            var all = Load(InstallScope.User, null);
            var repos = new List<string>(KnownRepos());
            if (!string.IsNullOrEmpty(currentRepo) && File.Exists(LockPath(InstallScope.Repository, currentRepo)))
            {
                AddKnownRepo(currentRepo!);
                if (!repos.Any(r => string.Equals(r, currentRepo, StringComparison.OrdinalIgnoreCase))) repos.Add(currentRepo!);
            }
            foreach (var repo in repos)
                if (File.Exists(LockPath(InstallScope.Repository, repo))) all.AddRange(Load(InstallScope.Repository, repo));
            return all;
        }

        // ───────── writing ─────────

        public static void Upsert(InstallRecord rec)
        {
            lock (Gate)
            {
                var list = Load(rec.Scope, rec.RepoRoot).Where(r => r.Key != rec.Key).ToList();
                list.Add(rec);
                Write(rec.Scope, rec.RepoRoot, list);
                if (rec.Scope == InstallScope.Repository && rec.RepoRoot != null) AddKnownRepo(rec.RepoRoot);
            }
        }

        /// <summary>Forgets removed items; deletes the whole record when nothing is left.</summary>
        public static void RemoveComponents(InstallRecord rec, IEnumerable<InstalledComponent> removed)
        {
            lock (Gate)
            {
                var list = Load(rec.Scope, rec.RepoRoot);
                var mine = list.FirstOrDefault(r => r.Key == rec.Key);
                if (mine == null) return;
                var gone = removed.ToList();
                mine.Components.RemoveAll(c => gone.Any(g => g.Kind == c.Kind && string.Equals(g.Name, c.Name, StringComparison.OrdinalIgnoreCase)));
                if (mine.Components.Count == 0) list.Remove(mine);
                Write(rec.Scope, rec.RepoRoot, list);
            }
        }

        private static void Write(InstallScope scope, string? repoRoot, List<InstallRecord> list)
        {
            var file = LockPath(scope, repoRoot);
            if (list.Count == 0)
            {
                try { if (File.Exists(file)) File.Delete(file); } catch { }
                return;
            }
            var sorted = list.OrderBy(r => r.PackageName.ToLowerInvariant(), StringComparer.Ordinal)
                             .ThenBy(r => InstallRecord.LayoutName(r.Layout), StringComparer.Ordinal)
                             .ThenBy(r => r.SourceKey.ToLowerInvariant(), StringComparer.Ordinal).ToList();
            var root = new JObject { ["version"] = 1, ["installs"] = new JArray(sorted.Select(ToJson)) };
            var text = root.ToString(Formatting.Indented).Replace("\r\n", "\n") + "\n";   // LF, no BOM: stable diffs across editions

            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var tmp = file + "." + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(tmp, file, null);   // atomic: the other edition never reads a half-written file
            else File.Move(tmp, file);
        }

        private static JObject ToJson(InstallRecord r) => new JObject
        {
            ["package"] = r.PackageName,
            ["source"] = r.SourceKey,
            ["sourceKind"] = r.SourceKind,
            ["sourceLocation"] = r.SourceLocation,
            ["ref"] = r.Ref,
            ["version"] = r.Version,
            ["fingerprint"] = r.Fingerprint,
            ["layout"] = InstallRecord.LayoutName(r.Layout),
            ["components"] = new JArray(r.Components.Select(c => new JObject { ["kind"] = LockFormat.KindToString(c.Kind), ["name"] = c.Name })),
            ["installedAt"] = r.InstalledUtc,
            ["installedBy"] = r.InstalledBy,
        };

        private static InstallRecord? FromJson(JObject e, InstallScope scope, string? repoRoot)
        {
            var pkg = (string?)e["package"];
            var source = (string?)e["source"];
            if (pkg == null || source == null || !(e["components"] is JArray comps)) return null;
            return new InstallRecord
            {
                PackageName = pkg,
                SourceKey = source,
                SourceKind = (string?)e["sourceKind"] == "local" ? "local" : "git",
                SourceLocation = (string?)e["sourceLocation"] ?? "",
                Ref = (string?)e["ref"] ?? "",
                Version = (string?)e["version"] ?? "",
                Fingerprint = (string?)e["fingerprint"] ?? "",
                Scope = scope,
                RepoRoot = scope == InstallScope.Repository ? repoRoot : null,
                Layout = LockFormat.ParseLayout((string?)e["layout"]),
                Components = comps.OfType<JObject>().Where(c => c["name"] != null)
                    .Select(c => new InstalledComponent { Kind = LockFormat.ParseKind((string?)c["kind"]), Name = (string)c["name"]! }).ToList(),
                InstalledUtc = (string?)e["installedAt"] ?? "",
                InstalledBy = (string?)e["installedBy"] ?? "",
            };
        }

        // ───────── repositories this tool has installed into (so background updates can find them) ─────────

        private static string ReposFile => Path.Combine(SettingsStore.DataRoot, "known-repos.json");

        public static List<string> KnownRepos()
        {
            try
            {
                if (File.Exists(ReposFile)) return Json.ParseArray(File.ReadAllText(ReposFile))?.Select(t => (string?)t ?? "").Where(s => s.Length > 0).ToList() ?? new List<string>();
            }
            catch { }
            return new List<string>();
        }

        private static void AddKnownRepo(string repo)
        {
            var repos = KnownRepos();
            if (repos.Any(r => string.Equals(r, repo, StringComparison.OrdinalIgnoreCase))) return;
            repos.Add(repo);
            Directory.CreateDirectory(SettingsStore.DataRoot);
            File.WriteAllText(ReposFile, JsonConvert.SerializeObject(repos, Formatting.Indented));
        }

        // ───────── migration of the old per-tool records ─────────

        /// <summary>Moves records from the previous per-tool installed.json into the shared lock files. Idempotent.</summary>
        public static int MigrateLegacy(IEnumerable<PluginSource> sources)
        {
            var legacyFile = Path.Combine(SettingsStore.DataRoot, "installed.json");
            if (!File.Exists(legacyFile)) return 0;
            JArray? legacy;
            try { legacy = Json.ParseArray(File.ReadAllText(legacyFile)); } catch { return 0; }
            if (legacy == null) return 0;

            var srcList = sources.ToList();
            int moved = 0;
            foreach (var e in legacy.OfType<JObject>())
            {
                var src = srcList.FirstOrDefault(s => s.Id == (string?)e["SourceId"]);
                var scope = IsRepo(e["Scope"]) ? InstallScope.Repository : InstallScope.User;
                var repoRoot = (string?)e["RepoRoot"];
                var pkg = (string?)e["PackageName"];
                if (src == null || pkg == null || !(e["Components"] is JArray comps)) continue;
                if (scope == InstallScope.Repository && (string.IsNullOrEmpty(repoRoot) || !Directory.Exists(repoRoot))) continue;

                var rec = new InstallRecord
                {
                    PackageName = pkg, SourceKey = SourceKey.Of(src), SourceKind = src.Kind == SourceKind.Local ? "local" : "git",
                    SourceLocation = src.Location, Ref = src.Ref ?? "", Version = (string?)e["Version"] ?? "", Fingerprint = (string?)e["Fingerprint"] ?? "",
                    Scope = scope, RepoRoot = scope == InstallScope.Repository ? repoRoot : null, Layout = LegacyLayout(e["Layout"]),
                    Components = comps.OfType<JObject>().Select(c => new InstalledComponent { Kind = LegacyKind(c["Kind"]), Name = (string?)c["Name"] ?? "" }).Where(c => c.Name.Length > 0).ToList(),
                    InstalledUtc = (string?)e["InstalledUtc"] ?? "", InstalledBy = SettingsStore.ToolName + " (migrated)",
                };
                if (!Load(scope, rec.RepoRoot).Any(r => r.Key == rec.Key)) { Upsert(rec); moved++; }
            }
            try { File.Move(legacyFile, legacyFile + ".migrated"); } catch { }
            return moved;
        }

        // The old file used Newtonsoft's default enum format (integers).
        private static bool IsRepo(JToken? t) => t != null && (t.Type == JTokenType.Integer ? (int)t == 1 : string.Equals((string?)t, "Repository", StringComparison.OrdinalIgnoreCase));

        private static ClientLayout LegacyLayout(JToken? t)
        {
            if (t == null) return ClientLayout.Copilot;
            if (t.Type == JTokenType.Integer) { var i = (int)t; return i == 0 ? ClientLayout.Claude : i == 2 ? ClientLayout.AgentsNeutral : ClientLayout.Copilot; }
            var s = (string?)t;
            return string.Equals(s, "Claude", StringComparison.OrdinalIgnoreCase) ? ClientLayout.Claude
                 : string.Equals(s, "AgentsNeutral", StringComparison.OrdinalIgnoreCase) ? ClientLayout.AgentsNeutral : ClientLayout.Copilot;
        }

        private static ComponentKind LegacyKind(JToken? t)
        {
            if (t == null) return ComponentKind.Skill;
            if (t.Type == JTokenType.Integer) return Enum.IsDefined(typeof(ComponentKind), (int)t) ? (ComponentKind)(int)t : ComponentKind.Skill;
            return Enum.TryParse<ComponentKind>((string?)t, true, out var k) ? k : ComponentKind.Skill;
        }
    }
}
