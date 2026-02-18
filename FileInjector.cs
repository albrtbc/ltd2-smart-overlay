using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;

namespace LTD2SmartOverlay
{
    /// <summary>
    /// Handles injecting overlay JS/CSS files into the game's UI resources
    /// and restoring originals on cleanup.
    /// </summary>
    public sealed class FileInjector
    {
        private const string GatewayFileName = "gateway.html";
        private const string ScriptInjectionMarker = "<!-- LTD2SmartOverlay -->";
        private const string BackupExtension = ".smartoverlay-backup";

        private static readonly string[] EmbeddedResources = new[]
        {
            "overlay.js",
            "overlay.css",
            "units-database.js",
            "waves-database.js",
            "recommendation-engine.js"
        };

        private readonly string _uiResourcesPath;
        private readonly string _hudJsPath;
        private readonly Assembly _assembly;
        private readonly List<string> _injectedFiles = new List<string>();
        private string _gatewayBackupPath;

        public FileInjector(string uiResourcesPath, Assembly assembly)
        {
            _uiResourcesPath = uiResourcesPath;
            _hudJsPath = Path.Combine(uiResourcesPath, "hud", "js");
            _assembly = assembly;
        }

        public void InjectOverlayFiles()
        {
            ExtractEmbeddedResources();
            PatchGateway();
            Plugin.Log.LogInfo($"FileInjector: Injected {_injectedFiles.Count} files.");
        }

        public void RestoreOriginalFiles()
        {
            RestoreGateway();
            RemoveInjectedFiles();
            Plugin.Log.LogInfo("FileInjector: Restored original files.");
        }

        private void ExtractEmbeddedResources()
        {
            if (!Directory.Exists(_hudJsPath))
            {
                Plugin.Log.LogError($"HUD JS path not found: {_hudJsPath}");
                return;
            }

            foreach (var resourceName in EmbeddedResources)
            {
                var fullResourceName = $"LTD2SmartOverlay.Data.{resourceName}";
                var targetPath = Path.Combine(_hudJsPath, $"smartoverlay-{resourceName}");

                using (var stream = _assembly.GetManifestResourceStream(fullResourceName))
                {
                    if (stream == null)
                    {
                        Plugin.Log.LogWarning($"Embedded resource not found: {fullResourceName}");
                        continue;
                    }

                    using (var reader = new StreamReader(stream))
                    {
                        var content = reader.ReadToEnd();
                        try
                        {
                            File.WriteAllText(targetPath, content);
                            _injectedFiles.Add(targetPath);
                        }
                        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                        {
                            Plugin.Log.LogError($"Failed to write {targetPath}: {ex.Message}");
                        }
                    }
                }
            }
        }

        private void PatchGateway()
        {
            var gatewayPath = Path.Combine(_uiResourcesPath, GatewayFileName);
            if (!File.Exists(gatewayPath))
            {
                Plugin.Log.LogError($"Gateway file not found: {gatewayPath}");
                return;
            }

            string content;
            try
            {
                content = File.ReadAllText(gatewayPath);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                Plugin.Log.LogError($"Failed to read gateway: {ex.Message}");
                return;
            }

            if (content.Contains(ScriptInjectionMarker))
            {
                Plugin.Log.LogInfo("Gateway already patched, skipping.");
                return;
            }

            // Backup original
            _gatewayBackupPath = gatewayPath + BackupExtension;
            if (!File.Exists(_gatewayBackupPath))
            {
                try
                {
                    File.Copy(gatewayPath, _gatewayBackupPath, false);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    Plugin.Log.LogError($"Failed to backup gateway: {ex.Message}");
                    return;
                }
            }

            var scriptTags = BuildScriptTags();
            var injection = $"\n{ScriptInjectionMarker}\n{scriptTags}\n";

            // Inject before </body>
            var insertIndex = content.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (insertIndex < 0)
            {
                Plugin.Log.LogError("Could not find </body> in gateway.html");
                return;
            }

            content = content.Insert(insertIndex, injection);
            try
            {
                File.WriteAllText(gatewayPath, content);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                Plugin.Log.LogError($"Failed to write patched gateway: {ex.Message}");
                return;
            }
            Plugin.Log.LogInfo("Gateway patched with overlay scripts.");
        }

        private string BuildScriptTags()
        {
            var tags = new List<string>
            {
                "<link rel=\"stylesheet\" href=\"hud/js/smartoverlay-overlay.css\">",
                "<script type=\"text/javascript\" src=\"hud/js/smartoverlay-units-database.js\"></script>",
                "<script type=\"text/javascript\" src=\"hud/js/smartoverlay-waves-database.js\"></script>",
                "<script type=\"text/javascript\" src=\"hud/js/smartoverlay-recommendation-engine.js\"></script>",
                "<script type=\"text/javascript\" src=\"hud/js/smartoverlay-overlay.js\"></script>"
            };
            return string.Join("\n", tags);
        }

        private void RestoreGateway()
        {
            if (string.IsNullOrEmpty(_gatewayBackupPath) || !File.Exists(_gatewayBackupPath))
                return;

            var gatewayPath = Path.Combine(_uiResourcesPath, GatewayFileName);
            try
            {
                File.Delete(gatewayPath);
                File.Move(_gatewayBackupPath, gatewayPath);
            }
            catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
            {
                Plugin.Log.LogError($"Failed to restore gateway: {ex.Message}");
            }
        }

        private void RemoveInjectedFiles()
        {
            foreach (var file in _injectedFiles)
            {
                try
                {
                    if (File.Exists(file))
                        File.Delete(file);
                }
                catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
                {
                    Plugin.Log.LogWarning($"Failed to remove {file}: {ex.Message}");
                }
            }
            _injectedFiles.Clear();
        }
    }
}
