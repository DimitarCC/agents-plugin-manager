using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using AgentsPluginsPackageManager.Models;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AgentsPluginsPackageManager.Services
{
    /// <summary>
    /// Reads plugin packages laid out per https://agent-plugins.org (plugin.json, skills/&lt;n&gt;/SKILL.md, mcp.json)
    /// plus the common non-standard agents/, prompts/ and commands/ folders.
    /// </summary>
    public static class PluginScanner
    {
        private const int MaxDepth = 4;
        private const int MaxPreviewChars = 6000;

        public static List<PluginPackage> Discover(string sourceRoot)
        {
            var result = new List<PluginPackage>();
            foreach (var dir in FindPluginRoots(sourceRoot, 0))
            {
                try { result.Add(Load(dir)); }
                catch (Exception ex)
                {
                    var broken = new PluginPackage { Name = Path.GetFileName(dir), RootPath = dir, Description = "Invalid plugin: " + ex.Message };
                    broken.Warnings.Add(ex.Message);
                    result.Add(broken);
                }
            }

            if (result.Count == 0 && LooksLikePlugin(sourceRoot))
            {
                var p = Load(sourceRoot);
                p.Warnings.Add("No plugin.json found; treated the folder as an unmanifested plugin.");
                result.Add(p);
            }
            return result.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static IEnumerable<string> FindPluginRoots(string dir, int depth)
        {
            if (ManifestPath(dir) != null) { yield return dir; yield break; }
            if (depth >= MaxDepth) yield break;
            IEnumerable<string> subs;
            try { subs = Directory.GetDirectories(dir); } catch { yield break; }
            foreach (var s in subs)
            {
                var n = Path.GetFileName(s);
                if (n.StartsWith(".", StringComparison.Ordinal) || n.Equals("node_modules", StringComparison.OrdinalIgnoreCase)) continue;
                foreach (var r in FindPluginRoots(s, depth + 1)) yield return r;
            }
        }

        private static string? ManifestPath(string dir)
        {
            var a = Path.Combine(dir, "plugin.json");
            if (File.Exists(a)) return a;
            var b = Path.Combine(dir, ".claude-plugin", "plugin.json");
            return File.Exists(b) ? b : null;
        }

        private static bool LooksLikePlugin(string dir) =>
            Directory.Exists(Path.Combine(dir, "skills")) || Directory.Exists(Path.Combine(dir, "agents"))
            || Directory.Exists(Path.Combine(dir, "prompts")) || Directory.Exists(Path.Combine(dir, "commands"))
            || File.Exists(Path.Combine(dir, "mcp.json"));

        public static PluginPackage Load(string dir)
        {
            var pkg = new PluginPackage { RootPath = dir, Name = Path.GetFileName(dir.TrimEnd('\\', '/')) };
            var manifest = ManifestPath(dir);
            pkg.HasManifest = manifest != null;
            if (manifest != null)
            {
                var j = Json.ParseObject(File.ReadAllText(manifest)) ?? throw new JsonException("plugin.json is not a JSON object");
                pkg.Name = (string?)j["name"] ?? pkg.Name;
                pkg.Version = (string?)j["version"] ?? "";
                pkg.Description = (string?)j["description"] ?? "";
                pkg.Homepage = (string?)j["homepage"] ?? (string?)j["repository"] ?? "";
                pkg.License = (string?)j["license"] ?? "";
                var a = j["author"];
                pkg.Author = a is JObject ao ? (string?)ao["name"] ?? "" : (string?)a ?? "";
                if (j["keywords"] is JArray k) pkg.Keywords = string.Join(", ", k.Select(x => (string?)x ?? ""));
                if (j["$schema"] == null) pkg.Warnings.Add("plugin.json has no $schema (required by the Agent Plugins v1 spec).");
            }

            LoadSkills(pkg, dir);
            LoadMarkdownFolder(pkg, dir, "agents", ComponentKind.Agent);
            LoadMarkdownFolder(pkg, dir, "prompts", ComponentKind.Prompt);
            LoadMarkdownFolder(pkg, dir, "commands", ComponentKind.Prompt);
            LoadMcp(pkg, dir);
            LoadHooks(pkg, dir);

            pkg.Attach();
            return pkg;
        }

        private static void LoadSkills(PluginPackage pkg, string dir)
        {
            var skills = Path.Combine(dir, "skills");
            if (!Directory.Exists(skills)) return;
            foreach (var sd in Directory.GetDirectories(skills).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var md = Path.Combine(sd, "SKILL.md");
                if (!File.Exists(md)) continue;
                var text = ReadText(md);
                var fm = FrontMatter.Parse(text);
                var folder = Path.GetFileName(sd);
                var extras = new List<string>();
                foreach (var sub in new[] { "scripts", "references", "assets" })
                    if (Directory.Exists(Path.Combine(sd, sub))) extras.Add(sub + "/");
                var preview = text.Length > MaxPreviewChars ? text.Substring(0, MaxPreviewChars) + "\n…" : text;
                if (extras.Count > 0) preview = "[bundled: " + string.Join(", ", extras) + "]\n\n" + preview;
                pkg.Components.Add(new PluginComponent
                {
                    Kind = ComponentKind.Skill,
                    Name = folder,
                    Description = fm.TryGetValue("description", out var d) ? d : "",
                    RelativePath = "skills/" + folder,
                    IsDirectory = true,
                    Preview = preview,
                });
            }
        }

        private static void LoadMarkdownFolder(PluginPackage pkg, string dir, string folder, ComponentKind kind)
        {
            var d = Path.Combine(dir, folder);
            if (!Directory.Exists(d)) return;
            foreach (var f in Directory.GetFiles(d, "*.md").OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var text = ReadText(f);
                var fm = FrontMatter.Parse(text);
                var name = Path.GetFileNameWithoutExtension(f);
                if (name.EndsWith(".agent", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".prompt", StringComparison.OrdinalIgnoreCase))
                    name = Path.GetFileNameWithoutExtension(name);
                pkg.Components.Add(new PluginComponent
                {
                    Kind = kind,
                    Name = name,
                    Description = fm.TryGetValue("description", out var desc) ? desc : "",
                    RelativePath = folder + "/" + Path.GetFileName(f),
                    Preview = text.Length > MaxPreviewChars ? text.Substring(0, MaxPreviewChars) + "\n…" : text,
                });
            }
        }

        private static void LoadMcp(PluginPackage pkg, string dir)
        {
            var file = new[] { "mcp.json", ".mcp.json" }.Select(n => Path.Combine(dir, n)).FirstOrDefault(File.Exists);
            if (file == null) return;
            JObject root;
            try { root = Json.ParseObject(File.ReadAllText(file)) ?? throw new JsonException("not an object"); }
            catch (Exception ex) { pkg.Warnings.Add("mcp.json is invalid: " + ex.Message); return; }
            var servers = (root["mcpServers"] ?? root["servers"]) as JObject;
            if (servers == null) return;
            foreach (var prop in servers.Properties())
            {
                if (!(prop.Value is JObject def)) continue;
                var type = (string?)def["type"] ?? (def["url"] != null ? "http" : "stdio");
                string desc;
                if (type == "stdio")
                    desc = "stdio: " + (string?)def["command"] + " " + string.Join(" ", (def["args"] as JArray)?.Select(a => (string?)a) ?? Enumerable.Empty<string?>());
                else
                    desc = type + ": " + (string?)def["url"];
                var shown = (JObject)def.DeepClone();
                if (shown["env"] is JObject env) // never preview secrets
                    foreach (var p in env.Properties().ToList()) p.Value = "…";
                pkg.Components.Add(new PluginComponent
                {
                    Kind = ComponentKind.McpServer,
                    Name = prop.Name,
                    Description = desc.Trim(),
                    RelativePath = Path.GetFileName(file),
                    McpDefinition = (JObject)def.DeepClone(),
                    Preview = shown.ToString(Formatting.Indented),
                });
            }
        }

        private static void LoadHooks(PluginPackage pkg, string dir)
        {
            foreach (var d in Directory.GetDirectories(dir))
            {
                var n = Path.GetFileName(d);
                var hooks = Path.Combine(d, "hooks");
                if (n.Equals("hooks", StringComparison.OrdinalIgnoreCase) || (n.IndexOf('.') > 0 && Directory.Exists(hooks)))
                {
                    pkg.Components.Add(new PluginComponent
                    {
                        Kind = ComponentKind.Hook,
                        Name = n.Equals("hooks", StringComparison.OrdinalIgnoreCase) ? "hooks" : n + "/hooks",
                        Description = "Client-specific hook definitions; not supported by the installer.",
                        RelativePath = n,
                        IsDirectory = true,
                        Installable = false,
                    });
                }
            }
        }

        private static string ReadText(string path) => File.ReadAllText(path, Encoding.UTF8);
    }

    /// <summary>Minimal YAML front-matter reader (flat key/value, folded/literal block scalars).</summary>
    public static class FrontMatter
    {
        private static readonly Regex KeyRegex = new Regex(@"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", RegexOptions.Compiled);

        public static Dictionary<string, string> Parse(string text)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var lines = text.Replace("\r\n", "\n").Split('\n');
            if (lines.Length == 0 || lines[0].Trim() != "---") return result;
            int i = 1;
            for (; i < lines.Length && lines[i].Trim() != "---"; i++)
            {
                var m = KeyRegex.Match(lines[i]);
                if (!m.Success) continue;
                var key = m.Groups[1].Value;
                var value = m.Groups[2].Value.Trim();
                if (value == ">" || value == "|" || value == ">-" || value == "|-" || value == ">+" || value == "|+")
                {
                    var sb = new StringBuilder();
                    while (i + 1 < lines.Length && (lines[i + 1].StartsWith(" ") || lines[i + 1].StartsWith("\t") || lines[i + 1].Trim().Length == 0)
                           && lines[i + 1].Trim() != "---")
                    {
                        i++;
                        if (sb.Length > 0) sb.Append(value[0] == '>' ? " " : "\n");
                        sb.Append(lines[i].Trim());
                    }
                    value = sb.ToString().Trim();
                }
                else if (value.Length >= 2 && ((value[0] == '"' && value[value.Length - 1] == '"') || (value[0] == '\'' && value[value.Length - 1] == '\'')))
                {
                    value = value.Substring(1, value.Length - 2);
                }
                result[key] = value;
            }
            return result;
        }
    }
}
