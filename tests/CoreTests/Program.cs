using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AgentsPluginsPackageManager.Models;
using AgentsPluginsPackageManager.Services;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AgentsPluginsPackageManager.CoreTests
{
    /// <summary>
    /// Tests of the UI-independent code. Uses temp folders only: AGENTPLUGINS_HOME and AGENTPLUGINS_DATA_DIR redirect the
    /// home folder (user-scope lock file, user folders) and the tool's data folder.
    /// </summary>
    internal static class Program
    {
        private static int _pass, _fail;
        private static string _tmp = "";
        private static string _examples = "";
        private static string _shared = "";

        private static void Check(bool ok, string what)
        {
            if (ok) _pass++; else _fail++;
            Console.WriteLine((ok ? "  PASS  " : "  FAIL  ") + what);
        }

        private static void Section(string name) => Console.WriteLine("\n[" + name + "]");

        private static int Main()
        {
            _tmp = Path.Combine(Path.GetTempPath(), "apm-cs-test-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(_tmp);
            Environment.SetEnvironmentVariable("AGENTPLUGINS_HOME", Path.Combine(_tmp, "home"));
            Environment.SetEnvironmentVariable("AGENTPLUGINS_DATA_DIR", Path.Combine(_tmp, "data"));
            _shared = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "shared");
            try
            {
                BuildExamples();
                RunAsync().GetAwaiter().GetResult();
            }
            catch (Exception ex) { Console.WriteLine("CRASH: " + ex); _fail++; }
            finally { try { ForceDelete(_tmp); } catch { } }
            Console.WriteLine("\n==== " + _pass + " passed, " + _fail + " failed ====");
            return _fail == 0 ? 0 : 1;
        }

        // ───────── fixtures ─────────

        private static void Write(string file, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, text);
        }

        private static void Git(string cwd, params string[] args)
        {
            var psi = new ProcessStartInfo("git") { WorkingDirectory = cwd, UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            var all = new List<string> { "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false" };
            all.AddRange(args);
            psi.Arguments = string.Join(" ", all.Select(a => a.IndexOf(' ') >= 0 ? "\"" + a + "\"" : a));
            using (var p = Process.Start(psi)!)
            {
                p.StandardOutput.ReadToEnd(); var err = p.StandardError.ReadToEnd(); p.WaitForExit();
                if (p.ExitCode != 0) throw new Exception("git " + psi.Arguments + ": " + err);
            }
        }

        private static string Manifest(string name, string version, string description) =>
            new JObject { ["$schema"] = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ["name"] = name, ["version"] = version,
                          ["description"] = description, ["author"] = new JObject { ["name"] = "Tester" }, ["license"] = "MIT" }.ToString();

        private static void BuildExamples()
        {
            _examples = Path.Combine(_tmp, "examples");
            var crk = Path.Combine(_examples, "code-review-kit");
            Write(Path.Combine(crk, "plugin.json"), Manifest("code-review-kit", "1.3.0", "Review kit"));
            Write(Path.Combine(crk, "skills", "review-checklist", "SKILL.md"), "---\nname: review-checklist\ndescription: Use when reviewing a diff.\n---\n# Review\n6. Performance\n");
            Write(Path.Combine(crk, "skills", "commit-message", "SKILL.md"), "---\nname: commit-message\ndescription: >\n  Use when asked to write\n  a commit message.\n---\nBody\n");
            Write(Path.Combine(crk, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Read-only reviewer.\n---\nYou review.\n");
            Write(Path.Combine(crk, "prompts", "explain-code.md"), "---\ndescription: Explain code.\n---\nExplain.\n");
            var mcp = Path.Combine(_examples, "mcp-demo");
            Write(Path.Combine(mcp, "plugin.json"), Manifest("mcp-demo", "0.1.0", "MCP demo"));
            Write(Path.Combine(mcp, "mcp.json"), new JObject
            {
                ["mcpServers"] = new JObject
                {
                    ["local-echo"] = new JObject { ["type"] = "stdio", ["command"] = "./server/echo.cmd", ["args"] = new JArray("--data", "${PLUGIN_DATA}"), ["env"] = new JObject { ["DEMO_TOKEN"] = "secret" } },
                    ["remote-demo"] = new JObject { ["type"] = "streamable-http", ["url"] = "https://example.com/mcp", ["when"] = "2026-01-01T00:00:00Z" },
                },
            }.ToString());
            Write(Path.Combine(mcp, "server", "echo.cmd"), "@echo off\n");
            Git(_examples, "init", "-q", "-b", "main");
            Git(_examples, "add", "-A");
            Git(_examples, "commit", "-q", "-m", "v1.3.0");
            Git(_examples, "tag", "v1.3.0");
            // 1.4.0: changes an installed item, adds a NEW prompt
            Write(Path.Combine(crk, "plugin.json"), Manifest("code-review-kit", "1.4.0", "Review kit with verdicts"));
            Write(Path.Combine(crk, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Read-only reviewer.\n---\nYou review.\nFinish with a verdict.\n");
            Write(Path.Combine(crk, "prompts", "write-tests.md"), "---\ndescription: Write tests.\n---\nTests.\n");
            Git(_examples, "add", "-A");
            Git(_examples, "commit", "-q", "-m", "v1.4.0");
        }

        private static void ForceDelete(string dir)
        {
            foreach (var f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)) { try { File.SetAttributes(f, FileAttributes.Normal); } catch { } }
            Directory.Delete(dir, true);
        }

        private static string Repo(string name)
        {
            var d = Path.Combine(_tmp, name);
            Directory.CreateDirectory(d);
            return d;
        }

        private static string Lf(string s) => s.Replace("\r\n", "\n");

        // ───────── tests ─────────

        private static async Task RunAsync()
        {
            var vectors = JObject.Parse(File.ReadAllText(Path.Combine(_shared, "test-vectors.json")));

            Section("shared vectors (same expectations as the VS Code edition)");
            foreach (var v in (JArray)vectors["sourceKeys"]!)
            {
                var kind = (string)v["kind"]! == "local" ? SourceKind.Local : SourceKind.Git;
                var key = SourceKey.Of(new PluginSource { Kind = kind, Location = (string)v["input"]! });
                Check(key == (string)v["key"]!, "source key: " + (string)v["input"]! + " → " + key);
            }
            foreach (var v in (JArray)vectors["canonicalJson"]!)
                Check(ContentHash.Canonical(v["input"]) == (string)v["output"]!, "canonical JSON");

            var fixture = (JObject)vectors["fixture"]!;
            var fxPkg = new PluginPackage { Name = "sample", RootPath = Path.Combine(_shared, "fixtures", "sample-plugin") };
            foreach (var c in (JArray)fixture["components"]!)
            {
                var kind = LockFormat.ParseKind((string)c["kind"]!);
                fxPkg.Components.Add(new PluginComponent
                {
                    Kind = kind, Name = (string)c["name"]!, RelativePath = (string?)c["path"] ?? "", IsDirectory = (bool?)c["isDirectory"] ?? false,
                    McpDefinition = c["definition"] as JObject,
                });
            }
            var fp = ContentHash.Fingerprint(fxPkg, fxPkg.Components);
            Check(fp == (string)fixture["fingerprint"]!, "fingerprint of the sample plugin equals the golden value (" + fp + ")");
            Check(ContentHash.Fingerprint(fxPkg, fxPkg.Components.AsEnumerable().Reverse()) == fp, "fingerprint ignores component order");

            Section("client namespace folders (com.github.copilot/agents, rules, …)");
            var samplePkg = PluginScanner.Discover(Path.Combine(_shared, "fixtures", "sample-plugin"))[0];
            Func<string, string?, string, string, bool, string> fmt = (kind, name, p, client, inst) => kind + ":" + name + ":" + p + ":" + client + ":" + inst;
            var actualScan = samplePkg.Components.Where(c => c.Kind != ComponentKind.Hook)
                .Select(c => fmt(LockFormat.KindToString(c.Kind), c.Name, c.RelativePath, c.Client ?? "", c.Installable)).OrderBy(s => s, StringComparer.Ordinal).ToList();
            var expectedScan = ((JArray)vectors["scan"]!["components"]!)
                .Select(c => fmt((string)c["kind"]!, (string)c["name"]!, (string)c["path"]!, (string?)c["client"] ?? "", (bool)c["installable"]!)).OrderBy(s => s, StringComparer.Ordinal).ToList();
            Check(actualScan.SequenceEqual(expectedScan), "scan of the sample plugin equals the shared expectation (" + actualScan.Count + " items)");
            if (!actualScan.SequenceEqual(expectedScan)) { Console.WriteLine("    actual:   " + string.Join(" | ", actualScan)); Console.WriteLine("    expected: " + string.Join(" | ", expectedScan)); }
            Check(samplePkg.Warnings.Any(w => w.Contains("com.example.client") && w.Contains("not recognised")), "unknown client namespace is reported");

            Func<ClientLayout, string, PluginInstaller_Result> installSample = (layout, repoName) =>
            {
                var root = Repo(repoName);
                var r = PluginInstaller.Install(new InstallRequest { Package = samplePkg, Components = samplePkg.Components.Where(c => c.Installable).ToList(), Scope = InstallScope.Repository, Layout = layout, RepoRoot = root });
                return new PluginInstaller_Result { Root = root, Result = r };
            };
            var nsCopilot = installSample(ClientLayout.Copilot, "ns-copilot");
            Check(File.Exists(Path.Combine(nsCopilot.Root, ".github", "agents", "pilot.agent.md")), "Copilot agent from com.github.copilot/agents installed");
            Check(File.Exists(Path.Combine(nsCopilot.Root, ".github", "instructions", "style.instructions.md")), "Copilot rule → .github/instructions/*.instructions.md");
            Check(File.Exists(Path.Combine(nsCopilot.Root, ".github", "agents", "helper.agent.md")), "portable agent installs too");
            Check(!Directory.Exists(Path.Combine(nsCopilot.Root, ".claude")), "nothing Claude-specific written");
            var skippedText = string.Join("\n", nsCopilot.Result.Skipped);
            Check(skippedText.Contains("ship") && skippedText.Contains("tone") && skippedText.Contains("made for Claude Code"), "Claude items skipped with an explanation");
            var nsClaude = installSample(ClientLayout.Claude, "ns-claude");
            Check(File.Exists(Path.Combine(nsClaude.Root, ".claude", "commands", "ship.md")) && File.Exists(Path.Combine(nsClaude.Root, ".claude", "rules", "tone.md")), "Claude command and rule installed (.claude/commands, .claude/rules)");
            Check(!Directory.Exists(Path.Combine(nsClaude.Root, ".github")), "nothing Copilot-specific written");
            var nsNeutral = installSample(ClientLayout.AgentsNeutral, "ns-neutral");
            Check(nsNeutral.Result.InstalledComponents.All(c => c.Kind == ComponentKind.Skill), "agent-neutral layout only takes skills");
            var styleC = samplePkg.Components.First(c => c.Name == "style");
            var toneC = samplePkg.Components.First(c => c.Name == "tone");
            Check(PluginInstaller.PresenceOf(samplePkg, styleC, InstallScope.Repository, ClientLayout.Copilot, nsCopilot.Root) == "same", "installed rule is present and identical");
            Check(PluginInstaller.PresenceOf(samplePkg, toneC, InstallScope.Repository, ClientLayout.Copilot, nsCopilot.Root) == "", "a Claude rule is never 'present' for Copilot");
            var oddC = samplePkg.Components.First(c => c.Name == "odd");
            Check(!oddC.Installable && PluginInstaller.Install(new InstallRequest { Package = samplePkg, Components = new List<PluginComponent> { oddC }, Scope = InstallScope.Repository, Layout = ClientLayout.Copilot, RepoRoot = Repo("ns-odd") }).InstalledComponents.Count == 0, "unknown client's items are never installed");
            var ruleRec = new InstallRecord { PackageName = "p", SourceKey = "s", Scope = InstallScope.Repository, RepoRoot = nsCopilot.Root, Layout = ClientLayout.Copilot, Components = new List<InstalledComponent> { new InstalledComponent { Kind = ComponentKind.Rule, Name = "style" } } };
            Check(PluginInstaller.Uninstall(ruleRec, ruleRec.Components).RemovedComponents.Count == 1 && !File.Exists(Path.Combine(nsCopilot.Root, ".github", "instructions", "style.instructions.md")), "rule uninstalls");
            var dupDir = Path.Combine(_tmp, "dup-plugin");
            Write(Path.Combine(dupDir, "plugin.json"), Manifest("dup", "1.0.0", "x"));
            Write(Path.Combine(dupDir, "agents", "same.md"), "---\ndescription: portable\n---\n");
            Write(Path.Combine(dupDir, "com.github.copilot", "agents", "same.md"), "---\ndescription: copilot\n---\n");
            var dupPkg = PluginScanner.Discover(dupDir)[0];
            Check(dupPkg.Components.Count(c => c.Name == "same") == 1 && dupPkg.Warnings.Any(w => w.Contains("more than once")), "duplicate names are reported once");

            Section("lock file: golden file written by the TypeScript edition");
            var golden = Lf(File.ReadAllText(Path.Combine(_shared, "fixtures", "plugin-lock.sample.json"), Encoding.UTF8));
            var gRepo = Repo("golden-repo");
            Write(Path.Combine(gRepo, ".agents", "plugin-lock.json"), golden);
            var recs = LockStore.Load(InstallScope.Repository, gRepo);
            Check(recs.Count == 3, "3 records read");
            Check(recs[2].SourceLocation == "E:\\Plugins\\café" && recs[2].Components[0].Kind == ComponentKind.McpServer, "backslashes, accents and kinds parsed");
            Check(recs[0].Layout == ClientLayout.Claude && recs[1].Layout == ClientLayout.Copilot, "layouts parsed");
            LockStore.Upsert(recs[0]);
            var rewritten = File.ReadAllText(Path.Combine(gRepo, ".agents", "plugin-lock.json"), Encoding.UTF8);
            Check(rewritten == golden, "rewriting an unchanged record leaves the file byte-for-byte identical");
            Check(!rewritten.Contains("\r") && File.ReadAllBytes(Path.Combine(gRepo, ".agents", "plugin-lock.json")).Take(3).SequenceEqual(new byte[] { 0x7B, 0x0A, 0x20 }), "LF endings, no BOM");

            Section("scan, install, track-on-install, uninstall");
            var pkgs = PluginScanner.Discover(_examples);
            Check(pkgs.Count == 2 && pkgs[0].Name == "code-review-kit" && pkgs[0].Version == "1.4.0", "packages found, HEAD is 1.4.0");
            var crk = pkgs[0];
            var mcpPkg = pkgs[1];
            Check(mcpPkg.Components.First(c => c.Name == "remote-demo").McpDefinition!["when"]!.Type == JTokenType.String, "date-like strings in mcp.json stay strings");

            var repo1 = Repo("repo1");
            var pick = crk.Components.Where(c => c.Name == "review-checklist" || c.Name == "reviewer" || c.Name == "explain-code").ToList();
            var res = PluginInstaller.Install(new InstallRequest { Package = crk, Components = pick, Scope = InstallScope.Repository, Layout = ClientLayout.Copilot, RepoRoot = repo1 });
            Check(res.InstalledComponents.Count == 3 && File.Exists(Path.Combine(repo1, ".github", "agents", "reviewer.agent.md")), "3 items installed (Copilot layout)");
            var again = PluginInstaller.Install(new InstallRequest { Package = crk, Components = pick, Scope = InstallScope.Repository, Layout = ClientLayout.Copilot, RepoRoot = repo1 });
            Check(again.Skipped.Count == 0 && again.InstalledComponents.Count == 3 && again.Installed[0].Contains("already up to date"), "identical items already there are tracked, not skipped");
            File.AppendAllText(Path.Combine(repo1, ".github", "agents", "reviewer.agent.md"), "local edit\n");
            var third = PluginInstaller.Install(new InstallRequest { Package = crk, Components = pick, Scope = InstallScope.Repository, Layout = ClientLayout.Copilot, RepoRoot = repo1 });
            Check(third.Skipped.Count == 1 && third.Skipped[0].Contains("differs"), "a modified item is skipped with an explanation");

            var rec1 = new InstallRecord { PackageName = crk.Name, SourceKey = "s", Scope = InstallScope.Repository, RepoRoot = repo1, Layout = ClientLayout.Copilot,
                Components = res.InstalledComponents.Select(c => new InstalledComponent { Kind = c.Kind, Name = c.Name }).ToList() };
            var un = PluginInstaller.Uninstall(rec1, rec1.Components);
            Check(un.RemovedComponents.Count == 3 && !Directory.Exists(Path.Combine(repo1, ".github", "skills", "review-checklist")), "uninstall removes the files");

            Section("MCP servers");
            var repo2 = Repo("repo2");
            var servers = mcpPkg.Components.Where(c => c.Kind == ComponentKind.McpServer).ToList();
            var r2 = PluginInstaller.Install(new InstallRequest { Package = mcpPkg, Components = servers, Scope = InstallScope.Repository, Layout = ClientLayout.Copilot, RepoRoot = repo2 });
            var mcpDoc = Json.ParseObject(File.ReadAllText(Path.Combine(repo2, ".mcp.json")))!;
            var secs = (JObject)mcpDoc["servers"]!;
            Check((string?)secs["remote-demo"]!["type"] == "http", "streamable-http mapped to http");
            Check(((string?)secs["remote-demo"]!["when"]) == "2026-01-01T00:00:00Z", "date-like string written back unchanged");
            var cmd = (string)secs["local-echo"]!["command"]!;
            Check(Path.IsPathRooted(cmd) && File.Exists(cmd), "bundled script copied, path resolved");
            Check(PluginInstaller.PresenceOf(mcpPkg, servers[0], InstallScope.Repository, ClientLayout.Copilot, repo2) == "present", "MCP server reported as present");

            Section("sharing between editions (same lock file)");
            var repo3 = Repo("repo3");
            var oldCheckout = Path.Combine(_tmp, "checkout-1.3.0");
            Git(_tmp, "clone", "-q", "--branch", "v1.3.0", _examples, oldCheckout);
            var oldPkg = PluginScanner.Discover(oldCheckout).First(p => p.Name == "code-review-kit");
            var info = SourceKey.InfoOf(new PluginSource { Kind = SourceKind.Local, Location = _examples });
            var r3 = PluginInstaller.Install(new InstallRequest { Package = oldPkg, Components = oldPkg.Components.Where(c => c.Name == "reviewer").ToList(), Scope = InstallScope.Repository, Layout = ClientLayout.Copilot, RepoRoot = repo3 });
            UpdateService.Record(oldPkg, info, InstallScope.Repository, repo3, ClientLayout.Copilot, r3.InstalledComponents);
            var lockFile = Path.Combine(repo3, ".agents", "plugin-lock.json");
            Check(File.Exists(lockFile), "lock file written into the repository");
            var lockDoc = JObject.Parse(File.ReadAllText(lockFile));
            Check((string?)lockDoc["installs"]![0]!["installedBy"] == SettingsStore.ToolName && SettingsStore.ToolName.StartsWith("visual-studio "), "installedBy stamped: " + SettingsStore.ToolName);
            // another edition rewrites the entry (simulated by editing the file the way the VS Code edition would)
            var other = Lf(File.ReadAllText(lockFile)).Replace(SettingsStore.ToolName, "vscode 1.1.0");
            File.WriteAllText(lockFile, other);
            var seen = LockStore.Load(InstallScope.Repository, repo3);
            Check(seen.Count == 1 && seen[0].InstalledBy == "vscode 1.1.0" && seen[0].Version == "1.3.0", "records written by the other edition are read");

            Section("updates");
            var newPkgs = PluginScanner.Discover(_examples);
            var ups = UpdateService.FindUpdates(newPkgs, info.Key, seen);
            Check(ups.Count == 1 && ups[0].FromVersion == "v1.3.0" && ups[0].ToVersion == "v1.4.0" && ups[0].Components.Count == 1, "update 1.3.0 → 1.4.0 targets only the installed item");
            UpdateService.Annotate(newPkgs, info.Key, seen);
            Check(newPkgs[0].HasUpdate && newPkgs[0].InstalledSummary.StartsWith("Installed v1.3.0"), "package annotated for the UI");
            UpdateService.Apply(ups[0]);
            Check(File.ReadAllText(Path.Combine(repo3, ".github", "agents", "reviewer.agent.md")).Contains("verdict"), "agent updated");
            Check(!File.Exists(Path.Combine(repo3, ".github", "prompts", "write-tests.prompt.md")), "new upstream prompt not auto-installed");
            var after = LockStore.Load(InstallScope.Repository, repo3);
            Check(after[0].Version == "1.4.0" && after[0].InstalledBy == SettingsStore.ToolName, "record now 1.4.0, stamped by this edition");
            Check(UpdateService.FindUpdates(newPkgs, info.Key, after).Count == 0, "no stale update afterwards");
            Func<string, string, bool> up = (a, b) => UpdateService.IsUpdateAvailable(new InstallRecord { Version = a }, new PluginPackage { Version = b }, "x");
            Check(up("1.9.0", "1.10.0") && up("1.0", "1.0.1") && !up("1.4.0", "1.4.0") && !up("2.0.0", "1.9.9") && up("", "1.0.0"), "numeric version comparison");

            Section("present but not tracked");
            var repo4 = Repo("repo4");
            CopyDir(Path.Combine(crk.RootPath, "skills", "review-checklist"), Path.Combine(repo4, ".github", "skills", "review-checklist"));
            Write(Path.Combine(repo4, ".github", "agents", "reviewer.agent.md"), "my own reviewer\n");
            var found = UpdateService.UntrackedPresence(crk, null, InstallScope.Repository, ClientLayout.Copilot, repo4);
            Check(string.Join(",", found.OrderBy(f => f.Name).Select(f => f.Name + ":" + f.State)) == "review-checklist:same,reviewer:differs", "identical / different detected");
            Check(!found.Any(f => f.Name == "commit-message"), "absent items are not reported");
            var tracked = UpdateService.TrackPresent(crk, info, InstallScope.Repository, repo4, ClientLayout.Copilot);
            var trackedRec = LockStore.Load(InstallScope.Repository, repo4)[0];
            Check(tracked == 2 && trackedRec.Version == "" && trackedRec.InstalledBy == SettingsStore.ToolName, "tracked; differing items recorded without a version");
            Check(UpdateService.UntrackedPresence(crk, trackedRec, InstallScope.Repository, ClientLayout.Copilot, repo4).Count == 0, "tracked items are no longer untracked");
            var ups4 = UpdateService.FindUpdates(PluginScanner.Discover(_examples), info.Key, LockStore.Load(InstallScope.Repository, repo4));
            Check(ups4.Count == 1, "update offered to bring the different item in line");
            UpdateService.Apply(ups4[0]);
            Check(File.ReadAllText(Path.Combine(repo4, ".github", "agents", "reviewer.agent.md")).Contains("verdict") && LockStore.Load(InstallScope.Repository, repo4)[0].Version == "1.4.0", "update replaced it");

            Section("user scope + uninstall clears the lock");
            var homeLock = Path.Combine(Environment.GetEnvironmentVariable("AGENTPLUGINS_HOME")!, ".agents", "plugin-lock.json");
            var ru = PluginInstaller.Install(new InstallRequest { Package = crk, Components = crk.Components.Where(c => c.Name == "commit-message").ToList(), Scope = InstallScope.User, Layout = ClientLayout.AgentsNeutral });
            UpdateService.Record(crk, info, InstallScope.User, null, ClientLayout.AgentsNeutral, ru.InstalledComponents);
            Check(File.Exists(homeLock) && File.Exists(Path.Combine(Environment.GetEnvironmentVariable("AGENTPLUGINS_HOME")!, ".agents", "skills", "commit-message", "SKILL.md")), "user scope: ~/.agents/plugin-lock.json and ~/.agents/skills");
            var userRec = LockStore.Load(InstallScope.User, null)[0];
            var uu = PluginInstaller.Uninstall(userRec, userRec.Components);
            LockStore.RemoveComponents(userRec, uu.RemovedComponents);
            Check(!File.Exists(homeLock), "lock file removed with the last item");

            Section("migration of the old per-tool records");
            var dataDir = Environment.GetEnvironmentVariable("AGENTPLUGINS_DATA_DIR")!;
            var mRepo = Repo("repo-migrate");
            Write(Path.Combine(dataDir, "installed.json"), new JArray(
                new JObject { ["PackageName"] = "p", ["SourceId"] = "src1", ["Version"] = "2.0.0", ["Fingerprint"] = "f", ["Scope"] = 1, ["RepoRoot"] = mRepo, ["Layout"] = 0,
                              ["Components"] = new JArray(new JObject { ["Kind"] = 0, ["Name"] = "s" }), ["InstalledUtc"] = "2026-01-01T00:00:00Z" },
                new JObject { ["PackageName"] = "orphan", ["SourceId"] = "unknown", ["Scope"] = 0, ["Layout"] = 1, ["Components"] = new JArray() }).ToString());
            var moved = LockStore.MigrateLegacy(new[] { new PluginSource { Id = "src1", Kind = SourceKind.Git, Location = "Owner/Repo" } });
            var mr = LockStore.Load(InstallScope.Repository, mRepo);
            Check(moved == 1 && mr.Count == 1 && mr[0].SourceKey == "github.com/owner/repo" && mr[0].Layout == ClientLayout.Claude && mr[0].Components[0].Kind == ComponentKind.Skill, "legacy record moved into the repository lock file");
            Check(File.Exists(Path.Combine(dataDir, "installed.json.migrated")) && !File.Exists(Path.Combine(dataDir, "installed.json")), "legacy file renamed");
            Check(LockStore.MigrateLegacy(new PluginSource[0]) == 0, "second run does nothing");

            await Task.CompletedTask;
        }

        private sealed class PluginInstaller_Result
        {
            public string Root = "";
            public InstallResult Result = null!;
        }

        private static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (var f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (var d in Directory.GetDirectories(src)) CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
        }
    }
}
