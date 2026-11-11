using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Navigation;
using AgentsPluginsPackageManager.Models;
using AgentsPluginsPackageManager.Services;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace AgentsPluginsPackageManager.UI
{
    public partial class PluginManagerControl : UserControl
    {
        private sealed class LayoutItem
        {
            public ClientLayout Layout { get; set; }
            public string Label { get; set; } = "";
            public override string ToString() => Label;
        }

        private readonly Settings _settings = SettingsStore.Load();
        private List<PluginPackage> _packages = new List<PluginPackage>();
        private List<PluginPackage> _visible = new List<PluginPackage>();
        private CancellationTokenSource? _loadCts;
        private bool _loading;
        private bool _initialized;
        private string _packagesSourceId = "";
        private List<UpdateInfo> _updates = new List<UpdateInfo>();

        public PluginManagerControl()
        {
            InitializeComponent();
            Theme.Apply(Resources);
            Theme.Track(this);

            LayoutCombo.ItemsSource = new[]
            {
                new LayoutItem { Layout = ClientLayout.Copilot, Label = "GitHub Copilot  (.github / .copilot)" },
                new LayoutItem { Layout = ClientLayout.Claude, Label = "Claude Code  (.claude)" },
                new LayoutItem { Layout = ClientLayout.AgentsNeutral, Label = "Agent-neutral  (.agents, skills only)" },
            };
            LayoutCombo.SelectedIndex = Math.Max(0, Array.FindIndex((LayoutItem[])LayoutCombo.ItemsSource, i => i.Layout == _settings.Layout));
            (_settings.Scope == InstallScope.User ? UserScopeRadio : RepoScopeRadio).IsChecked = true;
            AutoUpdateCheck.IsChecked = _settings.AutoUpdate;

            RefreshSourceList(_settings.LastSourceId);
            _initialized = true;
            UpdateDestination();
            ShowPackage(null);
            Loaded += (s, e) => { if (SourceCombo.SelectedItem != null && _packages.Count == 0 && !_loading) _ = LoadSelectedSourceAsync(); };
        }

        private PluginSource? CurrentSource => SourceCombo.SelectedItem as PluginSource;
        private PluginPackage? CurrentPackage => PackageList.SelectedItem as PluginPackage;
        private InstallScope CurrentScope => RepoScopeRadio.IsChecked == true ? InstallScope.Repository : InstallScope.User;
        private ClientLayout CurrentLayout => (LayoutCombo.SelectedItem as LayoutItem)?.Layout ?? ClientLayout.Copilot;

        // ───────── Sources ─────────

        private void RefreshSourceList(string? select)
        {
            SourceCombo.ItemsSource = null;
            SourceCombo.ItemsSource = _settings.Sources;
            SourceCombo.SelectedItem = _settings.Sources.FirstOrDefault(s => s.Id == select) ?? _settings.Sources.FirstOrDefault();
            var has = CurrentSource != null;
            EditButton.IsEnabled = RemoveButton.IsEnabled = RefreshButton.IsEnabled = has;
            if (!has) SetStatus("Add a source repository to get started.");
        }

        private void AddSource_Click(object sender, RoutedEventArgs e)
        {
            var dlg = new SourceDialog(new PluginSource());
            if (dlg.ShowModal() != true) return;
            _settings.Sources.Add(dlg.Source);
            SaveSettings();
            RefreshSourceList(dlg.Source.Id);
        }

        private void EditSource_Click(object sender, RoutedEventArgs e)
        {
            var current = CurrentSource;
            if (current == null) return;
            var dlg = new SourceDialog(current.Clone());
            if (dlg.ShowModal() != true) return;
            var i = _settings.Sources.IndexOf(current);
            _settings.Sources[i] = dlg.Source;
            SaveSettings();
            RefreshSourceList(dlg.Source.Id);
        }

        private void RemoveSource_Click(object sender, RoutedEventArgs e)
        {
            var current = CurrentSource;
            if (current == null) return;
            if (MessageBox.Show("Remove source '" + current.DisplayName + "'?", "Agent Plugin Manager", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            _settings.Sources.Remove(current);
            SaveSettings();
            SetPackages(new List<PluginPackage>());
            RefreshSourceList(null);
        }

        private void SourceCombo_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!_initialized) return;
            _settings.LastSourceId = CurrentSource?.Id;
            SaveSettings();
            _ = LoadSelectedSourceAsync();
        }

        private void Refresh_Click(object sender, RoutedEventArgs e) => _ = LoadSelectedSourceAsync();

        private async Task LoadSelectedSourceAsync()
        {
            var source = CurrentSource;
            _loadCts?.Cancel();
            SetPackages(new List<PluginPackage>());
            if (source == null) return;

            var cts = _loadCts = new CancellationTokenSource();
            _loading = true;
            SetBusy(true);
            try
            {
                var progress = new Progress<string>(SetStatus);
                SetStatus("Connecting to " + source.DisplayName + "…");
                var root = await Task.Run(() => SourceSync.SyncAsync(source, progress, cts.Token), cts.Token);
                var found = await Task.Run(() => PluginScanner.Discover(root), cts.Token);
                if (cts.IsCancellationRequested) return;
                _packagesSourceId = source.Id;
                SetPackages(found);
                RefreshUpdateState();
                SetStatus(found.Count + " plugin package(s) in " + source.DisplayName
                          + (_updates.Count > 0 ? " · " + _updates.Count + " update(s) available" : ""));
                if (_settings.AutoUpdate && _updates.Count > 0) await ApplyUpdatesAsync(_updates.ToList(), auto: true);
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                if (cts.IsCancellationRequested) return;
                SetStatus("Failed to load source.");
                ShowLog("Failed to load '" + source.DisplayName + "':\n" + ex.Message);
            }
            finally
            {
                if (_loadCts == cts) { _loading = false; SetBusy(false); }
            }
        }

        // ───────── Package list / details ─────────

        private void SetPackages(List<PluginPackage> packages)
        {
            foreach (var p in _packages) p.PropertyChanged -= Package_PropertyChanged;
            _packages = packages;
            foreach (var p in _packages) p.PropertyChanged += Package_PropertyChanged;
            ApplyFilter();
            UpdateInstallState();
        }

        private void Package_PropertyChanged(object? sender, PropertyChangedEventArgs e)
        {
            UpdateInstallState();
            UpdateSelectAllState();
        }

        // ───────── Updates ─────────

        /// <summary>Compares installed records with the freshly loaded source and refreshes badges / buttons.</summary>
        private void RefreshUpdateState()
        {
            var records = InstallStore.Load();
            UpdateService.Annotate(_packages, _packagesSourceId, records);
            _updates = UpdateService.FindUpdates(_packages, _packagesSourceId, records);
            UpdateAllButton.Visibility = _updates.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            UpdateAllButton.Content = "Update all (" + _updates.Count + ")";
            ShowUpdateBanner(CurrentPackage);
            RefreshInstalledMarks();
        }

        // ───────── Uninstall ─────────

        /// <summary>The install record of the selected package at the destination chosen in the install bar.</summary>
        private InstallRecord? CurrentRecord()
        {
            var p = CurrentPackage;
            if (p == null) return null;
            var scope = CurrentScope;
            var repo = scope == InstallScope.Repository ? GetRepoRoot() : null;
            if (scope == InstallScope.Repository && repo == null) return null;
            var key = InstallRecord.MakeKey(_packagesSourceId, p.Name, scope, repo, CurrentLayout);
            return InstallStore.Load().FirstOrDefault(r => r.Key == key);
        }

        private void RefreshInstalledMarks()
        {
            var p = CurrentPackage;
            var rec = CurrentRecord();
            if (p != null)
                foreach (var c in p.Components)
                    c.IsInstalledHere = rec != null && rec.Components.Any(i => i.Kind == c.Kind && string.Equals(i.Name, c.Name, StringComparison.OrdinalIgnoreCase));

            if (p == null || rec == null) { InstalledBanner.Visibility = Visibility.Collapsed; return; }
            InstalledBannerText.Text = "Installed at this destination (" + rec.Where + ")"
                + (string.IsNullOrEmpty(rec.Version) ? "" : "  ·  v" + rec.Version) + "  ·  " + rec.Components.Count + " item(s)";
            InstalledBanner.Visibility = Visibility.Visible;
        }

        private async void UninstallItem_Click(object sender, RoutedEventArgs e)
        {
            if (!((sender as FrameworkElement)?.DataContext is PluginComponent c)) return;
            await UninstallAsync(new List<InstalledComponent> { new InstalledComponent { Kind = c.Kind, Name = c.Name } }, "'" + c.Name + "'");
        }

        private async void UninstallPackage_Click(object sender, RoutedEventArgs e)
        {
            var rec = CurrentRecord();
            if (rec == null) return;
            await UninstallAsync(rec.Components.ToList(), "all " + rec.Components.Count + " installed item(s) of '" + rec.PackageName + "'");
        }

        private async Task UninstallAsync(List<InstalledComponent> items, string what)
        {
            var rec = CurrentRecord();
            if (rec == null) return;
            if (MessageBox.Show("Uninstall " + what + " from " + rec.Where + "?\n\nThe installed files are deleted; local edits to them are lost.",
                    "Agent Plugin Manager", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;

            try
            {
                var res = await Task.Run(() => PluginInstaller.Uninstall(rec, items));
                InstallStore.RemoveComponents(rec.Key, res.RemovedComponents);
                var sb = new StringBuilder("Uninstalled " + res.RemovedComponents.Count + " item(s) of '" + rec.PackageName + "' from " + rec.Where + ":").AppendLine();
                foreach (var s in res.Removed) sb.AppendLine("  - " + s);
                foreach (var s in res.Skipped) sb.AppendLine("  ! could not remove " + s);
                ShowLog(sb.ToString().TrimEnd());
            }
            catch (Exception ex) { ShowLog("Uninstall failed: " + ex.Message); }
            finally { RefreshUpdateState(); }
        }

        private void ShowUpdateBanner(PluginPackage? p)
        {
            if (p == null || !p.HasUpdate) { UpdateBanner.Visibility = Visibility.Collapsed; return; }
            UpdateBannerTitle.Text = "Update available  " + p.UpdateText;
            UpdateBannerText.Text = p.InstalledSummary;
            UpdateBanner.Visibility = Visibility.Visible;
        }

        private async Task ApplyUpdatesAsync(List<UpdateInfo> updates, bool auto)
        {
            if (updates.Count == 0) return;
            UpdateAllButton.IsEnabled = UpdateButton.IsEnabled = false;
            var sb = new StringBuilder(auto ? "Auto-updated installed plugins:" : "Updated installed plugins:").AppendLine();
            try
            {
                foreach (var u in updates)
                {
                    try
                    {
                        await Task.Run(() => UpdateService.Apply(u));
                        sb.AppendLine("  ✓ " + u.Package.Name + "  " + u.FromVersion + " → " + u.ToVersion + "  (" + u.Record.Where + ")");
                    }
                    catch (Exception ex) { sb.AppendLine("  ✗ " + u.Package.Name + " (" + u.Record.Where + "): " + ex.Message); }
                }
                ShowLog(sb.ToString().TrimEnd());
            }
            finally
            {
                UpdateAllButton.IsEnabled = UpdateButton.IsEnabled = true;
                RefreshUpdateState();
            }
        }

        private async void UpdateAll_Click(object sender, RoutedEventArgs e) => await ApplyUpdatesAsync(_updates.ToList(), auto: false);

        private async void UpdatePackage_Click(object sender, RoutedEventArgs e)
        {
            var p = CurrentPackage;
            if (p == null) return;
            await ApplyUpdatesAsync(_updates.Where(u => ReferenceEquals(u.Package, p)).ToList(), auto: false);
        }

        private async void AutoUpdate_Click(object sender, RoutedEventArgs e)
        {
            _settings.AutoUpdate = AutoUpdateCheck.IsChecked == true;
            SaveSettings();
            if (_settings.AutoUpdate && _updates.Count > 0) await ApplyUpdatesAsync(_updates.ToList(), auto: true);
        }

        private void SearchBox_TextChanged(object sender, TextChangedEventArgs e) => ApplyFilter();

        private void ApplyFilter()
        {
            var q = SearchBox.Text?.Trim() ?? "";
            _visible = _packages.Where(p => q.Length == 0
                || p.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0
                || p.Description.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0
                || p.Keywords.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0
                || p.Components.Any(c => c.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0
                                         || c.Description.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0)).ToList();
            PackageList.ItemsSource = _visible;
            PackageCount.Text = _visible.Count == _packages.Count ? _packages.Count + " packages" : _visible.Count + " of " + _packages.Count;
            if (_visible.Count > 0) PackageList.SelectedIndex = 0; else ShowPackage(null);
            UpdateSelectAllState();
        }

        private void SelectAllPackages_Click(object sender, RoutedEventArgs e)
        {
            var on = SelectAllPackages.IsChecked == true;
            foreach (var p in _visible) p.IsChecked = on;
        }

        private void UpdateSelectAllState()
        {
            if (_visible.Count == 0) { SelectAllPackages.IsChecked = false; SelectAllPackages.IsEnabled = false; return; }
            SelectAllPackages.IsEnabled = true;
            var states = _visible.Select(p => p.IsChecked).ToList();
            SelectAllPackages.IsChecked = states.All(s => s == true) ? true : states.All(s => s == false) ? false : (bool?)null;
        }

        private void PackageList_SelectionChanged(object sender, SelectionChangedEventArgs e) => ShowPackage(CurrentPackage);

        private void ShowPackage(PluginPackage? p)
        {
            DetailPanel.Visibility = p == null ? Visibility.Hidden : Visibility.Visible;
            PreviewBox.Text = "";
            PreviewTitle.Text = "PREVIEW  —  select an item to see its content";
            if (p == null) { ComponentList.ItemsSource = null; return; }

            PkgName.Text = p.Name;
            PkgVersion.Text = string.IsNullOrEmpty(p.Version) ? "no version" : "v" + p.Version;

            var chips = new List<string>();
            if (!string.IsNullOrEmpty(p.Author)) chips.Add("by " + p.Author);
            if (!string.IsNullOrEmpty(p.License)) chips.Add(p.License);
            chips.AddRange(p.Keywords.Split(new[] { ", " }, StringSplitOptions.RemoveEmptyEntries));
            PkgChips.ItemsSource = chips;
            PkgChips.Visibility = chips.Count == 0 ? Visibility.Collapsed : Visibility.Visible;

            PkgDescription.Text = p.ListDescription;
            PkgDescription.Opacity = string.IsNullOrWhiteSpace(p.Description) ? 0.6 : 1;

            if (Uri.TryCreate(p.Homepage, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                PkgHyperlink.NavigateUri = uri;
                PkgLinkText.Text = p.Homepage;
                PkgLink.Visibility = Visibility.Visible;
            }
            else PkgLink.Visibility = Visibility.Collapsed;

            PkgWarnings.Text = string.Join("\n", p.Warnings);
            PkgWarnings.Visibility = p.Warnings.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
            ShowUpdateBanner(p);

            var view = new ListCollectionView(p.Components);
            view.SortDescriptions.Add(new SortDescription(nameof(PluginComponent.Kind), ListSortDirection.Ascending));
            view.GroupDescriptions.Add(new PropertyGroupDescription(nameof(PluginComponent.KindLabel)));
            ComponentList.ItemsSource = view;
            RefreshInstalledMarks();
        }

        private void Hyperlink_RequestNavigate(object sender, RequestNavigateEventArgs e)
        {
            try { Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); }
            catch { }
            e.Handled = true;
        }

        private void ComponentList_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (!(ComponentList.SelectedItem is PluginComponent c)) return;
            PreviewTitle.Text = "PREVIEW  —  " + c.Name + "  (" + c.RelativePath + ")";
            PreviewBox.Text = !string.IsNullOrEmpty(c.Preview) ? c.Preview : c.Description;
        }

        private void SelectAll_Click(object sender, RoutedEventArgs e) { if (CurrentPackage != null) CurrentPackage.IsChecked = true; }
        private void SelectNone_Click(object sender, RoutedEventArgs e) { if (CurrentPackage != null) CurrentPackage.IsChecked = false; }

        // ───────── Install ─────────

        private void Target_Changed(object sender, RoutedEventArgs e)
        {
            if (!_initialized) return;
            _settings.Scope = CurrentScope;
            _settings.Layout = CurrentLayout;
            SaveSettings();
            UpdateDestination();
            RefreshInstalledMarks();
        }

        private string? GetRepoRoot()
        {
            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                if (Package.GetGlobalService(typeof(SVsSolution)) is IVsSolution sol
                    && sol.GetSolutionInfo(out var dir, out _, out _) == 0 && !string.IsNullOrEmpty(dir))
                    return PluginInstaller.FindRepoRoot(dir);
            }
            catch { }
            return null;
        }

        private void UpdateDestination()
        {
            var scope = CurrentScope;
            var repo = GetRepoRoot();
            if (scope == InstallScope.Repository && repo == null)
            {
                DestinationText.Text = "No solution/folder is open — open one to install into a repository.";
                return;
            }
            var l = InstallLayout.Resolve(scope, CurrentLayout, repo);
            var sb = new StringBuilder();
            if (l.SkillsDir != null) sb.AppendLine("skills   " + l.SkillsDir);
            if (l.AgentsDir != null) sb.AppendLine("agents   " + l.AgentsDir);
            if (l.PromptsDir != null) sb.AppendLine("prompts  " + l.PromptsDir);
            if (l.McpFile != null) sb.AppendLine("mcp      " + l.McpFile);
            DestinationText.Text = sb.ToString().TrimEnd();
        }

        private void UpdateInstallState()
        {
            var n = _packages.Sum(p => p.SelectedCount);
            InstallButton.Content = n == 0 ? "Install" : "Install " + n + " selected";
            InstallButton.IsEnabled = n > 0 && !_loading;
        }

        private async void Install_Click(object sender, RoutedEventArgs e)
        {
            var work = _packages
                .Select(p => new { Package = p, Items = p.Components.Where(c => c.IsSelected && c.Installable).ToList() })
                .Where(w => w.Items.Count > 0).ToList();
            if (work.Count == 0) { ShowLog("Nothing selected. Tick the items or packages you want to install."); return; }

            var scope = CurrentScope;
            string? repo = GetRepoRoot();
            if (scope == InstallScope.Repository && repo == null)
            {
                ShowLog("No solution/folder is open, so there is no repository to install into.");
                return;
            }

            if (work.Any(w => w.Items.Any(c => c.Kind == ComponentKind.McpServer)) &&
                MessageBox.Show("MCP servers can launch programs or connect to remote services. Only install servers from sources you trust.\n\nContinue?",
                    "Agent Plugin Manager", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;

            var layout = CurrentLayout;
            var overwrite = OverwriteCheck.IsChecked == true;
            InstallButton.IsEnabled = false;
            var sb = new StringBuilder();
            try
            {
                foreach (var w in work)
                {
                    var req = new InstallRequest { Package = w.Package, Components = w.Items, Scope = scope, Layout = layout, RepoRoot = repo, Overwrite = overwrite };
                    try
                    {
                        var res = await Task.Run(() => PluginInstaller.Install(req));
                        UpdateService.Record(w.Package, _packagesSourceId, scope, repo, layout, res.InstalledComponents);
                        sb.AppendLine(w.Package.Name + ": installed " + res.Installed.Count + ", skipped " + res.Skipped.Count);
                        foreach (var s in res.Installed) sb.AppendLine("  + " + s);
                        foreach (var s in res.Skipped) sb.AppendLine("  - " + s);
                    }
                    catch (Exception ex) { sb.AppendLine(w.Package.Name + ": FAILED — " + ex.Message); }
                }
                sb.AppendLine("Restart the chat/agent session if the new items don't show up yet.");
                ShowLog(sb.ToString().TrimEnd());
            }
            finally { UpdateInstallState(); RefreshUpdateState(); }
        }

        // ───────── helpers ─────────

        private void SetBusy(bool busy)
        {
            Busy.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
            RefreshButton.IsEnabled = !busy && CurrentSource != null;
            UpdateInstallState();
        }

        private void SetStatus(string text) => StatusText.Text = text;

        private void ShowLog(string text)
        {
            LogBox.Visibility = Visibility.Visible;
            LogBox.Text = text;
        }

        private void SaveSettings()
        {
            try { SettingsStore.Save(_settings); }
            catch (Exception ex) { Debug.WriteLine(ex); }
        }
    }
}
