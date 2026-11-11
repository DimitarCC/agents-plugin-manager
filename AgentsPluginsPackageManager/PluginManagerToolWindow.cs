using System.Runtime.InteropServices;
using AgentsPluginsPackageManager.UI;
using Microsoft.VisualStudio.Shell;

namespace AgentsPluginsPackageManager
{
    [Guid("a8f4c2d1-5e93-4b7a-9c60-2d1e8f3b4a55")]
    public sealed class PluginManagerToolWindow : ToolWindowPane
    {
        public PluginManagerToolWindow() : base(null)
        {
            Caption = "Agent Plugin Manager";
            Content = new PluginManagerControl();
        }
    }
}
