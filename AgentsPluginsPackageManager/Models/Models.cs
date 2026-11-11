using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;

namespace AgentsPluginsPackageManager.Models
{
    public enum SourceKind { Git, Local }

    public enum AuthMode
    {
        /// <summary>Public repository, no credentials.</summary>
        None,
        /// <summary>Git Credential Manager: interactive browser sign-in (Entra ID / GitHub / SAML SSO).</summary>
        SingleSignOn,
        /// <summary>Personal access token (must be SSO-authorized for SAML-protected orgs).</summary>
        PersonalAccessToken,
    }

    public enum InstallScope { User, Repository }

    public enum ClientLayout { Claude, Copilot, AgentsNeutral }

    public enum ComponentKind { Skill, McpServer, Agent, Prompt, Hook }

    /// <summary>A repository (or folder) that contains one or more agent plugin packages.</summary>
    public sealed class PluginSource
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public string Name { get; set; } = "";
        public SourceKind Kind { get; set; } = SourceKind.Git;
        /// <summary>Git URL, GitHub "owner/repo" shorthand, or local folder.</summary>
        public string Location { get; set; } = "";
        /// <summary>Optional branch, tag or commit.</summary>
        public string Ref { get; set; } = "";
        public AuthMode Auth { get; set; } = AuthMode.SingleSignOn;
        /// <summary>DPAPI (current user) protected token, base64.</summary>
        public string? ProtectedToken { get; set; }

        [JsonIgnore]
        public string DisplayName => string.IsNullOrWhiteSpace(Name) ? Location : Name;

        public string? GetToken()
        {
            if (string.IsNullOrEmpty(ProtectedToken)) return null;
            try
            {
                var bytes = ProtectedData.Unprotect(Convert.FromBase64String(ProtectedToken), null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(bytes);
            }
            catch { return null; }
        }

        public void SetToken(string? token)
        {
            ProtectedToken = string.IsNullOrEmpty(token)
                ? null
                : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser));
        }

        public PluginSource Clone() => (PluginSource)MemberwiseClone();
        public override string ToString() => DisplayName;
    }

    public sealed class Settings
    {
        public List<PluginSource> Sources { get; set; } = new List<PluginSource>();
        public string? LastSourceId { get; set; }
        public InstallScope Scope { get; set; } = InstallScope.User;
        public ClientLayout Layout { get; set; } = ClientLayout.Copilot;
        /// <summary>Apply updates to installed plugins automatically (on refresh and at VS startup).</summary>
        public bool AutoUpdate { get; set; }
    }

    public sealed class InstalledComponent
    {
        public ComponentKind Kind { get; set; }
        public string Name { get; set; } = "";
    }

    /// <summary>What was installed from a package, where, and at which version.</summary>
    public sealed class InstallRecord
    {
        public string PackageName { get; set; } = "";
        public string SourceId { get; set; } = "";
        public string Version { get; set; } = "";
        /// <summary>Content hash of the installed components; detects changes when a package has no version.</summary>
        public string Fingerprint { get; set; } = "";
        public InstallScope Scope { get; set; }
        public string? RepoRoot { get; set; }
        public ClientLayout Layout { get; set; }
        public List<InstalledComponent> Components { get; set; } = new List<InstalledComponent>();
        public DateTime InstalledUtc { get; set; } = DateTime.UtcNow;

        [JsonIgnore]
        public string Key => MakeKey(SourceId, PackageName, Scope, RepoRoot, Layout);

        public static string MakeKey(string sourceId, string packageName, InstallScope scope, string? repoRoot, ClientLayout layout) =>
            string.Join("|", sourceId, packageName, scope, scope == InstallScope.Repository ? repoRoot ?? "" : "", layout);

        [JsonIgnore]
        public string Where => (Scope == InstallScope.User ? "User" : "Repo") + " · " + Layout;
    }

    /// <summary>One installable (or informational) item inside a plugin package.</summary>
    public sealed class PluginComponent : INotifyPropertyChanged
    {
        private bool _isSelected;

        public ComponentKind Kind { get; set; }
        public string Name { get; set; } = "";
        public string Description { get; set; } = "";
        /// <summary>Path relative to the plugin root (file or directory).</summary>
        public string RelativePath { get; set; } = "";
        public bool IsDirectory { get; set; }
        public bool Installable { get; set; } = true;
        /// <summary>For MCP servers: the raw JSON definition. For others: preview text.</summary>
        public string Preview { get; set; } = "";
        public Newtonsoft.Json.Linq.JObject? McpDefinition { get; set; }

        public string KindTag
        {
            get
            {
                switch (Kind)
                {
                    case ComponentKind.Skill: return "SKILL";
                    case ComponentKind.McpServer: return "MCP";
                    case ComponentKind.Agent: return "AGENT";
                    case ComponentKind.Prompt: return "PROMPT";
                    default: return "HOOK";
                }
            }
        }

        public string KindLabel
        {
            get
            {
                switch (Kind)
                {
                    case ComponentKind.Skill: return "Skills";
                    case ComponentKind.McpServer: return "MCP servers";
                    case ComponentKind.Agent: return "Agents";
                    case ComponentKind.Prompt: return "Prompts / commands";
                    default: return "Hooks & other (not installable)";
                }
            }
        }

        private bool _isInstalledHere;

        /// <summary>True when this item is installed at the destination currently chosen in the UI.</summary>
        public bool IsInstalledHere
        {
            get => _isInstalledHere;
            set { if (_isInstalledHere != value) { _isInstalledHere = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsInstalledHere))); } }
        }

        public bool IsSelected
        {
            get => _isSelected;
            set { if (_isSelected != value) { _isSelected = value; PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsSelected))); } }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
    }

    public sealed class PluginPackage : INotifyPropertyChanged
    {
        private bool _syncing;

        public event PropertyChangedEventHandler? PropertyChanged;

        /// <summary>Hooks component selection changes so the package-level checkbox stays in sync.</summary>
        public void Attach()
        {
            foreach (var c in Components)
                c.PropertyChanged += (s, e) => { if (!_syncing) RaiseSelection(); };
        }

        private void RaiseSelection()
        {
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsChecked)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(SelectedCount)));
        }

        public int SelectedCount => Components.Count(c => c.Installable && c.IsSelected);

        /// <summary>true = everything installable selected, null = some, false = none.</summary>
        public bool? IsChecked
        {
            get
            {
                var inst = Components.Where(c => c.Installable).ToList();
                if (inst.Count == 0) return false;
                var n = inst.Count(c => c.IsSelected);
                return n == 0 ? false : n == inst.Count ? (bool?)true : null;
            }
            set
            {
                if (value == null) return;
                _syncing = true;
                foreach (var c in Components.Where(c => c.Installable)) c.IsSelected = value.Value;
                _syncing = false;
                RaiseSelection();
            }
        }

        private string _installedSummary = "";
        private bool _hasUpdate;
        private string _updateText = "";

        public string InstalledSummary => _installedSummary;
        public bool IsInstalled => _installedSummary.Length > 0;
        public bool HasUpdate => _hasUpdate;
        public string UpdateText => _updateText;

        public void SetInstallState(string installedSummary, bool hasUpdate, string updateText)
        {
            _installedSummary = installedSummary;
            _hasUpdate = hasUpdate;
            _updateText = updateText;
            foreach (var n in new[] { nameof(InstalledSummary), nameof(IsInstalled), nameof(HasUpdate), nameof(UpdateText) })
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(n));
        }

        public string VersionLabel => string.IsNullOrEmpty(Version) ? "" : "v" + Version;
        public string ListDescription => string.IsNullOrWhiteSpace(Description) ? "No description provided." : Description;

        public string Name { get; set; } = "";
        public string Version { get; set; } = "";
        public string Description { get; set; } = "";
        public string Author { get; set; } = "";
        public string Homepage { get; set; } = "";
        public string License { get; set; } = "";
        public string Keywords { get; set; } = "";
        public string RootPath { get; set; } = "";
        public bool HasManifest { get; set; }
        public List<PluginComponent> Components { get; } = new List<PluginComponent>();
        public List<string> Warnings { get; } = new List<string>();

        public string Summary
        {
            get
            {
                int s = 0, m = 0, a = 0, p = 0;
                foreach (var c in Components)
                {
                    switch (c.Kind)
                    {
                        case ComponentKind.Skill: s++; break;
                        case ComponentKind.McpServer: m++; break;
                        case ComponentKind.Agent: a++; break;
                        case ComponentKind.Prompt: p++; break;
                    }
                }
                var parts = new List<string>();
                if (s > 0) parts.Add(s + " skill" + (s == 1 ? "" : "s"));
                if (a > 0) parts.Add(a + " agent" + (a == 1 ? "" : "s"));
                if (p > 0) parts.Add(p + " prompt" + (p == 1 ? "" : "s"));
                if (m > 0) parts.Add(m + " MCP");
                return parts.Count == 0 ? "no components" : string.Join(" · ", parts);
            }
        }

        public override string ToString() => Name;
    }
}
