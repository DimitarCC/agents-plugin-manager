using System;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using AgentsPluginsPackageManager.Models;
using AgentsPluginsPackageManager.Services;
using Microsoft.VisualStudio.PlatformUI;

namespace AgentsPluginsPackageManager.UI
{
    /// <summary>Add / edit a plugin source: git repo (public, SSO or token) or a local folder.</summary>
    public sealed class SourceDialog : DialogWindow
    {
        private readonly TextBox _name = new TextBox();
        private readonly ComboBox _kind = new ComboBox();
        private readonly TextBox _location = new TextBox();
        private readonly TextBox _ref = new TextBox();
        private readonly ComboBox _auth = new ComboBox();
        private readonly PasswordBox _token = new PasswordBox();
        private readonly TextBlock _hint = new TextBlock { TextWrapping = TextWrapping.Wrap };
        private readonly TextBlock _result = new TextBlock { TextWrapping = TextWrapping.Wrap };
        private readonly Button _test = new Button { Content = "Test connection" };
        private readonly Button _browse = new Button { Content = "Browse…", Margin = new Thickness(8, 0, 0, 0) };
        private readonly Label _tokenLabel = new Label { Content = "Access token:" };
        private readonly Label _authLabel = new Label { Content = "Authentication:" };
        private readonly Label _refLabel = new Label { Content = "Branch / tag / commit:" };
        private bool _tokenChanged;

        public PluginSource Source { get; }

        public SourceDialog(PluginSource source)
        {
            Source = source;

            // WinUI-style, theme-aware resources shared with the main window.
            Resources.MergedDictionaries.Add(new ResourceDictionary
            {
                Source = new Uri("/AgentsPluginsPackageManager;component/UI/Styles.xaml", UriKind.Relative)
            });
            Theme.Apply(Resources);
            Theme.Track(this);
            SetResourceReference(BackgroundProperty, "Bg");
            SetResourceReference(ForegroundProperty, "Fg");
            _hint.SetResourceReference(TextBlock.ForegroundProperty, "Muted");

            Title = string.IsNullOrEmpty(source.Location) ? "Add plugin source" : "Edit plugin source";
            Width = 600;
            SizeToContent = SizeToContent.Height;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            ResizeMode = ResizeMode.NoResize;

            _kind.ItemsSource = new[] { "Git repository", "Local folder" };
            _auth.ItemsSource = new[]
            {
                "Single sign-on (Git Credential Manager — browser / Entra ID / SAML)",
                "Personal access token (SSO-authorized)",
                "None (public repository)",
            };

            var grid = new Grid { Margin = new Thickness(20, 16, 20, 16) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            for (int i = 0; i < 8; i++) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            void Row(int r, Label label, FrameworkElement ctl)
            {
                label.VerticalAlignment = VerticalAlignment.Center;
                ctl.Margin = new Thickness(0, 3, 0, 3);
                Grid.SetRow(label, r); Grid.SetRow(ctl, r); Grid.SetColumn(ctl, 1);
                grid.Children.Add(label); grid.Children.Add(ctl);
            }

            Row(0, new Label { Content = "Name:" }, _name);
            Row(1, new Label { Content = "Type:" }, _kind);

            var locPanel = new DockPanel();
            DockPanel.SetDock(_browse, Dock.Right);
            locPanel.Children.Add(_browse);
            locPanel.Children.Add(_location);
            Row(2, new Label { Content = "Location:" }, locPanel);
            Row(3, _refLabel, _ref);
            Row(4, _authLabel, _auth);
            Row(5, _tokenLabel, _token);

            Grid.SetRow(_hint, 6); Grid.SetColumn(_hint, 1); _hint.Margin = new Thickness(0, 4, 0, 8);
            grid.Children.Add(_hint);

            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var ok = new Button { Content = "Save", IsDefault = true };
            ok.SetResourceReference(StyleProperty, "AccentButton");
            var cancel = new Button { Content = "Cancel", IsCancel = true, Margin = new Thickness(0) };
            buttons.Children.Add(_test); buttons.Children.Add(ok); buttons.Children.Add(cancel);
            var bottom = new StackPanel { Margin = new Thickness(0, 4, 0, 0) };
            bottom.Children.Add(_result);
            bottom.Children.Add(new Border { Height = 6 });
            bottom.Children.Add(buttons);
            Grid.SetRow(bottom, 7); Grid.SetColumnSpan(bottom, 2);
            grid.Children.Add(bottom);
            Content = grid;

            _name.Text = source.Name;
            _kind.SelectedIndex = source.Kind == SourceKind.Git ? 0 : 1;
            _location.Text = source.Location;
            _ref.Text = source.Ref;
            _auth.SelectedIndex = source.Auth == AuthMode.SingleSignOn ? 0 : source.Auth == AuthMode.PersonalAccessToken ? 1 : 2;
            if (!string.IsNullOrEmpty(source.ProtectedToken)) { _token.Password = "••••••••"; }
            _token.PasswordChanged += (s, e) => _tokenChanged = true;

            _kind.SelectionChanged += (s, e) => UpdateVisibility();
            _auth.SelectionChanged += (s, e) => UpdateVisibility();
            _browse.Click += Browse;
            _test.Click += Test;
            ok.Click += Save;
            UpdateVisibility();
            _tokenChanged = false;
        }

        private bool IsGit => _kind.SelectedIndex == 0;

        private void UpdateVisibility()
        {
            var git = IsGit;
            var tokenMode = git && _auth.SelectedIndex == 1;
            _browse.Visibility = git ? Visibility.Collapsed : Visibility.Visible;
            var v = git ? Visibility.Visible : Visibility.Collapsed;
            _refLabel.Visibility = _ref.Visibility = _authLabel.Visibility = _auth.Visibility = v;
            _tokenLabel.Visibility = _token.Visibility = tokenMode ? Visibility.Visible : Visibility.Collapsed;

            if (!git)
                _hint.Text = "A folder containing one or more plugin packages (each with a plugin.json), or a single plugin folder.";
            else if (_auth.SelectedIndex == 0)
                _hint.Text = "Location: https URL or GitHub 'owner/repo'. Git opens the sign-in flow of your organization (Entra ID, GitHub Enterprise, Azure DevOps, SAML SSO) and Git Credential Manager remembers the result.";
            else if (_auth.SelectedIndex == 1)
                _hint.Text = "For SAML-protected GitHub organizations, authorize the token for SSO first (Settings › Developer settings › Tokens › Configure SSO). Azure DevOps PATs also work. The token is stored encrypted for your Windows account.";
            else
                _hint.Text = "Location: https URL or GitHub 'owner/repo' of a public repository.";
        }

        private void Browse(object sender, RoutedEventArgs e)
        {
            using (var d = new System.Windows.Forms.FolderBrowserDialog { ShowNewFolderButton = false })
            {
                if (d.ShowDialog() == System.Windows.Forms.DialogResult.OK) _location.Text = d.SelectedPath;
            }
        }

        private PluginSource Collect()
        {
            var s = Source.Clone();
            s.Name = _name.Text.Trim();
            s.Kind = IsGit ? SourceKind.Git : SourceKind.Local;
            s.Location = _location.Text.Trim();
            s.Ref = _ref.Text.Trim();
            s.Auth = _auth.SelectedIndex == 0 ? AuthMode.SingleSignOn : _auth.SelectedIndex == 1 ? AuthMode.PersonalAccessToken : AuthMode.None;
            if (s.Auth != AuthMode.PersonalAccessToken) s.ProtectedToken = null;
            else if (_tokenChanged) s.SetToken(_token.Password);
            return s;
        }

        private async void Test(object sender, RoutedEventArgs e)
        {
            var s = Collect();
            if (s.Location.Length == 0) { _result.Text = "Enter a location first."; return; }
            _test.IsEnabled = false;
            _result.Foreground = System.Windows.Media.Brushes.Gray;
            _result.Text = s.Kind == SourceKind.Git ? "Connecting… (a sign-in window may appear)" : "Checking…";
            try
            {
                await System.Threading.Tasks.Task.Run(() => SourceSync.TestAsync(s, CancellationToken.None));
                _result.Foreground = System.Windows.Media.Brushes.ForestGreen;
                _result.Text = "Connection OK.";
            }
            catch (Exception ex)
            {
                _result.Foreground = System.Windows.Media.Brushes.OrangeRed;
                _result.Text = ex.Message;
            }
            finally { _test.IsEnabled = true; }
        }

        private void Save(object sender, RoutedEventArgs e)
        {
            var s = Collect();
            if (s.Location.Length == 0) { _result.Foreground = System.Windows.Media.Brushes.OrangeRed; _result.Text = "Location is required."; return; }
            if (s.Name.Length == 0) s.Name = s.Kind == SourceKind.Git ? s.Location.TrimEnd('/') : System.IO.Path.GetFileName(s.Location.TrimEnd('\\', '/'));
            if (s.Auth == AuthMode.PersonalAccessToken && string.IsNullOrEmpty(s.ProtectedToken))
            { _result.Foreground = System.Windows.Media.Brushes.OrangeRed; _result.Text = "Enter an access token."; return; }
            Source.Name = s.Name; Source.Kind = s.Kind; Source.Location = s.Location; Source.Ref = s.Ref; Source.Auth = s.Auth; Source.ProtectedToken = s.ProtectedToken;
            DialogResult = true;
        }
    }
}
