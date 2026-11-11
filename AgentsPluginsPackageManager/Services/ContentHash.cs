using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using AgentsPluginsPackageManager.Models;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace AgentsPluginsPackageManager.Services
{
    /// <summary>JSON helpers that never reinterpret strings (e.g. as dates).</summary>
    public static class Json
    {
        public static JObject? ParseObject(string text)
        {
            var settings = new JsonSerializerSettings { DateParseHandling = DateParseHandling.None };
            return JsonConvert.DeserializeObject<JObject>(text.TrimStart('﻿'), settings);
        }

        public static JArray? ParseArray(string text)
        {
            var settings = new JsonSerializerSettings { DateParseHandling = DateParseHandling.None };
            return JsonConvert.DeserializeObject<JArray>(text.TrimStart('﻿'), settings);
        }
    }

    /// <summary>
    /// Content hashing shared with the VS Code edition (see docs/plugin-lock.md, "Fingerprint").
    /// </summary>
    public static class ContentHash
    {
        /// <summary>base64(sha1(bytes with 0x0D removed)), so CRLF and LF checkouts hash the same.</summary>
        public static string FileHash(string file)
        {
            var bytes = File.ReadAllBytes(file).Where(b => b != 13).ToArray();
            using (var sha = SHA1.Create()) return Convert.ToBase64String(sha.ComputeHash(bytes));
        }

        private static void ListFiles(string dir, string rel, List<string> output)
        {
            foreach (var f in Directory.GetFiles(dir)) output.Add(rel + "/" + Path.GetFileName(f));
            foreach (var d in Directory.GetDirectories(dir))
            {
                var name = Path.GetFileName(d);
                if (name != ".git") ListFiles(d, rel + "/" + name, output);
            }
        }

        /// <summary>The content block of a skill folder (one line per file) or a single agent/prompt file. Empty when missing.</summary>
        public static string Block(string target, bool isDirectory)
        {
            if (!isDirectory) return File.Exists(target) ? ":" + FileHash(target) + "\n" : "";
            if (!Directory.Exists(target)) return "";
            var files = new List<string>();
            ListFiles(target, "", files);
            files.Sort(StringComparer.Ordinal);
            var sb = new StringBuilder();
            foreach (var f in files)
                sb.Append(f).Append(':').Append(FileHash(Path.Combine(target, f.Substring(1).Replace('/', Path.DirectorySeparatorChar)))).Append('\n');
            return sb.ToString();
        }

        /// <summary>Canonical JSON: sorted keys, no whitespace, ASCII-only strings.</summary>
        public static string Canonical(JToken? t)
        {
            if (t == null) return "null";
            switch (t.Type)
            {
                case JTokenType.Object:
                    return "{" + string.Join(",", ((JObject)t).Properties().OrderBy(p => p.Name, StringComparer.Ordinal)
                        .Select(p => Quote(p.Name) + ":" + Canonical(p.Value))) + "}";
                case JTokenType.Array:
                    return "[" + string.Join(",", ((JArray)t).Select(Canonical)) + "]";
                case JTokenType.String:
                    return Quote((string?)t ?? "");
                case JTokenType.Integer:
                    return ((long)t).ToString(CultureInfo.InvariantCulture);
                case JTokenType.Float:
                    return ((double)t).ToString("R", CultureInfo.InvariantCulture);
                case JTokenType.Boolean:
                    return (bool)t ? "true" : "false";
                default:
                    return "null";
            }
        }

        private static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var ch in s)
            {
                if (ch == '"') sb.Append("\\\"");
                else if (ch == '\\') sb.Append("\\\\");
                else if (ch < 0x20 || ch > 0x7e) sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }

        /// <summary>The package's content fingerprint over the given components.</summary>
        public static string Fingerprint(PluginPackage pkg, IEnumerable<PluginComponent> components)
        {
            var sb = new StringBuilder();
            foreach (var c in components.OrderBy(c => c.Kind).ThenBy(c => c.Name, StringComparer.Ordinal))
            {
                sb.Append(LockFormat.KindToString(c.Kind)).Append(':').Append(c.Name).Append('\n');
                if (c.Kind == ComponentKind.McpServer) sb.Append(Canonical(c.McpDefinition)).Append('\n');
                else sb.Append(Block(Path.Combine(pkg.RootPath, c.RelativePath.Replace('/', Path.DirectorySeparatorChar)), c.IsDirectory));
            }
            using (var sha = SHA1.Create()) return Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(sb.ToString())));
        }
    }
}
