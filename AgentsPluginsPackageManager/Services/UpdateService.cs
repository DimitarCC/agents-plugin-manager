using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using AgentsPluginsPackageManager.Models;

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

    /// <summary>An item that exists at a destination but is not listed in any lock entry.</summary>
    public sealed class PresenceItem
    {
        public ComponentKind Kind { get; set; }
        public string Name { get; set; } = "";
        /// <summary>"same", "differs" or "present" (MCP server).</summary>
        public string State { get; set; } = "";
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

        private static List<PluginComponent> Matching(PluginPackage pkg, InstallRecord r) =>
            pkg.Components.Where(c => c.Installable &&
                r.Components.Any(ic => ic.Kind == c.Kind && string.Equals(ic.Name, c.Name, StringComparison.OrdinalIgnoreCase))).ToList();

        /// <summary>Finds updates for installed records belonging to the given source (by source key).</summary>
        public static List<UpdateInfo> FindUpdates(IEnumerable<PluginPackage> packages, string sourceKey, IEnumerable<InstallRecord> records)
        {
            var result = new List<UpdateInfo>();
            var byName = packages.GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
            foreach (var r in records.Where(r => r.SourceKey == sourceKey))
            {
                if (!byName.TryGetValue(r.PackageName, out var pkg)) continue;
                var comps = Matching(pkg, r);
                if (comps.Count == 0) continue;
                if (IsUpdateAvailable(r, pkg, ContentHash.Fingerprint(pkg, comps)))
                    result.Add(new UpdateInfo { Record = r, Package = pkg, Components = comps });
            }
            return result;
        }

        /// <summary>Applies per-package install state (installed / update available) to the list shown in the UI.</summary>
        public static void Annotate(IEnumerable<PluginPackage> packages, string sourceKey, IEnumerable<InstallRecord> records)
        {
            var recs = records.Where(r => r.SourceKey == sourceKey).ToList();
            var pkgs = packages.ToList();
            var updates = FindUpdates(pkgs, sourceKey, recs);
            foreach (var p in pkgs)
            {
                var mine = recs.Where(r => string.Equals(r.PackageName, p.Name, StringComparison.OrdinalIgnoreCase)).ToList();
                if (mine.Count == 0) { p.SetInstallState("", false, ""); continue; }
                var summary = "Installed " + string.Join(", ", mine.Select(r =>
                    (string.IsNullOrEmpty(r.Version) ? "" : "v" + r.Version + " ") + "(" + r.Where + ")"));
                var ups = updates.Where(u => ReferenceEquals(u.Package, p)).ToList();
                p.SetInstallState(summary, ups.Count > 0, ups.Count == 0 ? "" : ups[0].FromVersion + " → " + ups[0].ToVersion);
            }
        }

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
            Record(u.Package, new SourceInfo { Key = r.SourceKey, Kind = r.SourceKind, Location = r.SourceLocation, Ref = r.Ref },
                r.Scope, r.RepoRoot, r.Layout, res.InstalledComponents, replace: true);
            return res;
        }

        /// <summary>Remembers an install. Merges with earlier installs of the same package/target unless replacing.</summary>
        public static void Record(PluginPackage pkg, SourceInfo source, InstallScope scope, string? repoRoot, ClientLayout layout,
            IEnumerable<PluginComponent> installed, bool replace = false)
        {
            var key = InstallRecord.MakeKey(source.Key, pkg.Name, scope, repoRoot, layout);
            var existing = LockStore.Load(scope, repoRoot).FirstOrDefault(r => r.Key == key);
            var items = existing != null && !replace ? existing.Components.ToList() : new List<InstalledComponent>();
            foreach (var c in installed)
                if (!items.Any(i => i.Kind == c.Kind && string.Equals(i.Name, c.Name, StringComparison.OrdinalIgnoreCase)))
                    items.Add(new InstalledComponent { Kind = c.Kind, Name = c.Name });
            if (items.Count == 0) return;
            var rec = new InstallRecord
            {
                PackageName = pkg.Name, SourceKey = source.Key, SourceKind = source.Kind, SourceLocation = source.Location, Ref = source.Ref,
                Scope = scope, RepoRoot = scope == InstallScope.Repository ? repoRoot : null, Layout = layout,
                Components = items, Version = pkg.Version ?? "", InstalledBy = SettingsStore.ToolName,
            };
            rec.Fingerprint = ContentHash.Fingerprint(pkg, Matching(pkg, rec));
            LockStore.Upsert(rec);
        }

        // ───────── items that exist but are not tracked ─────────

        /// <summary>Items of the package that exist at the destination but are not listed in <paramref name="tracked"/>.</summary>
        public static List<PresenceItem> UntrackedPresence(PluginPackage pkg, InstallRecord? tracked, InstallScope scope, ClientLayout layout, string? repoRoot)
        {
            var found = new List<PresenceItem>();
            foreach (var c in pkg.Components)
            {
                if (!c.Installable) continue;
                if (tracked != null && tracked.Components.Any(t => t.Kind == c.Kind && string.Equals(t.Name, c.Name, StringComparison.OrdinalIgnoreCase))) continue;
                var state = PluginInstaller.PresenceOf(pkg, c, scope, layout, repoRoot);
                if (state.Length > 0) found.Add(new PresenceItem { Kind = c.Kind, Name = c.Name, State = state });
            }
            return found;
        }

        /// <summary>
        /// Starts tracking untracked items. Identical items get the package version; items that differ are recorded with an
        /// empty version when the record is new, so the next update replaces them.
        /// </summary>
        public static int TrackPresent(PluginPackage pkg, SourceInfo source, InstallScope scope, string? repoRoot, ClientLayout layout)
        {
            var key = InstallRecord.MakeKey(source.Key, pkg.Name, scope, repoRoot, layout);
            var existing = LockStore.Load(scope, repoRoot).FirstOrDefault(r => r.Key == key);
            var found = UntrackedPresence(pkg, existing, scope, layout, repoRoot);
            if (found.Count == 0) return 0;

            var anyDiffers = found.Any(f => f.State == "differs");
            var rec = existing ?? new InstallRecord
            {
                PackageName = pkg.Name, SourceKey = source.Key, SourceKind = source.Kind, SourceLocation = source.Location, Ref = source.Ref,
                Scope = scope, RepoRoot = scope == InstallScope.Repository ? repoRoot : null, Layout = layout,
                Version = anyDiffers ? "" : pkg.Version ?? "",
            };
            rec.Components.AddRange(found.Select(f => new InstalledComponent { Kind = f.Kind, Name = f.Name }));
            rec.InstalledBy = SettingsStore.ToolName;
            rec.InstalledUtc = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
            if (existing == null) rec.Fingerprint = anyDiffers ? "" : ContentHash.Fingerprint(pkg, Matching(pkg, rec));
            LockStore.Upsert(rec);
            return found.Count;
        }

        // ───────── background run (VS startup) ─────────

        /// <summary>Checks every source that has installed packages and applies available updates without prompting.</summary>
        public static async Task<List<string>> RunAutoUpdateAsync(Settings settings, CancellationToken ct)
        {
            var log = new List<string>();
            LockStore.MigrateLegacy(settings.Sources);
            var records = LockStore.LoadAll(null);
            foreach (var src in settings.Sources.Where(s => records.Any(r => r.SourceKey == SourceKey.Of(s))))
            {
                try
                {
                    var root = await SourceSync.SyncAsync(src, null, ct, interactive: false).ConfigureAwait(false);
                    var pkgs = PluginScanner.Discover(root);
                    foreach (var u in FindUpdates(pkgs, SourceKey.Of(src), LockStore.LoadAll(null)))
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
