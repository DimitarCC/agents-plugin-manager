using System;
using System.IO;
using AgentsPluginsPackageManager.Models;
using Newtonsoft.Json;

namespace AgentsPluginsPackageManager.Services
{
    public static class SettingsStore
    {
        /// <summary>%LOCALAPPDATA%\AgentsPluginsPackageManager, or the folder in AGENTPLUGINS_DATA_DIR (used by automated tests).</summary>
        public static string DataRoot { get; } = Environment.GetEnvironmentVariable("AGENTPLUGINS_DATA_DIR") is string d && d.Length > 0
            ? d
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentsPluginsPackageManager");

        /// <summary>The user's home folder, or AGENTPLUGINS_HOME (used by automated tests).</summary>
        public static string Home { get; } = Environment.GetEnvironmentVariable("AGENTPLUGINS_HOME") is string h && h.Length > 0
            ? h
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        /// <summary>"visual-studio &lt;version&gt;", written to the lock file as installedBy.</summary>
        public static string ToolName { get; } = "visual-studio " + (typeof(SettingsStore).Assembly.GetName().Version?.ToString(3) ?? "0.0.0");

        public static string CacheRoot => Path.Combine(DataRoot, "cache");
        public static string PluginPayloadRoot => Path.Combine(DataRoot, "plugins");
        private static string FilePath => Path.Combine(DataRoot, "settings.json");

        public static Settings Load()
        {
            try
            {
                if (File.Exists(FilePath))
                    return JsonConvert.DeserializeObject<Settings>(File.ReadAllText(FilePath)) ?? new Settings();
            }
            catch { /* corrupt settings: start fresh */ }
            return new Settings();
        }

        public static void Save(Settings settings)
        {
            Directory.CreateDirectory(DataRoot);
            File.WriteAllText(FilePath, JsonConvert.SerializeObject(settings, Formatting.Indented));
        }
    }
}
