using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using AgentsPluginsPackageManager.Models;

namespace AgentsPluginsPackageManager.Services
{
    public sealed class GitException : Exception
    {
        public GitException(string message) : base(message) { }
    }

    /// <summary>
    /// Materialises a <see cref="PluginSource"/> on disk. Git sources are cloned with the user's git,
    /// so enterprise SSO works through Git Credential Manager (browser / Entra ID sign-in), or via a
    /// personal access token that is passed through the environment (never on the command line).
    /// </summary>
    public static class SourceSync
    {
        private static readonly Regex ShorthandRegex = new Regex(@"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", RegexOptions.Compiled);

        public static string NormalizeGitUrl(string location)
        {
            location = location.Trim();
            if (ShorthandRegex.IsMatch(location) && !Directory.Exists(location))
                return "https://github.com/" + location + (location.EndsWith(".git", StringComparison.OrdinalIgnoreCase) ? "" : ".git");
            return location;
        }

        /// <summary>Returns the local folder that holds the source's files (cloning / updating if needed).</summary>
        public static async Task<string> SyncAsync(PluginSource source, IProgress<string>? progress, CancellationToken ct, bool interactive = true)
        {
            if (source.Kind == SourceKind.Local)
            {
                if (!Directory.Exists(source.Location))
                    throw new GitException("Folder not found: " + source.Location);
                return source.Location;
            }

            var url = NormalizeGitUrl(source.Location);
            var dir = Path.Combine(SettingsStore.CacheRoot, Hash(url + "|" + source.Ref));
            Directory.CreateDirectory(SettingsStore.CacheRoot);
            var git = new GitRunner(source, url, interactive);

            if (Directory.Exists(Path.Combine(dir, ".git")))
            {
                progress?.Report("Updating " + source.DisplayName + "…");
                var target = string.IsNullOrWhiteSpace(source.Ref) ? "HEAD" : source.Ref.Trim();
                await git.RunAsync(new[] { "-C", dir, "fetch", "--depth", "1", "origin", target }, ct).ConfigureAwait(false);
                await git.RunAsync(new[] { "-C", dir, "reset", "--hard", "FETCH_HEAD" }, ct).ConfigureAwait(false);
                await git.RunAsync(new[] { "-C", dir, "clean", "-fdx" }, ct).ConfigureAwait(false);
                return dir;
            }

            if (Directory.Exists(dir)) ForceDelete(dir);
            progress?.Report("Cloning " + source.DisplayName + " (sign-in may open a browser window)…");
            if (string.IsNullOrWhiteSpace(source.Ref))
            {
                await git.RunAsync(new[] { "clone", "--depth", "1", "--", url, dir }, ct).ConfigureAwait(false);
            }
            else
            {
                try
                {
                    await git.RunAsync(new[] { "clone", "--depth", "1", "--branch", source.Ref.Trim(), "--", url, dir }, ct).ConfigureAwait(false);
                }
                catch (GitException)
                {
                    // Ref may be a commit SHA: clone default branch, then fetch the ref explicitly.
                    if (Directory.Exists(dir)) ForceDelete(dir);
                    await git.RunAsync(new[] { "clone", "--depth", "1", "--", url, dir }, ct).ConfigureAwait(false);
                    await git.RunAsync(new[] { "-C", dir, "fetch", "--depth", "1", "origin", source.Ref.Trim() }, ct).ConfigureAwait(false);
                    await git.RunAsync(new[] { "-C", dir, "checkout", "--detach", "FETCH_HEAD" }, ct).ConfigureAwait(false);
                }
            }
            return dir;
        }

        /// <summary>Cheap connectivity/auth check (also triggers interactive SSO sign-in once).</summary>
        public static async Task TestAsync(PluginSource source, CancellationToken ct)
        {
            if (source.Kind == SourceKind.Local)
            {
                if (!Directory.Exists(source.Location)) throw new GitException("Folder not found.");
                return;
            }
            var url = NormalizeGitUrl(source.Location);
            await new GitRunner(source, url).RunAsync(new[] { "ls-remote", "--exit-code", "--", url, "HEAD" }, ct).ConfigureAwait(false);
        }

        private static string Hash(string s)
        {
            using (var sha = SHA1.Create())
            {
                var b = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                var sb = new StringBuilder();
                for (int i = 0; i < 8; i++) sb.Append(b[i].ToString("x2"));
                return sb.ToString();
            }
        }

        internal static void ForceDelete(string dir)
        {
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { File.SetAttributes(f, FileAttributes.Normal); } catch { }
            }
            Directory.Delete(dir, true);
        }

        private sealed class GitRunner
        {
            private readonly PluginSource _source;
            private readonly Uri? _uri;
            private readonly bool _interactive;

            public GitRunner(PluginSource source, string url, bool interactive = true)
            {
                _source = source;
                _interactive = interactive;
                Uri.TryCreate(url, UriKind.Absolute, out _uri);
            }

            public async Task RunAsync(IEnumerable<string> args, CancellationToken ct)
            {
                var psi = new ProcessStartInfo(FindGit())
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };
                var sb = new StringBuilder();
                foreach (var a in args) { if (sb.Length > 0) sb.Append(' '); sb.Append(Quote(a)); }
                psi.Arguments = sb.ToString();

                // No console exists in-proc: never let git wait on a terminal prompt.
                psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
                // Git Credential Manager may show its own GUI/browser window for SSO.
                psi.EnvironmentVariables["GCM_INTERACTIVE"] = _interactive && _source.Auth == AuthMode.SingleSignOn ? "true" : "false";

                if (_source.Auth == AuthMode.PersonalAccessToken && _uri != null)
                {
                    var token = _source.GetToken();
                    if (!string.IsNullOrEmpty(token))
                    {
                        // Token travels via environment config, so it never appears in a command line or log.
                        var host = _uri.Host.ToLowerInvariant();
                        var azure = host.EndsWith("dev.azure.com") || host.EndsWith(".visualstudio.com");
                        var user = azure ? "" : "x-access-token";
                        var basic = Convert.ToBase64String(Encoding.UTF8.GetBytes(user + ":" + token));
                        psi.EnvironmentVariables["GIT_CONFIG_COUNT"] = "2";
                        psi.EnvironmentVariables["GIT_CONFIG_KEY_0"] = "http." + _uri.GetLeftPart(UriPartial.Authority) + "/.extraheader";
                        psi.EnvironmentVariables["GIT_CONFIG_VALUE_0"] = "Authorization: Basic " + basic;
                        psi.EnvironmentVariables["GIT_CONFIG_KEY_1"] = "credential.helper";
                        psi.EnvironmentVariables["GIT_CONFIG_VALUE_1"] = "";
                    }
                }

                using (var p = new Process { StartInfo = psi, EnableRaisingEvents = true })
                {
                    var err = new StringBuilder();
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (err) err.AppendLine(e.Data); };
                    p.OutputDataReceived += (s, e) => { };
                    try { p.Start(); }
                    catch (Exception ex)
                    {
                        throw new GitException("Could not start git (" + ex.Message + "). Install Git for Windows or the Visual Studio Git component.");
                    }
                    p.BeginErrorReadLine();
                    p.BeginOutputReadLine();
                    using (ct.Register(() => { try { if (!p.HasExited) p.Kill(); } catch { } }))
                    {
                        await Task.Run(() => p.WaitForExit()).ConfigureAwait(false);
                    }
                    ct.ThrowIfCancellationRequested();
                    if (p.ExitCode != 0)
                    {
                        string text; lock (err) text = err.ToString().Trim();
                        throw new GitException(Friendly(text));
                    }
                }
            }

            private static string Friendly(string text)
            {
                if (text.IndexOf("SAML", StringComparison.OrdinalIgnoreCase) >= 0 || text.IndexOf("SSO", StringComparison.OrdinalIgnoreCase) >= 0)
                    return text + "\n\nThe organization enforces SSO: choose 'Single sign-on' authentication, or authorize your token for the organization (GitHub: Settings › Tokens › Configure SSO).";
                if (text.IndexOf("Authentication failed", StringComparison.OrdinalIgnoreCase) >= 0
                    || text.IndexOf("could not read Username", StringComparison.OrdinalIgnoreCase) >= 0
                    || text.IndexOf("terminal prompts disabled", StringComparison.OrdinalIgnoreCase) >= 0)
                    return text + "\n\nAuthentication required. Use 'Single sign-on' (Git Credential Manager) or provide a personal access token.";
                return text.Length == 0 ? "git failed." : text;
            }

            private static string Quote(string a)
            {
                if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
                return "\"" + a.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            }

            private static string? _git;
            private static string FindGit()
            {
                if (_git != null) return _git;
                var candidates = new List<string>();
                var path = Environment.GetEnvironmentVariable("PATH") ?? "";
                foreach (var d in path.Split(Path.PathSeparator))
                {
                    try { if (!string.IsNullOrWhiteSpace(d)) candidates.Add(Path.Combine(d.Trim(), "git.exe")); } catch { }
                }
                var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                candidates.Add(Path.Combine(pf, "Git", "cmd", "git.exe"));
                try
                {
                    var ide = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
                    candidates.Add(Path.Combine(ide, "CommonExtensions", "Microsoft", "TeamFoundation", "Team Explorer", "Git", "cmd", "git.exe"));
                }
                catch { }
                foreach (var c in candidates)
                    if (File.Exists(c)) return _git = c;
                return _git = "git";
            }
        }
    }
}
