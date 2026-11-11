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
