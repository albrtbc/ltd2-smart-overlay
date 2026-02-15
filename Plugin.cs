using System;
using System.IO;
using System.Reflection;
using BepInEx;
using BepInEx.Logging;
using UnityEngine;

namespace LTD2SmartOverlay
{
    [BepInPlugin("ltd2.mods.smartoverlay", "LTD2SmartOverlay", "0.1.0")]
    [BepInProcess("Legion TD 2.exe")]
    public sealed class Plugin : BaseUnityPlugin
    {
        internal static ManualLogSource Log { get; private set; }

        private void Awake()
        {
            Log = Logger;
            Log.LogInfo("LTD2SmartOverlay: Initializing...");

            try
            {
                var uiResourcesPath = Path.Combine(Application.dataPath, "uiresources", "AeonGT");

                if (!Directory.Exists(uiResourcesPath))
                {
                    Log.LogError($"UI resources path not found: {uiResourcesPath}");
                    return;
                }

                var injector = new FileInjector(uiResourcesPath, Assembly.GetExecutingAssembly());
                injector.InjectOverlayFiles();

                Log.LogInfo("LTD2SmartOverlay: Initialized successfully.");
            }
            catch (Exception ex)
            {
                Log.LogError($"LTD2SmartOverlay: Failed to initialize - {ex}");
            }
        }
    }
}
