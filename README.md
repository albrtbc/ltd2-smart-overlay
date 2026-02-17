# LTD2 Smart Overlay

A BepInEx plugin for **Legion TD 2** that provides real-time in-game overlays with unit recommendations, mercenary analysis, scouting data, and wave matchup forecasting.

## Features

- **Fighter Advisor** — Recommends optimal units to buy based on wave type matchups, gold efficiency, and tier relevance
- **STRONG/WEAK/NEUTRAL indicator** — Evaluates your army's strength against the current wave combining type matchups and fighter value
- **Mercenary Advisor** — Scores mercs against the opponent's fighter composition (armor/attack breakdown) with click-to-buy
- **PUSH/HOLD Forecast** — 5-wave forecast showing whether each wave's type matchup favors sending mercs or saving mythium
- **Scouting Panel** — Fetches win/loss, Elo, top masterminds, and wave 1 openers for all players via the Drachbot API
- **Settings Panel** — Toggle individual features on/off (Scouting, Hotkey Badges, Merc Adviser, Push/Hold Forecast, Defense Strength); settings persist across sessions
- **Draggable panels** — All panels can be repositioned and minimized; positions persist across games

## Requirements

- **Legion TD 2** (Epic Games / Steam)
- **BepInEx 5.x** (Unity IL2CPP or Mono, matching your game version)
- **.NET SDK 6.0+** (only needed if building from source)

## Installation

### Step 1 — Install BepInEx

1. Download **BepInEx 5** from [https://github.com/BepInEx/BepInEx/releases](https://github.com/BepInEx/BepInEx/releases)
   - For Legion TD 2, use the **BepInEx_win_x64** build (Unity Mono)
2. Extract the zip into your Legion TD 2 game folder:
   ```
   C:\Program Files\Epic Games\LegionTD2\
   ```
   After extracting, the folder structure should look like:
   ```
   LegionTD2/
   ├── BepInEx/
   │   ├── core/
   │   │   ├── BepInEx.dll
   │   │   ├── 0Harmony.dll
   │   │   └── ...
   │   ├── plugins/          <-- plugins go here
   │   └── ...
   ├── doorstop_config.ini
   ├── winhttp.dll
   ├── Legion TD 2.exe
   └── ...
   ```
3. **Launch the game once** and close it. This lets BepInEx generate its config files and confirms it's working. You should see a `BepInEx/LogOutput.log` file after the first run.

### Step 2 — Install the plugin

#### Option A: Pre-built DLL

1. Download `LTD2SmartOverlay.dll` from the releases
2. Copy it into the BepInEx plugins folder:
   ```
   C:\Program Files\Epic Games\LegionTD2\BepInEx\plugins\LTD2SmartOverlay.dll
   ```
3. Launch the game

#### Option B: Build from source

1. Clone this repository
2. Make sure BepInEx is installed (Step 1) — the project references DLLs from the game folder
3. Build the solution:
   ```
   dotnet build LTD2SmartOverlay/LTD2SmartOverlay.sln -c Release
   ```
4. Copy the output DLL to the plugins folder:
   ```
   copy LTD2SmartOverlay\bin\Release\netstandard2.1\LTD2SmartOverlay.dll "C:\Program Files\Epic Games\LegionTD2\BepInEx\plugins\"
   ```
5. Launch the game

> **Note:** The game must be closed when copying the DLL, otherwise the file will be locked.

## Usage

Once installed, the overlays appear automatically when you enter a match:

| Panel | Activation | Description |
|-------|-----------|-------------|
| **Fighter Advisor** | Automatic during build phase | Shows unit recommendations scored against the current wave |
| **STRONG/WEAK** | Automatic (updates on purchase) | Your army's strength vs current wave. Press Tab to sync board types |
| **Merc Advisor** | Press **Tab + Space** to scan enemy | Shows opponent's armor/attack breakdown and best mercs to send |
| **PUSH/HOLD** | After scanning enemy (Tab + Space) | 5-wave forecast for merc sending decisions |
| **Scouting** | Press **Tab** to open scoreboard | Auto-fetches player stats from Drachbot API |
| **Settings** | **SOS** button (main menu) or **...** button (in-game) | Toggle overlay features on/off |

### Controls

- **Drag** any panel header to reposition it
- **Minimize** panels with the `–` button in the header
- **Close** scouting panel with the `×` button
- **Click** a merc card to purchase it directly
- **Settings** — Open from the **SOS** button on the main menu, or the **...** button on the fighter panel header during a match. Each feature can be individually toggled. Settings persist across sessions via localStorage

## How it works

The plugin injects JavaScript and CSS into the game's Coherent UI layer at startup:

1. `Plugin.cs` — BepInEx entry point, triggers file injection on `Awake()`
2. `FileInjector.cs` — Extracts embedded JS/CSS into the game's `hud/js/` folder and patches `gateway.html` to load them
3. `recommendation-engine.js` — Scoring engine: damage matrix, type matchups, value analysis, push/hold evaluation
4. `overlay.js` — UI panels: hooks into game engine events (`refreshDashboardActions`, `refreshScoreboardInfo`, etc.)
5. `overlay.css` — Panel styling
6. `units-database.js` / `waves-database.js` — Static game data (unit stats, wave types)

The plugin hooks into the game's existing JavaScript `engine.on()` events to receive real-time data without any Harmony patches or game code modification.

## Uninstalling

1. Delete `LTD2SmartOverlay.dll` from `BepInEx/plugins/`
2. The plugin creates a backup of `gateway.html` on first run (`gateway.html.smartoverlay-backup`). If the game's UI looks broken after removing the plugin, restore this backup
3. To fully remove BepInEx, delete `winhttp.dll`, `doorstop_config.ini`, and the `BepInEx/` folder from the game directory

## Troubleshooting

- **Panels don't appear:** Check `BepInEx/LogOutput.log` for `LTD2SmartOverlay: Initialized successfully`. If not present, BepInEx may not be loading correctly
- **"Unknown" units in merc advisor:** The units database may be missing newer units. Press Tab to scan — the plugin also looks up units by name as a fallback
- **STRONG/WEAK not showing:** Press Tab at least once during a match to scan your board. After that, purchases are tracked automatically
- **DLL won't copy:** Make sure the game is fully closed before copying the DLL
