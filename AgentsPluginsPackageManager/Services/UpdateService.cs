using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using AgentsPluginsPackageManager.Models;
using Newtonsoft.Json;

namespace AgentsPluginsPackageManager.Services
{
    public sealed class UpdateInfo
    {
        public InstallRecord Record { get; set; } = null!;
        public PluginPackage Package { get; set; } = null!;
        /// <summary>Components of the new package version that correspond to what is installed.</summary>
        public List<PluginComponent> Components { get; set; } = new List<PluginComponent>();
        public string FromVersion => string.IsNullOrEmpty(Record.Version) ? "unversioned" : "v" + Record.Version;
        public string ToVersion => string.IsNullOrEmpty(Package.Version) ? "new content" : "v" + Package.Version;
    }

    /// <summary>Persists which packages were installed where, so updates can be detected and re-applied.</summary>
    public static class InstallStore
    {
        private static readonly object Gate = new object();
        private static string FilePath => Path.Combine(SettingsStore.DataRoot, "installed.json");

        public static List<InstallRecord> Load()
        {
            lock (Gate)
            {
                try
                {
                    if (File.Exists(FilePath))
                        return JsonConvert.DeserializeObject<List<InstallRecord>>(File.ReadAllText(FilePath)) ?? new List<InstallRecord>();
                }
                catch { }
                return new List<InstallRecord>();
            }
        }

        /// <summary>Forgets removed items; deletes the whole record when nothing is left.</summary>
        public static void RemoveComponents(string key, IEnumerable<InstalledComponent> removed)
        {
            lock (Gate)
            {
                var all = Load();
                var rec = all.FirstOrDefault(r => r.Key == key);
                if (rec == null) return;
                var gone = removed.ToList();
                rec.Components.RemoveAll(c => gone.Any(g => g.Kind == c.Kind && string.Equals(g.Name, c.Name, StringComparison.OrdinalIgnoreCase)));
                if (rec.Components.Count == 0) all.RemoveAll(r => r.Key == key);
                Directory.CreateDirectory(SettingsStore.DataRoot);
                File.WriteAllText(FilePath, JsonConvert.SerializeObject(all, Formatting.Indented));
            }
        }

        public static void Upsert(InstallRecord record)
        {
            lock (Gate)
            {
                var all = Load();
                all.RemoveAll(r => r.Key == record.Key);
                all.Add(record);
                Directory.CreateDirectory(SettingsStore.DataRoot);
                File.WriteAllText(FilePath, JsonConvert.SerializeObject(all, Formatting.Indented));
            }
        }
    }

    public static class UpdateService
    {
        private static readonly Regex VersionRegex = new Regex(@"^v?(\d+(?:\.\d+){0,3})", RegexOptions.Compiled);

        // ───────── detection ─────────

        public static bool IsUpdateAvailable(InstallRecord installed, PluginPackage available, string availableFingerprint)
        {
            var a = available.Version ?? "";
            var i = installed.Version ?? "";
            if (a.Length > 0)
            {
                if (TryParse(a, out var av) && TryParse(i, out var iv)) return av > iv;
                return !string.Equals(a, i, StringComparison.OrdinalIgnoreCase);
            }
            // Unversioned package: fall back to content comparison.
            return i.Length == 0 && installed.Fingerprint.Length > 0 && installed.Fingerprint != availableFingerprint;
        }

        private static bool TryParse(string s, out Version v)
        {
            v = new Version(0, 0);
            var m = VersionRegex.Match(s ?? "");
            if (!m.Success) return false;
            var text = m.Groups[1].Value;
            if (!text.Contains(".")) text += ".0";
            return Version.TryParse(text, out v);
        }

        /// <summary>Finds updates for installed records belonging to <paramref name="sourceId"/>.</summary>
        public static List<UpdateInfo> FindUpdates(IEnumerable<PluginPackage> packages, string sourceId, IEnumerable<InstallRecord> records)
        {
            var result = new List<UpdateInfo>();
            var byName = packages.GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
            foreach (var r in records.Where(r => r.SourceId == sourceId))
            {
                if (!byName.TryGetValue(r.PackageName, out var pkg)) continue;
                var comps = Matching(pkg, r);
                if (comps.Count == 0) continue;
                if (IsUpdateAvailable(r, pkg, Fingerprint(pkg, comps)))
                    result.Add(new UpdateInfo { Record = r, Package = pkg, Components = comps });
            }
            return result;
        }

        /// <summary>Applies per-package install state (installed / update available) to the list shown in the UI.</summary>
        public static void Annotate(IEnumerable<PluginPackage> packages, string sourceId, IEnumerable<InstallRecord> records)
        {
            var recs = records.Where(r => r.SourceId == sourceId).ToList();
            var updates = FindUpdates(packages, sourceId, recs);
            foreach (var p in packages)
            {
                var mine = recs.Where(r => string.Equals(r.PackageName, p.Name, StringComparison.OrdinalIgnoreCase)).ToList();
                if (mine.Count == 0) { p.SetInstallState("", false, ""); continue; }
                var summary = "Installed " + string.Join(", ", mine.Select(r =>
                    (string.IsNullOrEmpty(r.Version) ? "" : "v" + r.Version + " ") + "(" + r.Where + ")"));
                var ups = updates.Where(u => ReferenceEquals(u.Package, p)).ToList();
                p.SetInstallState(summary, ups.Count > 0,
                    ups.Count == 0 ? "" : ups[0].FromVersion + " → " + ups[0].ToVersion);
            }
        }

        private static List<PluginComponent> Matching(PluginPackage pkg, InstallRecord r) =>
            pkg.Components.Where(c => c.Installable &&
                r.Components.Any(ic => ic.Kind == c.Kind && string.Equals(ic.Name, c.Name, StringComparison.OrdinalIgnoreCase))).ToList();

        // ───────── applying ─────────

        public static InstallResult Apply(UpdateInfo u)
        {
            var r = u.Record;
            if (r.Scope == InstallScope.Repository && (string.IsNullOrEmpty(r.RepoRoot) || !Directory.Exists(r.RepoRoot)))
                throw new InvalidOperationException("Repository not found: " + r.RepoRoot);

            var res = PluginInstaller.Install(new InstallRequest
            {
                Package = u.Package,
                Components = u.Components,
                Scope = r.Scope,
                Layout = r.Layout,
                RepoRoot = r.RepoRoot,
                Overwrite = true,
            });
            Record(u.Package, r.SourceId, r.Scope, r.RepoRoot, r.Layout, res.InstalledComponents, replace: true);
            return res;
        }

        /// <summary>Remembers an install. Merges with earlier installs of the same package/target unless replacing.</summary>
        public static void Record(PluginPackage pkg, string sourceId, InstallScope scope, string? repoRoot, ClientLayout layout,
            IEnumerable<PluginComponent> installed, bool replace = false)
        {
            var rec = new InstallRecord
            {
                PackageName = pkg.Name, SourceId = sourceId, Scope = scope,
                RepoRoot = scope == InstallScope.Repository ? repoRoot : null, Layout = layout,
            };
            var existing = InstallStore.Load().FirstOrDefault(r => r.Key == rec.Key);
            var items = new List<InstalledComponent>();
            if (existing != null && !replace) items.AddRange(existing.Components);
            foreach (var c in installed)
                if (!items.Any(i => i.Kind == c.Kind && string.Equals(i.Name, c.Name, StringComparison.OrdinalIgnoreCase)))
                    items.Add(new InstalledComponent { Kind = c.Kind, Name = c.Name });
            if (items.Count == 0) return;
            rec.Components = items;
            rec.Version = pkg.Version ?? "";
            rec.Fingerprint = Fingerprint(pkg, Matching(pkg, rec));
            InstallStore.Upsert(rec);
        }

        // ───────── fingerprint ─────────

        public static string Fingerprint(PluginPackage pkg, IEnumerable<PluginComponent> components)
        {
            using (var sha = SHA1.Create())
            {
                var sb = new StringBuilder();
                foreach (var c in components.OrderBy(c => c.Kind).ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase))
                {
                    sb.Append(c.Kind).Append(':').Append(c.Name).Append('\n');
                    if (c.Kind == ComponentKind.McpServer) { sb.Append(c.McpDefinition?.ToString(Formatting.None)).Append('\n'); continue; }
                    var path = Path.Combine(pkg.RootPath, c.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                    IEnumerable<string> files = c.IsDirectory && Directory.Exists(path)
                        ? Directory.GetFiles(path, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.OrdinalIgnoreCase)
                        : File.Exists(path) ? new[] { path } : Enumerable.Empty<string>();
                    foreach (var f in files)
                    {
                        sb.Append(f.Substring(path.Length)).Append(':');
                        // normalise line endings so CRLF/LF checkouts hash the same
                        var text = File.ReadAllBytes(f);
                        sb.Append(Convert.ToBase64String(sha.ComputeHash(text.Where(b => b != 13).ToArray()))).Append('\n');
                    }
                }
                return Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString())));
            }
        }

        // ───────── background run (VS startup) ─────────

        /// <summary>Checks every source that has installed packages and applies available updates without prompting.</summary>
        public static async Task<List<string>> RunAutoUpdateAsync(Settings settings, CancellationToken ct)
        {
            var log = new List<string>();
            var records = InstallStore.Load();
            foreach (var src in settings.Sources.Where(s => records.Any(r => r.SourceId == s.Id)))
            {
                try
                {
                    var root = await SourceSync.SyncAsync(src, null, ct, interactive: false).ConfigureAwait(false);
                    var pkgs = PluginScanner.Discover(root);
                    foreach (var u in FindUpdates(pkgs, src.Id, InstallStore.Load()))
                    {
                        try
                        {
                            Apply(u);
                            log.Add(u.Package.Name + " " + u.FromVersion + " → " + u.ToVersion);
                        }
                        catch (Exception ex) { log.Add(u.Package.Name + ": update failed — " + ex.Message); }
                    }
                }
                catch (OperationCanceledException) { throw; }
                catch { /* offline or sign-in required: try again next time */ }
            }
            return log;
        }
    }
}
