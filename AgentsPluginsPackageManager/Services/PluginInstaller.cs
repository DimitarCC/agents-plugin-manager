using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AgentsPluginsPackageManager.Models;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;


namespace AgentsPluginsPackageManager.Services
{
    public sealed class InstallRequest
    {
        public PluginPackage Package { get; set; } = null!;
        public List<PluginComponent> Components { get; set; } = new List<PluginComponent>();
        public InstallScope Scope { get; set; }
        public ClientLayout Layout { get; set; }
        /// <summary>Repository root; required when Scope is Repository.</summary>
        public string? RepoRoot { get; set; }
        public bool Overwrite { get; set; }
    }

    public sealed class InstallResult
    {
        public List<string> Installed { get; } = new List<string>();
        public List<string> Skipped { get; } = new List<string>();
        /// <summary>Components that were actually written (not skipped).</summary>
        public List<PluginComponent> InstalledComponents { get; } = new List<PluginComponent>();
    }

    public sealed class UninstallResult
    {
        public List<string> Removed { get; } = new List<string>();
        public List<string> Skipped { get; } = new List<string>();
        public List<InstalledComponent> RemovedComponents { get; } = new List<InstalledComponent>();
    }

    /// <summary>Where each component type lands for a given scope/client-layout combination.</summary>
    public sealed class InstallLayout
    {
        public string? SkillsDir { get; set; }
        public string? AgentsDir { get; set; }
        public string? PromptsDir { get; set; }
        public string? McpFile { get; set; }
        /// <summary>JSON property that holds the servers map ("mcpServers" or "servers").</summary>
        public string McpSection { get; set; } = "mcpServers";
        public string AgentSuffix { get; set; } = ".md";
        public string PromptSuffix { get; set; } = ".md";
        public bool McpUsesHttpType { get; set; } = true;
        public string PayloadRoot { get; set; } = "";

        public static InstallLayout Resolve(InstallScope scope, ClientLayout layout, string? repoRoot)
        {
            var user = scope == InstallScope.User;
            var baseDir = user ? SettingsStore.Home : (repoRoot ?? "");
            var l = new InstallLayout();
            switch (layout)
            {
                case ClientLayout.Claude:
                    l.SkillsDir = Path.Combine(baseDir, ".claude", "skills");
                    l.AgentsDir = Path.Combine(baseDir, ".claude", "agents");
                    l.PromptsDir = Path.Combine(baseDir, ".claude", "commands");
                    l.McpFile = Path.Combine(baseDir, user ? ".claude.json" : ".mcp.json");
                    l.McpSection = "mcpServers";
                    break;
                case ClientLayout.Copilot:
                    var c = Path.Combine(baseDir, user ? ".copilot" : ".github");
                    l.SkillsDir = Path.Combine(c, "skills");
                    l.AgentsDir = Path.Combine(c, "agents");
                    l.PromptsDir = Path.Combine(c, "prompts");
                    l.AgentSuffix = ".agent.md";
                    l.PromptSuffix = ".prompt.md";
                    l.McpFile = Path.Combine(baseDir, ".mcp.json");
                    l.McpSection = "servers";
                    break;
                default:
                    l.SkillsDir = Path.Combine(baseDir, ".agents", "skills");
                    break;
            }
            l.PayloadRoot = user
                ? SettingsStore.PluginPayloadRoot
                : Path.Combine(baseDir, ".agents", "plugins");
            return l;
        }
    }

    public static class PluginInstaller
    {
        public static InstallResult Install(InstallRequest req)
        {
            if (req.Scope == InstallScope.Repository && string.IsNullOrEmpty(req.RepoRoot))
                throw new InvalidOperationException("No repository is open.");

            var layout = InstallLayout.Resolve(req.Scope, req.Layout, req.RepoRoot);
            var res = new InstallResult();
            var pkg = req.Package;
            var mcp = new List<PluginComponent>();

            foreach (var c in req.Components.Where(c => c.Installable))
            {
                switch (c.Kind)
                {
                    case ComponentKind.Skill:
                        CopyDirectory(pkg, c, layout.SkillsDir, Path.Combine(layout.SkillsDir ?? "", SafeName(c.Name)), req.Overwrite, res);
                        break;
                    case ComponentKind.Agent:
                        CopyFile(pkg, c, layout.AgentsDir, layout.AgentSuffix, req.Overwrite, res);
                        break;
                    case ComponentKind.Prompt:
                        CopyFile(pkg, c, layout.PromptsDir, layout.PromptSuffix, req.Overwrite, res);
                        break;
                    case ComponentKind.McpServer:
                        mcp.Add(c);
                        break;
                }
            }

            if (mcp.Count > 0) InstallMcp(pkg, mcp, layout, req, res);
            return res;
        }

        private static void CopyDirectory(PluginPackage pkg, PluginComponent c, string? targetRoot, string target, bool overwrite, InstallResult res)
        {
            if (targetRoot == null) { res.Skipped.Add($"{c.Name}: skills aren't supported by this client layout"); return; }
            var src = Path.Combine(pkg.RootPath, c.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            if (Directory.Exists(target))
            {
                if (!overwrite) { SkipExisting(c, src, target, true, res); return; }
                SourceSync.ForceDelete(target);
            }
            CopyTree(src, target);
            res.Installed.Add($"{c.Kind} {c.Name} → {target}");
            res.InstalledComponents.Add(c);
        }

        /// <summary>An item is already there: if it is identical to this package's version, just start tracking it; otherwise skip.</summary>
        private static void SkipExisting(PluginComponent c, string src, string target, bool isDir, InstallResult res)
        {
            if (ContentHash.Block(src, isDir) == ContentHash.Block(target, isDir))
            {
                res.Installed.Add($"{c.Kind} {c.Name}: already up to date, now tracked ({target})");
                res.InstalledComponents.Add(c);
            }
            else
            {
                res.Skipped.Add($"{c.Name}: already exists and differs from this version ({target}); tick \"Overwrite existing\" to replace it");
            }
        }

        /// <summary>Where a component is installed for a layout, or null when the layout doesn't support its kind.</summary>
        public static string? TargetPath(InstallLayout l, ComponentKind kind, string name)
        {
            switch (kind)
            {
                case ComponentKind.Skill: return l.SkillsDir == null ? null : Path.Combine(l.SkillsDir, SafeName(name));
                case ComponentKind.Agent: return l.AgentsDir == null ? null : Path.Combine(l.AgentsDir, SafeName(name) + l.AgentSuffix);
                case ComponentKind.Prompt: return l.PromptsDir == null ? null : Path.Combine(l.PromptsDir, SafeName(name) + l.PromptSuffix);
                default: return null;
            }
        }

        /// <summary>"" = not there; "same"/"differs" = present with identical/different content; "present" = MCP server (not comparable).</summary>
        public static string PresenceOf(PluginPackage pkg, PluginComponent c, InstallScope scope, ClientLayout layout, string? repoRoot)
        {
            if (!c.Installable || (scope == InstallScope.Repository && string.IsNullOrEmpty(repoRoot))) return "";
            var l = InstallLayout.Resolve(scope, layout, repoRoot);
            if (c.Kind == ComponentKind.McpServer)
            {
                if (l.McpFile == null || !File.Exists(l.McpFile)) return "";
                try
                {
                    var section = Json.ParseObject(File.ReadAllText(l.McpFile))?[l.McpSection] as JObject;
                    return section != null && section[c.Name] != null ? "present" : "";
                }
                catch { return ""; }
            }
            var target = TargetPath(l, c.Kind, c.Name);
            if (target == null || !(c.IsDirectory ? Directory.Exists(target) : File.Exists(target))) return "";
            var src = Path.Combine(pkg.RootPath, c.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            return ContentHash.Block(src, c.IsDirectory) == ContentHash.Block(target, c.IsDirectory) ? "same" : "differs";
        }

        private static void CopyFile(PluginPackage pkg, PluginComponent c, string? targetDir, string suffix, bool overwrite, InstallResult res)
        {
            if (targetDir == null) { res.Skipped.Add($"{c.Name}: {c.Kind.ToString().ToLowerInvariant()}s aren't supported by this client layout"); return; }
            var src = Path.Combine(pkg.RootPath, c.RelativePath.Replace('/', Path.DirectorySeparatorChar));
            var target = Path.Combine(targetDir, SafeName(c.Name) + suffix);
            if (File.Exists(target) && !overwrite) { SkipExisting(c, src, target, false, res); return; }
            Directory.CreateDirectory(targetDir);
            File.Copy(src, target, true);
            res.Installed.Add($"{c.Kind} {c.Name} → {target}");
            res.InstalledComponents.Add(c);
        }

        private static void InstallMcp(PluginPackage pkg, List<PluginComponent> servers, InstallLayout layout, InstallRequest req, InstallResult res)
        {
            if (layout.McpFile == null)
            {
                foreach (var s in servers) res.Skipped.Add($"{s.Name}: MCP servers aren't supported by this client layout");
                return;
            }

            JObject doc = new JObject();
            if (File.Exists(layout.McpFile))
            {
                try { doc = Json.ParseObject(File.ReadAllText(layout.McpFile)) ?? throw new JsonException("not an object"); }
                catch (Exception ex)
                {
                    foreach (var s in servers) res.Skipped.Add($"{s.Name}: cannot parse existing {layout.McpFile} ({ex.Message}); left untouched");
                    return;
                }
            }
            var section = doc[layout.McpSection] as JObject;
            if (section == null) { section = new JObject(); doc[layout.McpSection] = section; }

            // Servers that reference plugin files (./cmd, ${PLUGIN_ROOT}) need the plugin payload on disk.
            string? pluginRoot = null, pluginData = null;
            bool changed = false;
            foreach (var s in servers)
            {
                var def = (JObject)s.McpDefinition!.DeepClone();
                if (section[s.Name] != null && !req.Overwrite) { res.Skipped.Add($"{s.Name}: MCP server already configured"); continue; }

                if (NeedsPayload(def))
                {
                    if (pluginRoot == null)
                    {
                        pluginRoot = Path.Combine(layout.PayloadRoot, SafeName(pkg.Name));
                        pluginData = pluginRoot + "-data";
                        if (Directory.Exists(pluginRoot)) SourceSync.ForceDelete(pluginRoot);
                        CopyTree(pkg.RootPath, pluginRoot);
                        Directory.CreateDirectory(pluginData);
                    }
                    Expand(def, pluginRoot, pluginData!);
                }
                section[s.Name] = ToClientFormat(def, layout);
                changed = true;
                res.Installed.Add($"MCP server {s.Name} → {layout.McpFile}");
                res.InstalledComponents.Add(s);
            }

            if (changed)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(layout.McpFile)!);
                if (File.Exists(layout.McpFile)) File.Copy(layout.McpFile, layout.McpFile + ".bak", true);
                File.WriteAllText(layout.McpFile, doc.ToString(Formatting.Indented));
            }
        }

        private static bool NeedsPayload(JObject def)
        {
            var text = def.ToString(Formatting.None);
            if (text.Contains("${PLUGIN_ROOT}") || text.Contains("${PLUGIN_DATA}")) return true;
            var cmd = (string?)def["command"];
            return cmd != null && (cmd.StartsWith("./") || cmd.StartsWith(".\\"));
        }

        /// <summary>Applies the spec's ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion and resolves plugin-relative paths.</summary>
        private static void Expand(JObject def, string root, string data)
        {
            string Sub(string s) => s.Replace("${PLUGIN_ROOT}", root).Replace("${PLUGIN_DATA}", data);
            if (def["args"] is JArray args)
                for (int i = 0; i < args.Count; i++) args[i] = Sub((string?)args[i] ?? "");
            if (def["env"] is JObject env)
                foreach (var p in env.Properties().ToList()) p.Value = Sub((string?)p.Value ?? "");

            var cmd = (string?)def["command"];
            if (cmd != null && (cmd.StartsWith("./") || cmd.StartsWith(".\\")))
                def["command"] = Path.GetFullPath(Path.Combine(root, cmd.Substring(2)));

            var cwd = (string?)def["cwd"];
            if (cwd == null) def["cwd"] = root;
            else if (cwd.StartsWith("./") || cwd.StartsWith(".\\")) def["cwd"] = Path.GetFullPath(Path.Combine(root, cwd.Substring(2)));
            else def["cwd"] = Sub(cwd);
        }

        private static JObject ToClientFormat(JObject def, InstallLayout layout)
        {
            var o = (JObject)def.DeepClone();
            var type = (string?)o["type"];
            if (type == "streamable-http") o["type"] = "http";
            else if (type == null) o["type"] = o["url"] != null ? "http" : "stdio";
            return o;
        }

        private static void CopyTree(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src))
                File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(src))
            {
                if (Path.GetFileName(d) == ".git") continue;
                CopyTree(d, Path.Combine(dst, Path.GetFileName(d)));
            }
        }

        private static string SafeName(string name)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name;
        }

        /// <summary>Deletes previously installed items of a record from its destination.</summary>
        public static UninstallResult Uninstall(InstallRecord rec, IEnumerable<InstalledComponent> items)
        {
            var res = new UninstallResult();
            var layout = InstallLayout.Resolve(rec.Scope, rec.Layout, rec.RepoRoot);
            var list = items.ToList();

            foreach (var item in list.Where(i => i.Kind != ComponentKind.McpServer))
            {
                string? target = null;
                switch (item.Kind)
                {
                    case ComponentKind.Skill:
                        if (layout.SkillsDir != null) target = Path.Combine(layout.SkillsDir, SafeName(item.Name));
                        break;
                    case ComponentKind.Agent:
                        if (layout.AgentsDir != null) target = Path.Combine(layout.AgentsDir, SafeName(item.Name) + layout.AgentSuffix);
                        break;
                    case ComponentKind.Prompt:
                        if (layout.PromptsDir != null) target = Path.Combine(layout.PromptsDir, SafeName(item.Name) + layout.PromptSuffix);
                        break;
                }
                if (target == null) { res.Skipped.Add($"{item.Name}: not supported by this client layout"); continue; }

                try
                {
                    if (Directory.Exists(target)) { SourceSync.ForceDelete(target); res.Removed.Add($"{item.Kind} {item.Name} ← {target}"); }
                    else if (File.Exists(target)) { File.SetAttributes(target, FileAttributes.Normal); File.Delete(target); res.Removed.Add($"{item.Kind} {item.Name} ← {target}"); }
                    else res.Removed.Add($"{item.Kind} {item.Name}: already gone");
                    res.RemovedComponents.Add(item);
                }
                catch (Exception ex) { res.Skipped.Add($"{item.Name}: {ex.Message}"); }
            }

            var mcp = list.Where(i => i.Kind == ComponentKind.McpServer).ToList();
            if (mcp.Count > 0 && layout.McpFile != null)
            {
                try
                {
                    if (File.Exists(layout.McpFile))
                    {
                        var doc = Json.ParseObject(File.ReadAllText(layout.McpFile)) ?? throw new JsonException("not an object");
                        var section = doc[layout.McpSection] as JObject;
                        bool changed = false;
                        foreach (var m in mcp)
                        {
                            if (section != null && section.Remove(m.Name)) { changed = true; res.Removed.Add($"MCP server {m.Name} ← {layout.McpFile}"); }
                            else res.Removed.Add($"MCP server {m.Name}: already gone");
                            res.RemovedComponents.Add(m);
                        }
                        if (changed)
                        {
                            File.Copy(layout.McpFile, layout.McpFile + ".bak", true);
                            File.WriteAllText(layout.McpFile, doc.ToString(Formatting.Indented));
                        }
                    }
                    else foreach (var m in mcp) { res.Removed.Add($"MCP server {m.Name}: already gone"); res.RemovedComponents.Add(m); }
                }
                catch (Exception ex) { foreach (var m in mcp) res.Skipped.Add($"{m.Name}: cannot edit {layout.McpFile} ({ex.Message})"); }
            }
            else if (mcp.Count > 0) foreach (var m in mcp) res.Skipped.Add($"{m.Name}: not supported by this client layout");

            // Once no MCP server of the package remains, drop the copied plugin payload (the -data folder is kept).
            var remainingMcp = rec.Components.Count(c => c.Kind == ComponentKind.McpServer)
                               - res.RemovedComponents.Count(c => c.Kind == ComponentKind.McpServer);
            if (mcp.Count > 0 && remainingMcp <= 0)
            {
                var payload = Path.Combine(layout.PayloadRoot, SafeName(rec.PackageName));
                try { if (Directory.Exists(payload)) { SourceSync.ForceDelete(payload); res.Removed.Add("plugin files ← " + payload); } }
                catch (Exception ex) { res.Skipped.Add("plugin files: " + ex.Message); }
            }
            return res;
        }

        /// <summary>Walks up from a folder to the nearest directory containing .git.</summary>
        public static string? FindRepoRoot(string? startDir)
        {
            var d = startDir;
            while (!string.IsNullOrEmpty(d))
            {
                if (Directory.Exists(Path.Combine(d, ".git")) || File.Exists(Path.Combine(d, ".git"))) return d;
                d = Path.GetDirectoryName(d);
            }
            return startDir;
        }
    }
}
