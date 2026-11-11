using System;
using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using AgentsPluginsPackageManager.Services;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace AgentsPluginsPackageManager
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(PackageGuids.PackageString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(typeof(PluginManagerToolWindow), Style = VsDockStyle.Tabbed, Window = "DocumentWell", Orientation = ToolWindowOrientation.Left)]
    [ProvideAutoLoad(VSConstants.UICONTEXT.ShellInitialized_string, PackageAutoLoadFlags.BackgroundLoad)]
    public sealed class AgentsPluginsPackage : AsyncPackage
    {
        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            if (await GetServiceAsync(typeof(IMenuCommandService)) is OleMenuCommandService mcs)
            {
                var id = new CommandID(PackageGuids.CommandSet, PackageGuids.ShowPluginManagerCommandId);
                mcs.AddCommand(new MenuCommand((s, e) => ShowManager(), id));
            }

            JoinableTaskFactory.RunAsync(() => AutoUpdateInBackgroundAsync(DisposalToken))
                .FileAndForget("AgentsPluginsPackageManager/AutoUpdate");
        }

        /// <summary>If auto-update is on, quietly refreshes installed plugins shortly after startup (never shows a sign-in prompt).</summary>
        private async Task AutoUpdateInBackgroundAsync(CancellationToken ct)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(20), ct).ConfigureAwait(false);
                var settings = SettingsStore.Load();
                if (!settings.AutoUpdate) return;

                var updated = await Task.Run(() => UpdateService.RunAutoUpdateAsync(settings, ct), ct);
                if (updated.Count == 0) return;

                await JoinableTaskFactory.SwitchToMainThreadAsync(ct);
                if (await GetServiceAsync(typeof(SVsStatusbar)) is IVsStatusbar bar)
                    bar.SetText("Agent Plugin Manager updated " + updated.Count + " plugin(s): " + string.Join(", ", updated));
            }
            catch (OperationCanceledException) { }
        }

        private void ShowManager()
        {
            JoinableTaskFactory.RunAsync(async () =>
            {
                await ShowToolWindowAsync(typeof(PluginManagerToolWindow), 0, true, DisposalToken);
            }).FileAndForget("AgentsPluginsPackageManager/ShowToolWindow");
        }
    }

    internal static class PackageGuids
    {
        public const string PackageString = "6b0a5f0e-2c58-4c0e-9a36-4d8a5b1f7c21";
        public const string CommandSetString = "c3e1d7a4-84b6-4f6b-8d2a-1a9d3e5f7b02";
        public static readonly Guid CommandSet = new Guid(CommandSetString);
        public const int ShowPluginManagerCommandId = 0x0100;
    }
}
