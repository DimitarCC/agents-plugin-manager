using System;
using System.Text.RegularExpressions;
using AgentsPluginsPackageManager.Models;

namespace AgentsPluginsPackageManager.Services
{
    /// <summary>
    /// Identifies a source independent of how it was typed or which tool added it (see docs/plugin-lock.md, "Source key").
    /// The VS Code edition implements the same algorithm; shared/test-vectors.json is tested by both.
    /// </summary>
    public static class SourceKey
    {
        private static readonly Regex Shorthand = new Regex(@"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", RegexOptions.Compiled);
        private static readonly Regex Scp = new Regex(@"^[A-Za-z0-9_.-]+@([^:/]+):(.+)$", RegexOptions.Compiled);
        private static readonly Regex Scheme = new Regex(@"^[A-Za-z][A-Za-z0-9+.-]*://", RegexOptions.Compiled);

        public static string Of(PluginSource source) => source.Kind == SourceKind.Local ? Local(source.Location) : Git(source.Location);

        public static string Git(string location)
        {
            var l = location.Trim();
            string host, path;
            Match m;
            if (Shorthand.IsMatch(l))
            {
                host = "github.com";
                path = l;
            }
            else if (!Scheme.IsMatch(l) && (m = Scp.Match(l)).Success)
            {
                host = m.Groups[1].Value;
                path = m.Groups[2].Value;
            }
            else
            {
                var rest = Scheme.Replace(l, "");
                int slash = rest.IndexOf('/');
                var authority = slash < 0 ? rest : rest.Substring(0, slash);
                path = slash < 0 ? "" : rest.Substring(slash + 1);
                int at = authority.LastIndexOf('@');
                if (at >= 0) authority = authority.Substring(at + 1);
                host = Regex.Replace(authority, @":\d+$", "");
            }

            int cut = path.IndexOfAny(new[] { '?', '#' });
            if (cut >= 0) path = path.Substring(0, cut);
            path = path.Trim('/');
            if (path.EndsWith(".git", StringComparison.OrdinalIgnoreCase)) path = path.Substring(0, path.Length - 4);
            return host.ToLowerInvariant() + (path.Length > 0 ? "/" + path.ToLowerInvariant() : "");
        }

        public static string Local(string location)
        {
            var p = location.Trim().Replace('\\', '/').TrimEnd('/');
            if (Regex.IsMatch(p, "^[A-Za-z]:") || p.StartsWith("//", StringComparison.Ordinal)) p = p.ToLowerInvariant();
            return "file:" + p;
        }

        public static SourceInfo InfoOf(PluginSource s) => new SourceInfo
        {
            Key = Of(s),
            Kind = s.Kind == SourceKind.Local ? "local" : "git",
            Location = s.Location,
            Ref = s.Ref ?? "",
        };
    }
}
