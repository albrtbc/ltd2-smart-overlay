/**
 * LTD2 Smart Overlay - Main UI Component
 *
 * Two panels:
 *   1. Fighter Overlay — hooks refreshDashboardActions to recommend purchases
 *   2. Mercenary Overlay — hooks refreshWindshieldActions + refreshScoreboardInfo
 *      to recommend optimal mercs vs opponent's fighter composition
 *
 * Both panels are independently draggable and minimizable.
 */
(function () {
    'use strict';

    var FIGHTER_ID = 'smart-overlay-root';
    var MERC_ID = 'merc-overlay-root';
    var SCOUT_ID = 'scout-overlay-root';
    var ICON_CDN = 'https://cdn.legiontd2.com/icons/';
    var STORAGE_KEY_FIGHTER = 'smartOverlayPosition';
    var STORAGE_KEY_MERC = 'mercOverlayPosition';
    var STORAGE_KEY_SCOUT = 'scoutOverlayPosition';
    var STORAGE_KEY_SETTINGS = 'smartOverlaySettings';
    var SETTINGS_ID = 'settings-overlay-root';
    var MAINMENU_ID = 'so-mainmenu-link';
    var SCOUT_API = 'https://stats.drachbot.site/api/drachbot_overlay/';
    var RENDER_DEBOUNCE_MS = 100;
    var TOP_PICK_RETRY_MS = 500;
    var MATCH_TOLERANCE = 0.2;
    var DRAG_MARGIN_X = 100;
    var DRAG_MARGIN_Y = 40;
    var VALUE_OK_THRESHOLD = 20;
    var XHR_TIMEOUT_MS = 8000;
    var OVERLAY_VERSION = '0.0.0';
    var GITHUB_API_LATEST = 'https://api.github.com/repos/albrtbc/ltd2-smart-overlay/releases/latest';

    // --- Shared state ---
    var state = {
        waveNum: 0,
        gold: 0,
        mythium: 0,
        inGame: false,
        currentValue: 0,
        recommendedValue: 0,
        recThresholds: null, // { redMin, yellowMin, greenMin, greenMax, yellowMax, redMax }
        // Fighter panel
        dashboardActions: null,
        fighterMinimized: false,
        fighterVisible: true,
        // Merc panel
        windshieldActions: null,
        defenderName: '',
        defenderNamePlain: '',
        scoreboardPlayers: null,
        defenderGrid: null,   // cached grid from last Tab press
        defenderValue: 0,     // opponent's total fighter value
        defenderValueDelta: '',  // delta string from scoreboard (e.g. "(-5)")
        mercMinimized: false,
        mercVisible: true,
        // Own army (for defense strength forecast)
        myGrid: null,
        myValue: 0,
        myAttackValue: {},
        myDefenseValue: {},
        // Scouting panel
        scoutingPlayers: {},   // {key: {name, isAlly, data, loading, error}}
        scoutingVisible: false,
        isBotGame: false,
        // Extra HUD bars (worker, king upgrades)
        gloveboxActions: null,
        leftboxActions: null,
        // Settings panel
        settingsVisible: false,
        showScouting: true,
        showHotkeyBadges: true,
        showMercAdviser: true,
        showPushForecast: true,
        showDefenseStrength: true,
        showTopPicks: true,
        topFighterIcons: [],     // [{name, rank}] top-3 recommendation icons
        // Update notification
        updateAvailable: null,   // {version, url} when a newer release exists
        updateDismissed: false
    };

    var renderTimer = null;
    var topPickRetryTimer = null;

    // --- Scoreboard view detection ---
    var scoreboardOpen = false;
    var showingEnemies = false;

    // --- Drag state (shared system, tracks which panel is being dragged) ---
    var dragTarget = null; // the root element being dragged
    var dragOffsetX = 0;
    var dragOffsetY = 0;

    // =========================================================================
    //  Utilities (Coherent UI compatible — no .closest(), no classList)
    // =========================================================================

    function findAncestorWithClass(el, className) {
        while (el && el !== document) {
            if (el.className && (' ' + el.className + ' ').indexOf(' ' + className + ' ') !== -1) {
                return el;
            }
            el = el.parentNode;
        }
        return null;
    }

    function hasClass(el, cls) {
        if (!el || !el.className) return false;
        return (' ' + el.className + ' ').indexOf(' ' + cls + ' ') !== -1;
    }

    function addClass(el, cls) {
        if (!hasClass(el, cls)) {
            el.className = (el.className ? el.className + ' ' : '') + cls;
        }
    }

    function removeClass(el, cls) {
        if (!el || !el.className) return;
        el.className = (' ' + el.className + ' ').replace(' ' + cls + ' ', ' ').replace(/^\s+|\s+$/g, '');
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function removeAllByClass(className) {
        var els = document.getElementsByClassName(className);
        while (els.length > 0) els[0].parentNode.removeChild(els[0]);
    }

    function escapeAttr(str) { return escapeHtml(str); }

    function getIconUrl(iconPath) {
        if (!iconPath) return '';
        var name = iconPath.replace(/^icons\//i, '').replace('.png', '');
        return ICON_CDN + name + '.png';
    }

    function scheduleRender() {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(function () {
            renderTimer = null;
            renderFighter();
            renderMerc();
            renderScouting();
            renderMainMenuLink();
            // Retry highlight: game may re-render dashboard icons after a delay
            if (topPickRetryTimer) clearTimeout(topPickRetryTimer);
            topPickRetryTimer = setTimeout(function () {
                topPickRetryTimer = null;
                applyTopPickHighlight();
            }, TOP_PICK_RETRY_MS);
        }, RENDER_DEBOUNCE_MS);
    }

    /**
     * Extract the defender player's grid from scoreboard data and cache it.
     * Finds "my" player row (matching globalState.savedUsername or
     * globalState.playFabId), then looks up its defender by name.
     */
    /**
     * Cache defender grid from scoreboard data.
     * Only called when showingEnemies is true (Tab+Space), so the grid
     * on our own row contains the ENEMY's fighters.
     */
    function cacheDefenderGrid(players) {
        if (!players || !players.length) return;

        var myName = '';
        if (typeof globalState !== 'undefined') {
            myName = globalState.savedUsername || '';
        }
        if (!myName) return;

        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            if (p.name !== myName) continue;

            // Cache the defender name
            if (p.defenderPlayerName) {
                state.defenderNamePlain = p.defenderPlayerName;
            }

            // In enemy view, grid contains the enemy's fighters
            if (p.grid && p.grid.length > 0) {
                state.defenderGrid = p.grid;
                // Use defenderPlayerValue if available, otherwise fall back to value
                state.defenderValue = p.defenderPlayerValue || p.value || 0;
                // Use the game's own delta string (e.g. "(-5)") — this is accurate
                state.defenderValueDelta = p.defenderValueDeltaString || '';
                console.log('[SmartOverlay] Cached enemy grid (' +
                    (state.defenderNamePlain || '?') + '): ' +
                    p.grid.length + ' fighters, value=' + state.defenderValue +
                    ', delta=' + state.defenderValueDelta);
            }
            return;
        }
    }

    /**
     * Cache our own grid from scoreboard data (normal view, not enemy view).
     */
    function cacheMyGrid(players) {
        if (!players || !players.length) return;

        var myName = '';
        if (typeof globalState !== 'undefined') {
            myName = globalState.savedUsername || '';
        }
        if (!myName) return;

        var eng = window.SmartOverlayEngine;
        if (!eng || !eng.analyzeGrid) return;

        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            if (p.name !== myName) continue;

            if (p.grid && p.grid.length > 0) {
                state.myGrid = p.grid;
                state.myValue = p.value || 0;
                var analysis = eng.analyzeGrid(p.grid);
                state.myDefenseValue = analysis.defenseValue;
                state.myAttackValue = analysis.attackValue;
                console.log('[SmartOverlay] Cached my grid: ' +
                    p.grid.length + ' fighters, value=' + state.myValue);
            }
            return;
        }
    }

    /**
     * Track a purchase by matching the value delta to a dashboard unit.
     * Accumulates the bought unit's types into myAttackValue/myDefenseValue.
     */
    function trackPurchaseByDelta(delta) {
        if (!state.dashboardActions) return;

        var eng = window.SmartOverlayEngine;
        if (!eng) return;

        // Build icon+name lookup to find the unit data
        var bestMatch = null;
        var bestDiff = Infinity;

        for (var i = 0; i < state.dashboardActions.length; i++) {
            var action = state.dashboardActions[i];
            var cost = action.goldCost || 0;
            if (cost <= 0) continue;
            var diff = Math.abs(cost - delta);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestMatch = action;
            }
        }

        // Accept if within 20% tolerance (upgrades may have slight cost differences)
        if (!bestMatch || bestDiff > delta * MATCH_TOLERANCE) return;

        // Look up unit data from database
        var result = eng.scoreFromDashboardActions([bestMatch], state.waveNum, 99999);
        if (result.recommendations && result.recommendations.length > 0) {
            var unit = result.recommendations[0].unit;
            if (unit && unit.armorType && unit.attackType) {
                var cost = bestMatch.goldCost || 0;
                var armor = unit.armorType;
                var attack = unit.attackType;
                state.myDefenseValue[armor] = (state.myDefenseValue[armor] || 0) + cost;
                state.myAttackValue[attack] = (state.myAttackValue[attack] || 0) + cost;
                // Mark that we have tracking data (even without Tab)
                if (!state.myGrid) state.myGrid = [1]; // truthy placeholder
                console.log('[SmartOverlay] Tracked purchase: ' + unit.name +
                    ' (' + attack + '/' + armor + ', ' + cost + 'g)');
            }
        }
    }

    // =========================================================================
    //  Scouting — extract player names from scoreboard & loading stickers
    // =========================================================================

    function isBotName(name) {
        if (!name) return false;
        var plain = name.replace(/<[^>]+>/g, '').trim().toLowerCase();
        // LTD2 bot names: "Easy Bot", "Medium Bot", "Hard Bot", "Expert Bot", "Extreme Bot", etc.
        return /\bbot\b/.test(plain);
    }

    var scoutingDumped = false;

    // --- Loading sticker capture (early opponent detection) ---
    var loadingStickerPlayers = []; // [{slot, name}]
    var myTeamDetected = 0; // 0 = unknown, 1 = team1 (slots 1-4), 2 = team2 (slots 5-8)

    /**
     * Add a single player to scouting if not already known.
     * Returns true if the player was added.
     */
    function addScoutingPlayer(name, isAlly) {
        if (!name || !state.showScouting || state.isBotGame) return false;
        var plainName = name.replace(/<[^>]+>/g, '').trim();
        if (!plainName) return false;

        // Check if already known
        for (var key in state.scoutingPlayers) {
            if (state.scoutingPlayers.hasOwnProperty(key) &&
                state.scoutingPlayers[key].name === plainName) {
                return false;
            }
        }

        // Find next index
        var nextIdx = 0;
        for (var k in state.scoutingPlayers) {
            if (state.scoutingPlayers.hasOwnProperty(k)) {
                var n = parseInt(k, 10);
                if (n > nextIdx) nextIdx = n;
            }
        }
        nextIdx++;

        state.scoutingPlayers[nextIdx] = {
            name: plainName, isAlly: isAlly,
            data: null, loading: true, error: null
        };
        fetchScoutingData(plainName, nextIdx);

        if (!state.scoutingVisible) {
            state.scoutingVisible = true;
        }
        console.log('[SmartOverlay] Scouting: added ' + (isAlly ? 'ally' : 'opponent') +
            ' "' + plainName + '"');
        scheduleRender();
        return true;
    }

    /**
     * Capture a loading sticker event and determine ally/opponent by slot.
     * Slots 1-4 = Team 1 (West), slots 5-8 = Team 2 (East).
     */
    function captureFromLoadingSticker(slot, displayName) {
        if (!displayName || displayName === '_closed' || displayName === '_open' ||
            displayName === '(Closed)') return;
        // Ignore NPC slots (9-12)
        if (slot >= 9) return;

        // Avoid duplicates in our buffer
        for (var i = 0; i < loadingStickerPlayers.length; i++) {
            if (loadingStickerPlayers[i].name === displayName) return;
        }
        loadingStickerPlayers.push({ slot: slot, name: displayName });
        processLoadingStickers();
    }

    /**
     * Once we know our team, classify all buffered loading sticker players.
     */
    function processLoadingStickers() {
        if (loadingStickerPlayers.length === 0) return;
        if (!state.showScouting || state.isBotGame) return;

        // Determine our username
        var myName = '';
        if (typeof globalState !== 'undefined' && globalState.savedUsername) {
            myName = globalState.savedUsername;
        }
        if (!myName) return;

        // Detect our team from our own slot
        if (myTeamDetected === 0) {
            for (var i = 0; i < loadingStickerPlayers.length; i++) {
                if (loadingStickerPlayers[i].name === myName) {
                    myTeamDetected = (loadingStickerPlayers[i].slot <= 4) ? 1 : 2;
                    break;
                }
            }
        }
        if (myTeamDetected === 0) return; // still can't determine team

        var myMin = (myTeamDetected === 1) ? 1 : 5;
        var myMax = (myTeamDetected === 1) ? 4 : 8;

        // Check for bot opponents before scouting anyone
        for (var b = 0; b < loadingStickerPlayers.length; b++) {
            var bp = loadingStickerPlayers[b];
            var isOpponent = bp.slot < myMin || bp.slot > myMax;
            if (isOpponent && isBotName(bp.name)) {
                state.isBotGame = true;
                state.scoutingVisible = false;
                console.log('[SmartOverlay] Bot game detected from loading sticker — scouting disabled.');
                return;
            }
        }

        for (var j = 0; j < loadingStickerPlayers.length; j++) {
            var sp = loadingStickerPlayers[j];
            var isAlly = (sp.slot >= myMin && sp.slot <= myMax);
            addScoutingPlayer(sp.name, isAlly);
        }
    }

    function captureScoutingFromScoreboard(players) {
        if (!players || !players.length) return;
        if (!state.showScouting) return;

        // Dump first scoreboard data for debugging
        if (!scoutingDumped) {
            scoutingDumped = true;
            for (var d = 0; d < players.length; d++) {
                console.log('[SmartOverlay] Scoreboard player[' + d + ']: ' +
                    JSON.stringify(Object.keys(players[d])) +
                    ' name=' + (players[d].name || '') +
                    ' defender=' + (players[d].defenderPlayerName || ''));
            }
        }

        // Detect bot game: check if all opponents are bots
        if (!state.isBotGame) {
            var allBots = true;
            var hasOpponent = false;
            for (var b = 0; b < players.length; b++) {
                if (players[b].defenderPlayerName) {
                    hasOpponent = true;
                    if (!isBotName(players[b].defenderPlayerName)) {
                        allBots = false;
                        break;
                    }
                }
            }
            if (hasOpponent && allBots) {
                state.isBotGame = true;
                state.scoutingVisible = false;
                console.log('[SmartOverlay] Bot game detected — scouting disabled.');
                return;
            }
        } else {
            return;
        }

        // Players in the scoreboard array are allies (including me).
        // Their defenderPlayerName fields are the opponents.
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            if (p.name) addScoutingPlayer(p.name, true);
            if (p.defenderPlayerName) addScoutingPlayer(p.defenderPlayerName, false);
        }
    }

    // =========================================================================
    //  Scouting API fetch
    // =========================================================================

    function fetchScoutingData(playerName, playerNum) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', SCOUT_API + encodeURIComponent(playerName) + '?_=' + Date.now(), true);
        xhr.timeout = XHR_TIMEOUT_MS;
        xhr.onload = function () {
            if (!state.scoutingPlayers[playerNum]) return;
            if (xhr.status === 200) {
                try {
                    var data = JSON.parse(xhr.responseText);
                    state.scoutingPlayers[playerNum].data = data;
                    state.scoutingPlayers[playerNum].loading = false;
                } catch (e) {
                    state.scoutingPlayers[playerNum].error = true;
                    state.scoutingPlayers[playerNum].loading = false;
                    console.warn('[SmartOverlay] Failed to parse scouting data for "' + playerName + '"');
                }
            } else {
                state.scoutingPlayers[playerNum].error = true;
                state.scoutingPlayers[playerNum].loading = false;
                console.warn('[SmartOverlay] Scouting API returned ' + xhr.status + ' for "' + playerName + '"');
            }
            scheduleRender();
        };
        xhr.onerror = xhr.ontimeout = function () {
            if (!state.scoutingPlayers[playerNum]) return;
            state.scoutingPlayers[playerNum].error = true;
            state.scoutingPlayers[playerNum].loading = false;
            console.warn('[SmartOverlay] Scouting request failed for "' + playerName + '"');
            scheduleRender();
        };
        xhr.send();
    }

    // =========================================================================
    //  Update check
    // =========================================================================

    function compareVersions(a, b) {
        var pa = a.replace(/^v/, '').split('.');
        var pb = b.replace(/^v/, '').split('.');
        for (var i = 0; i < 3; i++) {
            var na = parseInt(pa[i] || '0', 10);
            var nb = parseInt(pb[i] || '0', 10);
            if (na < nb) return -1;
            if (na > nb) return 1;
        }
        return 0;
    }

    function checkForUpdates() {
        if (OVERLAY_VERSION === '0.0.0') return; // dev mode

        // Check if user already dismissed this or a newer version
        try {
            var dismissed = localStorage.getItem('dismissed_update_version');
            if (dismissed && compareVersions(dismissed, OVERLAY_VERSION) > 0) {
                // Already dismissed a version newer than current — skip check
                return;
            }
        } catch (e) { /* ignore */ }

        var xhr = new XMLHttpRequest();
        xhr.open('GET', GITHUB_API_LATEST + '?_=' + Date.now(), true);
        xhr.timeout = 10000;
        xhr.onload = function () {
            if (xhr.status !== 200) return;
            try {
                var data = JSON.parse(xhr.responseText);
                var latestTag = data.tag_name || '';
                var latestVersion = latestTag.replace(/^v/, '');
                if (compareVersions(OVERLAY_VERSION, latestVersion) < 0) {
                    // Check if this specific version was dismissed
                    try {
                        var dismissed = localStorage.getItem('dismissed_update_version');
                        if (dismissed === latestVersion) return;
                    } catch (e) { /* ignore */ }

                    state.updateAvailable = {
                        version: latestVersion,
                        url: data.html_url || ''
                    };
                    renderMainMenuLink();
                    console.log('[SmartOverlay] Update available: v' + latestVersion);
                }
            } catch (e) { /* ignore parse errors */ }
        };
        xhr.onerror = xhr.ontimeout = function () {
            console.warn('[SmartOverlay] Update check failed');
        };
        xhr.send();
    }

    // =========================================================================
    //  Position persistence
    // =========================================================================

    function savePosition(el, storageKey) {
        try {
            localStorage.setItem(storageKey, JSON.stringify({
                left: el.style.left, top: el.style.top
            }));
        } catch (e) { /* ignore */ }
    }

    function restorePosition(el, storageKey) {
        try {
            var saved = localStorage.getItem(storageKey);
            if (saved) {
                var pos = JSON.parse(saved);
                if (pos.left && pos.top) {
                    el.style.left = pos.left;
                    el.style.top = pos.top;
                    el.style.right = 'auto';
                }
            }
        } catch (e) { /* ignore */ }
    }

    // =========================================================================
    //  Settings persistence
    // =========================================================================

    var SETTINGS_KEYS = ['showScouting', 'showHotkeyBadges', 'showMercAdviser',
                         'showPushForecast', 'showDefenseStrength', 'showTopPicks'];

    function loadSettings() {
        try {
            var saved = localStorage.getItem(STORAGE_KEY_SETTINGS);
            if (saved) {
                var obj = JSON.parse(saved);
                for (var i = 0; i < SETTINGS_KEYS.length; i++) {
                    var k = SETTINGS_KEYS[i];
                    if (obj.hasOwnProperty(k)) {
                        state[k] = !!obj[k];
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    function saveSettings() {
        try {
            var obj = {};
            for (var i = 0; i < SETTINGS_KEYS.length; i++) {
                obj[SETTINGS_KEYS[i]] = state[SETTINGS_KEYS[i]];
            }
            localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(obj));
        } catch (e) { /* ignore */ }
    }

    // =========================================================================
    //  Drag system (shared for both panels)
    // =========================================================================

    function initDrag() {
        document.addEventListener('mousedown', function (e) {
            var header = findAncestorWithClass(e.target, 'so-header') ||
                         findAncestorWithClass(e.target, 'mo-header') ||
                         findAncestorWithClass(e.target, 'sc-header') ||
                         findAncestorWithClass(e.target, 'sg-header');
            if (!header) return;
            if (findAncestorWithClass(e.target, 'so-toggle-btn') ||
                findAncestorWithClass(e.target, 'mo-toggle-btn') ||
                findAncestorWithClass(e.target, 'sc-toggle-btn') ||
                findAncestorWithClass(e.target, 'sg-toggle-btn')) return;

            // Determine which panel owns this header
            var panel = findAncestorWithClass(e.target, 'so-panel') ||
                        findAncestorWithClass(e.target, 'mo-panel') ||
                        findAncestorWithClass(e.target, 'sc-panel') ||
                        findAncestorWithClass(e.target, 'sg-panel');
            if (!panel) return;

            dragTarget = panel;
            var rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            addClass(panel, 'so-dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragTarget) return;
            var x = Math.max(0, Math.min(window.innerWidth - DRAG_MARGIN_X, e.clientX - dragOffsetX));
            var y = Math.max(0, Math.min(window.innerHeight - DRAG_MARGIN_Y, e.clientY - dragOffsetY));
            dragTarget.style.left = x + 'px';
            dragTarget.style.top = y + 'px';
            dragTarget.style.right = 'auto';
            e.preventDefault();
        });

        document.addEventListener('mouseup', function () {
            if (!dragTarget) return;
            removeClass(dragTarget, 'so-dragging');
            // Save position based on panel id (settings panel doesn't persist position)
            var key = dragTarget.id === MERC_ID ? STORAGE_KEY_MERC
                    : dragTarget.id === SCOUT_ID ? STORAGE_KEY_SCOUT
                    : dragTarget.id === SETTINGS_ID ? null
                    : STORAGE_KEY_FIGHTER;
            if (key) savePosition(dragTarget, key);
            dragTarget = null;
        });
    }

    // =========================================================================
    //  Hotkey badges on the game's unit / merc / king bars
    // =========================================================================

    var SHORTCUT_DISPLAY = {
        'COMMA': ',', 'PERIOD': '.', 'SLASH': '/',
        'SEMICOLON': ';', 'QUOTE': "'", 'MINUS': '-', 'EQUALS': '=',
        'BACKQUOTE': '`', 'SPACE': 'Spc'
    };

    function extractShortcut(header) {
        if (!header) return '';
        var match = header.match(/\[([A-Za-z0-9_]+)\]/);
        if (!match) return '';
        var raw = match[1].toUpperCase();
        return SHORTCUT_DISPLAY[raw] || raw;
    }

    function iconBaseName(path) {
        if (!path) return '';
        return path.replace(/\\/g, '/').split('/').pop().replace(/\.png$/i, '').toLowerCase();
    }

    function isSmallBadgeAction(header) {
        if (!header) return false;
        var lower = header.toLowerCase();
        return /upgrade|king|train\s*worker/.test(lower);
    }

    // Master map: icon name → { label, small }. Updated every refresh so
    // shortcuts stay correct after rerolls.
    var masterShortcutMap = {};
    var hotkeyTimer = null;
    var hotkeyRetryTimer = null;

    function scheduleHotkeyInject() {
        if (hotkeyTimer) clearTimeout(hotkeyTimer);
        if (hotkeyRetryTimer) clearTimeout(hotkeyRetryTimer);
        hotkeyTimer = setTimeout(function () {
            hotkeyTimer = null;
            mergeActionsIntoMaster();
            applyHotkeyBadges();
            applyTopPickHighlight();
            // Second pass: game may render icons after a delay
            hotkeyRetryTimer = setTimeout(function () {
                hotkeyRetryTimer = null;
                applyHotkeyBadges();
                applyTopPickHighlight();
            }, 400);
        }, 80);
    }

    function resetHotkeyBadges() {
        masterShortcutMap = {};
        actionContainersLogged = false;
        // Remove any live badges from DOM
        removeAllByClass('so-hotkey-badge');
        clearTopPickHighlights();
        state.topFighterIcons = [];
    }

    function mergeActionsIntoMaster() {
        var sources = [
            { actions: state.dashboardActions, forceSmall: false },
            { actions: state.windshieldActions, forceSmall: true },
            { actions: state.gloveboxActions,   forceSmall: true },
            { actions: state.leftboxActions,    forceSmall: true }
        ];
        for (var s = 0; s < sources.length; s++) {
            var acts = sources[s].actions;
            if (!acts) continue;
            for (var i = 0; i < acts.length; i++) {
                var a = acts[i];
                var key = iconBaseName(a.image);
                var sc = extractShortcut(a.header);
                if (!key || !sc) continue;
                var small = sources[s].forceSmall || isSmallBadgeAction(a.header);
                masterShortcutMap[key] = { label: sc, small: small };
            }
        }
    }

    var actionContainersLogged = false;

    function getActionContainers() {
        var names = ['dashboard', 'windshield', 'glovebox', 'leftbox'];
        var found = [];
        for (var i = 0; i < names.length; i++) {
            var el = document.getElementById(names[i]);
            if (el) { found.push(el); continue; }
            var byClass = document.getElementsByClassName(names[i]);
            for (var k = 0; k < byClass.length; k++) {
                found.push(byClass[k]);
            }
        }
        if (!actionContainersLogged && found.length > 0) {
            actionContainersLogged = true;
            console.log('[SmartOverlay] Found ' + found.length + ' action containers for hotkey badges.');
        }
        return found;
    }

    function applyHotkeyBadges() {
        if (!state.showHotkeyBadges) return;
        if (!Object.keys(masterShortcutMap).length) return;

        var containers = getActionContainers();
        var searchRoots = containers.length > 0 ? containers : null;

        // If no known containers, skip — avoids polluting informational panels
        if (!searchRoots) {
            if (!actionContainersLogged) {
                actionContainersLogged = true;
                console.log('[SmartOverlay] No action containers found — hotkey badges disabled.');
            }
            return;
        }

        for (var ri = 0; ri < searchRoots.length; ri++) {
            var imgs = searchRoots[ri].getElementsByTagName('img');
            for (var j = 0; j < imgs.length; j++) {
                var img = imgs[j];
                var name = iconBaseName(img.getAttribute('src'));
                if (!name || !masterShortcutMap[name]) continue;

                var parent = img.parentNode;
                if (!parent) continue;
                var info = masterShortcutMap[name];

                // Check if this img already has a badge sibling
                var existingBadge = null;
                var children = parent.childNodes;
                for (var c = 0; c < children.length; c++) {
                    if (children[c].className &&
                        (' ' + children[c].className + ' ').indexOf(' so-hotkey-badge ') !== -1) {
                        existingBadge = children[c];
                        break;
                    }
                }

                if (existingBadge) {
                    // Update label if shortcut changed (e.g. after reroll)
                    if (existingBadge.textContent !== info.label) {
                        existingBadge.textContent = info.label;
                    }
                    continue;
                }

                var badge = document.createElement('span');
                badge.className = info.small
                    ? 'so-hotkey-badge so-hotkey-sm'
                    : 'so-hotkey-badge';
                badge.textContent = info.label;

                var pos = (parent.style && parent.style.position) || '';
                if (!pos || pos === 'static') {
                    parent.style.position = 'relative';
                }
                parent.appendChild(badge);
            }
        }
    }

    function clearTopPickHighlights() {
        removeAllByClass('so-top-pick');
        // Remove badge color classes
        var goldBadges = document.getElementsByClassName('so-hotkey-gold');
        while (goldBadges.length > 0) {
            removeClass(goldBadges[0], 'so-hotkey-gold');
        }
        var greenBadges = document.getElementsByClassName('so-hotkey-green');
        while (greenBadges.length > 0) {
            removeClass(greenBadges[0], 'so-hotkey-green');
        }
    }

    function applyTopPickHighlight() {
        clearTopPickHighlights();

        if (!state.topFighterIcons.length) return;

        var containers = getActionContainers();
        if (!containers.length) return;

        // Build lookup: iconName → CSS class
        var lookup = {};
        for (var t = 0; t < state.topFighterIcons.length; t++) {
            var entry = state.topFighterIcons[t];
            lookup[entry.name] = entry.rank === 1
                ? 'so-top-pick so-top-pick-gold'
                : 'so-top-pick so-top-pick-green';
        }

        for (var ri = 0; ri < containers.length; ri++) {
            var imgs = containers[ri].getElementsByTagName('img');
            for (var i = 0; i < imgs.length; i++) {
                var name = iconBaseName(imgs[i].getAttribute('src'));
                if (!name || !lookup[name]) continue;

                var parent = imgs[i].parentNode;
                if (!parent) continue;

                // Skip if already has a highlight overlay
                var hasOverlay = false;
                var children = parent.childNodes;
                for (var c = 0; c < children.length; c++) {
                    if (children[c].className &&
                        (' ' + children[c].className + ' ').indexOf(' so-top-pick ') !== -1) {
                        hasOverlay = true;
                        break;
                    }
                }
                if (hasOverlay) continue;

                var pos = (parent.style && parent.style.position) || '';
                if (!pos || pos === 'static') {
                    parent.style.position = 'relative';
                }

                var overlay = document.createElement('span');
                overlay.className = lookup[name];
                parent.appendChild(overlay);

                // Color the hotkey badge too
                var badgeCls = lookup[name].indexOf('gold') !== -1
                    ? 'so-hotkey-gold' : 'so-hotkey-green';
                var children2 = parent.childNodes;
                for (var b = 0; b < children2.length; b++) {
                    if (children2[b].className &&
                        (' ' + children2[b].className + ' ').indexOf(' so-hotkey-badge ') !== -1) {
                        addClass(children2[b], badgeCls);
                        break;
                    }
                }
            }
        }
    }

    // =========================================================================
    //  Engine event bindings
    // =========================================================================

    function bindGameEvents() {
        if (typeof engine === 'undefined') {
            console.warn('[SmartOverlay] engine not available.');
            return;
        }

        // --- Fighter events ---
        engine.on('refreshWaveNumber', function (waveNumber) {
            // New game started — reset bot detection and scouting
            if (waveNumber === 1 && state.waveNum !== 1) {
                state.isBotGame = false;
                state.scoutingPlayers = {};
                state.scoutingVisible = false;
                loadingStickerPlayers = [];
                myTeamDetected = 0;
                scoutingDumped = false;
                resetHotkeyBadges();
            }
            state.waveNum = waveNumber;
            state.inGame = true;
            scheduleRender();
        });

        engine.on('refreshGold', function (value) {
            state.gold = value;
            scheduleRender();
        });

        engine.on('refreshMythium', function (value) {
            state.mythium = value;
            scheduleRender();
        });

        engine.on('refreshRecommendedValues', function (waveNumber, currentValue, recommendedValue, thresholds) {
            var prevValue = state.currentValue;
            state.currentValue = currentValue;
            state.recommendedValue = recommendedValue;
            state.recThresholds = thresholds || null;

            // Detect purchase: value went up → find matching unit from dashboard
            if (prevValue > 0 && currentValue > prevValue && state.dashboardActions) {
                var delta = currentValue - prevValue;
                trackPurchaseByDelta(delta);
            }
            // Detect sell: value went down → reset types (wait for Tab refresh)
            if (prevValue > 0 && currentValue < prevValue) {
                state.myAttackValue = {};
                state.myDefenseValue = {};
                state.myGrid = null;
            }

            scheduleRender();
        });

        engine.on('refreshDashboardActions', function (actions) {
            state.dashboardActions = actions;
            state.inGame = true;
            scheduleRender();
            scheduleHotkeyInject();
        });

        // --- Mercenary events ---
        engine.on('refreshWindshieldActions', function (actions) {
            state.windshieldActions = actions;
            state.inGame = true;
            scheduleRender();
            scheduleHotkeyInject();
        });

        // --- Glovebox & Leftbox (worker, king upgrades) ---
        engine.on('refreshGloveboxActions', function (actions) {
            state.gloveboxActions = actions;
            scheduleHotkeyInject();
        });
        engine.on('refreshLeftboxActions', function (actions) {
            state.leftboxActions = actions;
            scheduleHotkeyInject();
        });

        engine.on('refreshWindshieldDefender', function (defenderName) {
            state.defenderName = defenderName || '';
            state.defenderNamePlain = (defenderName || '').replace(/<[^>]+>/g, '').trim();
            // Add defender as opponent for scouting (early detection)
            if (state.defenderNamePlain) {
                addScoutingPlayer(state.defenderNamePlain, false);
            }
            scheduleRender();
        });

        // --- Loading sticker events (early opponent detection during loading screen) ---
        // The game sends loading sticker data for ALL players during loading.
        // Slot 1-4 = Team 1 (West), Slot 5-8 = Team 2 (East).
        engine.on('refreshLoadingSticker', function () {
            var args = Array.prototype.slice.call(arguments);
            console.log('[SmartOverlay] refreshLoadingSticker: ' + JSON.stringify(args));
            // Expected: (slot, displayName, rating, country, guild, guildAvatar)
            if (args.length >= 2 && typeof args[0] === 'number' && typeof args[1] === 'string') {
                captureFromLoadingSticker(args[0], args[1]);
            } else if (args.length >= 1 && typeof args[0] === 'object' && args[0] !== null) {
                var obj = args[0];
                captureFromLoadingSticker(
                    obj.tmpPlayer || obj.slot || obj.playerSlot || 0,
                    obj.displayName || obj.name || ''
                );
            }
        });

        // Versus overlay fires at game start with all matchup info
        engine.on('showVersusOverlay', function () {
            var args = Array.prototype.slice.call(arguments);
            console.log('[SmartOverlay] showVersusOverlay: ' + JSON.stringify(args));
            // Try to extract player names from versus info
            if (args.length >= 1 && args[0] && typeof args[0].length === 'number') {
                for (var v = 0; v < args[0].length; v++) {
                    var info = args[0][v];
                    if (!info) continue;
                    // Try common property names for opponent
                    var oppName = info.opponentName || info.defenderName || info.rightName ||
                        info.enemyName || info.name2 || '';
                    if (oppName) addScoutingPlayer(oppName, false);
                    // Try common property names for ally
                    var allyName = info.playerName || info.attackerName || info.leftName ||
                        info.name1 || '';
                    if (allyName) addScoutingPlayer(allyName, true);
                }
            }
        });

        // Track scoreboard open/close and enemy view toggle
        engine.on('enableScoreboard', function (enabled) {
            scoreboardOpen = enabled;
            if (!enabled) showingEnemies = false;
        });

        document.addEventListener('keydown', function (e) {
            // Space (keyCode 32) while scoreboard is open toggles enemy view
            if (scoreboardOpen && e.keyCode === 32) {
                showingEnemies = !showingEnemies;
            }
        });

        engine.on('refreshScoreboardInfo', function (scoreboardInfo) {
            state.scoreboardPlayers = scoreboardInfo;
            // Scouting: capture player names from every scoreboard event
            if (scoreboardInfo && scoreboardInfo.length) {
                captureScoutingFromScoreboard(scoreboardInfo);
            }
            if (scoreboardInfo && scoreboardInfo.length) {
                if (showingEnemies) {
                    // Tab+Space: cache enemy fighters
                    cacheDefenderGrid(scoreboardInfo);
                } else {
                    // Tab only: cache our own fighters
                    cacheMyGrid(scoreboardInfo);
                }
                scheduleRender();
            }
        });

        // Read initial globalState
        if (typeof globalState !== 'undefined') {
            if (globalState.waveNumber > 0) state.waveNum = globalState.waveNumber;
            if (globalState.gold > 0) state.gold = globalState.gold;
        }

        console.log('[SmartOverlay] Engine events bound.');
    }

    // =========================================================================
    //  Keyboard shortcuts
    // =========================================================================

    // No keyboard shortcuts — minimize/show only via panel buttons

    // =========================================================================
    //  Initialization
    // =========================================================================

    function init() {
        if (document.getElementById(FIGHTER_ID)) return;

        // Load saved settings before anything else
        loadSettings();

        // Fighter panel
        var fighterRoot = document.createElement('div');
        fighterRoot.id = FIGHTER_ID;
        fighterRoot.className = 'so-panel';
        document.body.appendChild(fighterRoot);
        restorePosition(fighterRoot, STORAGE_KEY_FIGHTER);

        // Merc panel
        var mercRoot = document.createElement('div');
        mercRoot.id = MERC_ID;
        mercRoot.className = 'mo-panel';
        document.body.appendChild(mercRoot);
        restorePosition(mercRoot, STORAGE_KEY_MERC);

        // Scouting panel
        var scoutRoot = document.createElement('div');
        scoutRoot.id = SCOUT_ID;
        scoutRoot.className = 'sc-panel';
        document.body.appendChild(scoutRoot);
        restorePosition(scoutRoot, STORAGE_KEY_SCOUT);

        // Settings panel
        var settingsRoot = document.createElement('div');
        settingsRoot.id = SETTINGS_ID;
        settingsRoot.className = 'sg-panel so-hidden';
        document.body.appendChild(settingsRoot);

        // Main menu settings button
        var mmBtn = document.createElement('div');
        mmBtn.id = MAINMENU_ID;
        mmBtn.className = 'so-mm-btn so-hidden';
        document.body.appendChild(mmBtn);

        bindGameEvents();
        initDrag();
        renderFighter();
        renderMerc();
        renderScouting();
        renderMainMenuLink();
        checkForUpdates();

        console.log('[SmartOverlay] Initialized (fighter + merc + scouting + settings panels).');
    }

    // =========================================================================
    //  Fighter panel rendering
    // =========================================================================

    function renderFighter() {
        if (dragTarget) return;

        var root = document.getElementById(FIGHTER_ID);
        if (!root) return;

        root.className = 'so-panel';

        // Hide completely when not in game or no data yet
        if (!state.fighterVisible || !state.inGame ||
            !state.dashboardActions || state.dashboardActions.length === 0) {
            addClass(root, 'so-hidden');
            root.innerHTML = '';
            return;
        }
        if (state.fighterMinimized) {
            addClass(root, 'so-minimized');
        }

        var eng = window.SmartOverlayEngine;
        if (!eng) return;

        var result = eng.scoreFromDashboardActions(
            state.dashboardActions, state.waveNum, state.gold
        );

        // Defense strength: current board types + value vs recommended
        var defStrength = null;
        if (state.showDefenseStrength && eng.evaluateDefenseStrength && state.myGrid) {

            var typeResult = eng.evaluateDefenseStrength(
                state.waveNum, state.myDefenseValue, state.myAttackValue
            );

            if (typeResult) {
                var typeScore = typeResult.score;

                var valueScore = 0;
                if (state.recommendedValue > 0 && state.currentValue > 0) {
                    valueScore = (state.currentValue - state.recommendedValue) / state.recommendedValue;
                    // Clamp to prevent extreme distortion from leaks/overinvest
                    valueScore = Math.max(-0.3, Math.min(0.3, valueScore));
                }

                // Value and types roughly equal weight
                var combined = typeScore + valueScore * 1.0;
                var threshold = (eng && eng.STRENGTH_THRESHOLD) || 0.04;
                var rec = 'NEUTRAL';
                if (combined > threshold) rec = 'STRONG';
                else if (combined < -threshold) rec = 'WEAK';

                // Granular percentage for display
                var typePct = typeResult.pct || Math.round(typeScore * 100);

                defStrength = {
                    recommendation: rec,
                    combined: combined,
                    typeScore: typeScore,
                    typePct: typePct,
                    valueScore: valueScore,
                    waveDmgType: typeResult.waveDmgType,
                    waveDefType: typeResult.waveDefType
                };
            }
        }

        // Track top-3 icons for dashboard highlight
        // Suppress when disabled or a unit is selected (Sell action visible)
        state.topFighterIcons = [];
        var hasSell = !state.showTopPicks;
        for (var si = 0; si < state.dashboardActions.length; si++) {
            var h = state.dashboardActions[si].header;
            if (h && h.toLowerCase().indexOf('sell') !== -1) {
                hasSell = true;
                break;
            }
        }
        if (!hasSell) {
            // Match recommendations to dashboard actions via shortcut key,
            // so we use the same icon name that the game's DOM uses.
            var recs = result.recommendations || [];
            for (var ti = 0; ti < Math.min(3, recs.length); ti++) {
                var rec = recs[ti];
                if (!rec || !rec.shortcut) continue;
                for (var ai = 0; ai < state.dashboardActions.length; ai++) {
                    var act = state.dashboardActions[ai];
                    if (extractShortcut(act.header) === rec.shortcut) {
                        state.topFighterIcons.push({
                            name: iconBaseName(act.image),
                            rank: ti + 1
                        });
                        break;
                    }
                }
            }
        }
        applyTopPickHighlight();

        root.innerHTML = renderFighterHeader() +
            renderWaveInfo(result.wave) +
            renderDefenseStrength(defStrength) +
            renderFighterRecs(result.recommendations) +
            renderFighterFooter(result.totalScored);

        bindFighterMinBtn();
    }

    function bindFighterMinBtn() {
        var btn = document.getElementById('so-minimize-btn');
        if (btn) {
            btn.onclick = function () {
                state.fighterMinimized = !state.fighterMinimized;
                renderFighter();
            };
        }
        var gear = document.getElementById('so-settings-btn');
        if (gear) {
            gear.onclick = function () {
                state.settingsVisible = !state.settingsVisible;
                renderSettings();
            };
        }
    }

    function renderFighterHeader() {
        var waveText = state.waveNum > 0 ? 'Wave ' + state.waveNum : 'Pre-game';
        var goldText = state.gold > 0 ? ' | ' + state.gold + 'g' : '';
        var btnLabel = state.fighterMinimized ? '+' : '\u2013';
        return '<div class="so-header">' +
            '<span class="so-header-title">Smart Overlay</span>' +
            '<span class="so-header-wave">' + escapeHtml(waveText) + escapeHtml(goldText) + '</span>' +
            '<span class="so-header-btns">' +
                '<button id="so-settings-btn" class="so-toggle-btn so-gear-btn" tabindex="-1">' +
                    '<span class="so-dots-icon">...</span></button>' +
                '<button id="so-minimize-btn" class="so-toggle-btn" tabindex="-1">' + btnLabel + '</button>' +
            '</span>' +
            '</div>';
    }

    function renderWaveInfo(wave) {
        if (!wave) {
            return '<div class="so-wave-info"><span class="so-wave-creature">No wave data</span></div>';
        }
        return '<div class="so-wave-info">' +
            '<span class="so-wave-creature">' +
                escapeHtml(wave.creature) + ' (' + escapeHtml(wave.amount) + ')' +
            '</span>' +
            '<div class="so-wave-types">' +
                '<span class="so-type-badge so-atk" title="Wave attacks with">' +
                    escapeHtml(wave.dmgType) + '</span>' +
                '<span class="so-type-badge so-def" title="Wave defense type">' +
                    escapeHtml(wave.defType) + '</span>' +
            '</div>' +
            '</div>';
    }

    function renderDefenseStrength(ds) {
        if (!ds) return '';
        var cls = 'so-ds-neutral';
        if (ds.recommendation === 'STRONG') cls = 'so-ds-strong';
        else if (ds.recommendation === 'WEAK') cls = 'so-ds-weak';

        var pctStr = '';
        if (ds.typePct !== undefined && ds.typePct !== 0) {
            pctStr = ds.typePct > 0 ? ' +' + ds.typePct + '%' : ' ' + ds.typePct + '%';
        }

        var detail = '';
        if (ds.recommendation === 'STRONG') {
            detail = 'Good vs ' + ds.waveDefType + ' wave' + pctStr;
        } else if (ds.recommendation === 'WEAK') {
            detail = 'Weak vs ' + ds.waveDmgType + ' wave' + pctStr;
        } else {
            detail = 'Balanced matchup' + pctStr;
        }

        return '<div class="so-defense-strength ' + cls + '">' +
            '<span class="so-ds-label">' + ds.recommendation + '</span>' +
            '<span class="so-ds-detail">' + escapeHtml(detail) + '</span>' +
            '</div>';
    }

    function renderFighterRecs(recs) {
        if (!recs || recs.length === 0) return '<div class="so-empty">No units available</div>';
        var html = '<div class="so-recommendations">';
        for (var i = 0; i < recs.length; i++) {
            html += renderFighterCard(recs[i]);
        }
        return html + '</div>';
    }

    function renderRoleBadge(role) {
        if (!role) return '';
        return '<img class="so-role-badge" src="hud/img/small-icons/' + escapeAttr(role) + '.png" alt="">';
    }

    function renderFighterCard(rec) {
        var unit = rec.unit;
        var eng = window.SmartOverlayEngine;
        var iconUrl = getIconUrl(unit.iconPath);
        var offPct = eng.multiplierToPercent(rec.offensiveMultiplier);
        var defMult = 2.0 - rec.defensiveMultiplier;
        var defPct = eng.multiplierToPercent(defMult);
        var offClass = eng.multiplierClass(rec.offensiveMultiplier);
        var defClass = eng.multiplierClass(defMult);

        var cls = 'so-unit-card';
        if (!rec.canAfford) cls += ' so-unaffordable';
        if (rec.grayedOut) cls += ' so-grayed';

        return '<div class="' + cls + '">' +
            '<span class="so-unit-key">' + escapeHtml(rec.shortcut || '?') + '</span>' +
            '<div class="so-icon-wrap">' +
                '<img class="so-unit-icon" src="' + escapeAttr(iconUrl) +
                    '" alt="" onerror="this.style.display=\'none\'">' +
                renderRoleBadge(rec.role) +
            '</div>' +
            '<div class="so-unit-details">' +
                '<div class="so-unit-name">' + escapeHtml(unit.name || 'Unknown') + '</div>' +
                '<div class="so-unit-meta">' +
                    '<span class="so-unit-cost">' + rec.cost + 'g</span>' +
                    '<span>' + escapeHtml(unit.attackType || '?') + ' / ' +
                        escapeHtml(unit.armorType || '?') + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="so-unit-matchups">' +
                '<span class="so-matchup ' + offClass + '" title="Your ATK vs wave DEF">' + offPct + '</span>' +
                '<span class="so-matchup ' + defClass + '" title="Wave ATK vs your DEF">' + defPct + '</span>' +
            '</div>' +
            '<span class="so-score">' + rec.totalScore + '</span>' +
            '</div>';
    }

    function renderFighterFooter(total) {
        return '<div class="so-footer">' + (total || 0) + ' units scored</div>';
    }

    // =========================================================================
    //  Mercenary panel rendering
    // =========================================================================

    function renderMerc() {
        if (dragTarget) return;

        var root = document.getElementById(MERC_ID);
        if (!root) return;

        root.className = 'mo-panel';

        // Hide until fighter panel is also active (units selected) and we have merc data
        if (!state.showMercAdviser || !state.mercVisible || !state.inGame ||
            !state.dashboardActions || state.dashboardActions.length === 0 ||
            !state.windshieldActions || state.windshieldActions.length === 0) {
            addClass(root, 'so-hidden');
            root.innerHTML = '';
            return;
        }
        if (state.mercMinimized) {
            addClass(root, 'so-minimized');
        }

        var eng = window.SmartOverlayEngine;
        if (!eng || !eng.scoreMercenaries) return;

        var result = eng.scoreMercenaries(
            state.windshieldActions,
            state.defenderGrid,
            state.mythium,
            state.waveNum
        );

        // Evaluate PUSH/HOLD forecast for current wave + next 4
        var pushForecast = [];
        if (state.showPushForecast && eng.evaluatePushHold && result.totalFighters > 0) {
            // Parse opponent value delta for push/hold signal
            var oppDelta = undefined;
            if (state.defenderValueDelta) {
                var deltaMatch = state.defenderValueDelta.match(/\(([+-]?\d+)\)/);
                if (deltaMatch) oppDelta = parseInt(deltaMatch[1], 10);
            }
            for (var fw = state.waveNum; fw < state.waveNum + 5; fw++) {
                var ph = eng.evaluatePushHold(
                    fw, result.defenseValue, result.attackValue,
                    oppDelta, state.mythium
                );
                if (ph) {
                    ph.waveNum = fw;
                    pushForecast.push(ph);
                }
            }
        }

        // Save scroll position before re-rendering
        var oldRecList = document.getElementById('mo-rec-list');
        var savedScroll = oldRecList ? oldRecList.scrollTop : 0;

        root.innerHTML = renderMercHeader() +
            renderDefenseBreakdown(result) +
            renderPushForecast(pushForecast) +
            renderMercRecs(result.recommendations) +
            renderMercFooter(result.totalScored);

        // Restore scroll position
        var newRecList = document.getElementById('mo-rec-list');
        if (newRecList && savedScroll > 0) {
            newRecList.scrollTop = savedScroll;
        }

        bindMercMinBtn();
        bindMercClicks();
    }

    function bindMercMinBtn() {
        var btn = document.getElementById('mo-minimize-btn');
        if (btn) {
            btn.onclick = function () {
                state.mercMinimized = !state.mercMinimized;
                renderMerc();
            };
        }
    }

    function bindMercClicks() {
        var recList = document.getElementById('mo-rec-list');
        if (!recList) return;
        recList.onclick = function (e) {
            // Walk up from click target to find a card with data-action-id
            var card = findAncestorWithClass(e.target, 'mo-unit-card');
            if (!card) return;
            var raw = card.getAttribute('data-action-id');
            if (!raw) return;
            // actionId must be a number — the game expects it as such
            var actionId = parseInt(raw, 10);
            if (isNaN(actionId)) return;
            if (typeof engine !== 'undefined' && engine.trigger) {
                // Use engine.trigger to match the game's own click flow:
                // engine.trigger('clickAction') -> bindings.clickAction -> engine.call('OnUIAction')
                engine.trigger('clickAction', actionId);
                console.log('[SmartOverlay] Purchased merc: ' + actionId);
            }
        };
    }

    /**
     * Parse the game's delta string and return display info.
     * Input examples: "(-5)", "(+120)", "(0)"
     */
    function getValueAssessment(deltaStr) {
        if (!deltaStr) return { cls: '', label: '' };
        // Extract the numeric value from the delta string
        var match = deltaStr.match(/\(([+-]?\d+)\)/);
        if (!match) return { cls: '', label: deltaStr };
        var diff = parseInt(match[1], 10);
        var label = diff > 0 ? '+' + diff : '' + diff;
        if (diff >= -VALUE_OK_THRESHOLD && diff <= VALUE_OK_THRESHOLD) {
            return { cls: 'mo-val-ok', label: diff === 0 ? 'On track' : label };
        }
        var cls = diff < 0 ? 'mo-val-low' : 'mo-val-high';
        return { cls: cls, label: label };
    }

    function renderMercHeader() {
        var defName = state.defenderNamePlain || 'Unknown';
        var btnLabel = state.mercMinimized ? '+' : '\u2013';

        // Build center info as individual flex children
        var infoHtml = '';
        if (state.defenderValue > 0) {
            var assess = getValueAssessment(state.defenderValueDelta);
            infoHtml += '<span class="mo-info-val">' + state.defenderValue + 'g</span>';
            if (assess.label) {
                infoHtml += '<span class="mo-val-badge ' + assess.cls + '">' + assess.label + '</span>';
            }
        }

        // Single header row: title | info | button (mirrors fighter header)
        var html = '<div class="mo-header">' +
            '<span class="mo-header-title">Merc Advisor</span>' +
            '<span class="mo-header-info">' + infoHtml + '</span>' +
            '<button id="mo-minimize-btn" class="mo-toggle-btn" tabindex="-1">' + btnLabel + '</button>' +
            '</div>';

        // Opponent name bar
        html += '<div class="mo-name-bar">vs ' + escapeHtml(defName) + '</div>';

        return html;
    }

    function renderBreakdownRows(countMap, valueMap, totalValue) {
        // Sort by gold value (most important first)
        var types = [];
        for (var type in countMap) {
            if (countMap.hasOwnProperty(type)) {
                types.push({
                    type: type,
                    count: countMap[type],
                    value: (valueMap && valueMap[type]) || 0
                });
            }
        }
        types.sort(function (a, b) { return b.value - a.value || b.count - a.count; });

        var html = '';
        for (var i = 0; i < types.length; i++) {
            var pct = totalValue > 0
                ? Math.round((types[i].value / totalValue) * 100)
                : Math.round((types[i].count / (types.length || 1)) * 100);
            // Show gold value if available, otherwise count
            var displayVal = types[i].value > 0 ? types[i].value + 'g' : types[i].count;
            html += '<div class="mo-def-row">' +
                '<span class="mo-def-chip mo-def-' + types[i].type.toLowerCase() + '">' +
                    escapeHtml(types[i].type) + '</span>' +
                '<div class="mo-def-bar-track"><div class="mo-def-bar-fill mo-def-' +
                    types[i].type.toLowerCase() + '" style="width:' + pct + '%"></div></div>' +
                '<span class="mo-def-count">' + displayVal + '</span>' +
                '</div>';
        }
        return html;
    }

    function renderDefenseBreakdown(result) {
        if (result.totalFighters === 0) {
            var hint = 'Hold Tab + Space to scan enemy';
            if (state.defenderNamePlain) {
                hint = 'Tab + Space to scan ' + escapeHtml(state.defenderNamePlain);
            }
            return '<div class="mo-defense-bar">' +
                '<span class="mo-defense-hint">' + hint + '</span></div>';
        }

        var totalVal = result.totalValue || 0;
        var html = '<div class="mo-defense-bar">';

        // Defense types (armor) — what mercs attack against
        html += '<span class="mo-defense-label">Armor</span>';
        html += renderBreakdownRows(result.defenseBreakdown, result.defenseValue, totalVal);

        // Attack types — what kills mercs
        if (result.attackBreakdown) {
            html += '<span class="mo-defense-label mo-atk-label">Attack</span>';
            html += renderBreakdownRows(result.attackBreakdown, result.attackValue, totalVal);
        }

        return html + '</div>';
    }

    function renderPushForecast(forecast) {
        if (!forecast || forecast.length === 0) return '';
        var html = '<div class="mo-forecast">';
        for (var i = 0; i < forecast.length; i++) {
            var ph = forecast[i];
            var cls = ph.recommendation === 'PUSH' ? 'mo-fc-push' : 'mo-fc-hold';
            if (i === 0) cls += ' mo-fc-current';
            html += '<div class="mo-fc-chip ' + cls + '" title="' +
                escapeAttr(ph.waveDmgType + ' atk / ' + ph.waveDefType + ' def') + '">' +
                '<span class="mo-fc-wave">W' + ph.waveNum + '</span>' +
                '<span class="mo-fc-label">' + ph.recommendation + '</span>' +
                '</div>';
        }
        html += '</div>';
        return html;
    }

    function renderMercRecs(recs) {
        if (!recs || recs.length === 0) return '<div class="so-empty">No mercs available</div>';
        var html = '<div id="mo-rec-list" class="mo-recommendations">';
        for (var i = 0; i < recs.length; i++) {
            html += renderMercCard(recs[i]);
        }
        return html + '</div>';
    }

    function renderMercCard(rec) {
        var unit = rec.unit;
        var eng = window.SmartOverlayEngine;
        var iconUrl = getIconUrl(unit.iconPath);

        // Offense: merc ATK vs opponent DEF
        var offClass = eng.multiplierClass(rec.avgOffMult);
        var offPct = eng.multiplierToPercent(rec.avgOffMult);
        // Defense: opponent ATK vs merc DEF (invert for display)
        var survMult = 2.0 - rec.avgDefMult;
        var defClass = eng.multiplierClass(survMult);
        var defPct = eng.multiplierToPercent(survMult);

        var cls = 'mo-unit-card';
        if (!rec.canAfford) cls += ' so-unaffordable';
        if (rec.grayedOut) cls += ' so-grayed';

        var actionAttr = rec.actionId != null && rec.actionId !== '' ? ' data-action-id="' + escapeAttr(String(rec.actionId)) + '"' : '';

        return '<div class="' + cls + '"' + actionAttr + '>' +
            '<span class="so-unit-key">' + escapeHtml(rec.shortcut || '?') + '</span>' +
            '<div class="so-icon-wrap">' +
                '<img class="so-unit-icon" src="' + escapeAttr(iconUrl) +
                    '" alt="" onerror="this.style.display=\'none\'">' +
                renderRoleBadge(rec.role) +
            '</div>' +
            '<div class="so-unit-details">' +
                '<div class="so-unit-name">' + escapeHtml(unit.name || 'Unknown') + '</div>' +
                '<div class="so-unit-meta">' +
                    '<span class="so-unit-cost">' + (rec.cost > 0 ? rec.cost + ' myth' : '') + '</span>' +
                    '<span>' + escapeHtml(unit.attackType || '?') + ' / ' +
                        escapeHtml(unit.armorType || '?') + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="so-unit-matchups">' +
                '<span class="so-matchup ' + offClass + '" title="Merc ATK vs enemy DEF">' + offPct + '</span>' +
                '<span class="so-matchup ' + defClass + '" title="Enemy ATK vs merc DEF">' + defPct + '</span>' +
            '</div>' +
            '<span class="so-score">' + rec.totalScore + '</span>' +
            '</div>';
    }

    function renderMercFooter(total) {
        return '<div class="so-footer">' + (total || 0) + ' mercs shown</div>';
    }

    // =========================================================================
    //  Scouting panel rendering
    // =========================================================================

    function renderScouting() {
        if (dragTarget) return;

        var root = document.getElementById(SCOUT_ID);
        if (!root) return;

        root.className = 'sc-panel';

        // Hide in bot games, when scouting disabled, or when user closed the panel
        if (state.isBotGame || !state.showScouting || !state.scoutingVisible) {
            addClass(root, 'so-hidden');
            root.innerHTML = '';
            return;
        }

        var opponents = [];
        var allies = [];
        for (var num in state.scoutingPlayers) {
            if (!state.scoutingPlayers.hasOwnProperty(num)) continue;
            var p = state.scoutingPlayers[num];
            if (p.isAlly) {
                allies.push(p);
            } else {
                opponents.push(p);
            }
        }

        var html = renderScoutHeader();

        if (opponents.length > 0) {
            html += '<div class="sc-section-label">Opponents</div>';
            for (var i = 0; i < opponents.length; i++) {
                html += renderScoutCard(opponents[i]);
            }
        }
        if (allies.length > 0) {
            html += '<div class="sc-section-label">Allies</div>';
            for (var j = 0; j < allies.length; j++) {
                html += renderScoutCard(allies[j]);
            }
        }

        if (opponents.length === 0 && allies.length === 0) {
            html += '<div class="so-empty">Waiting for players...</div>';
        }

        root.innerHTML = html;
        bindScoutCloseBtn();
    }

    function bindScoutCloseBtn() {
        var btn = document.getElementById('sc-close-btn');
        if (btn) {
            btn.onclick = function () {
                state.scoutingVisible = false;
                renderScouting();
            };
        }
    }

    function renderScoutHeader() {
        // Try to get the API's "Last N Games" string from the first player with data
        var lastNText = '';
        for (var key in state.scoutingPlayers) {
            if (!state.scoutingPlayers.hasOwnProperty(key)) continue;
            var p = state.scoutingPlayers[key];
            if (p.data && p.data.String) {
                lastNText = p.data.String;
                break;
            }
        }
        var subtitle = lastNText
            ? '<span class="sc-header-subtitle">' + escapeHtml(lastNText) + '</span>'
            : '';
        return '<div class="sc-header">' +
            '<span class="sc-header-title">Scouting</span>' +
            subtitle +
            '<button id="sc-close-btn" class="sc-toggle-btn" tabindex="-1">\u00d7</button>' +
            '</div>';
    }

    function stripHtml(str) {
        if (!str) return '';
        return String(str).replace(/<[^>]+>/g, '').trim();
    }

    function renderScoutCard(player) {
        var html = '<div class="sc-player-card">';
        var plainName = stripHtml(player.name);
        if (!plainName) plainName = player.name || '???';

        html += '<div class="sc-player-name">' + escapeHtml(plainName) + '</div>';

        if (player.loading) {
            html += '<div class="sc-stats sc-loading">Loading...</div>';
        } else if (player.error || !player.data) {
            html += '<div class="sc-stats sc-error">No data</div>';
        } else {
            var d = player.data;
            // W/L + Elo on one line
            var wins = (d.WinLose && d.WinLose.Wins) || 0;
            var losses = (d.WinLose && d.WinLose.Losses) || 0;
            var elo = d.EloChange || 0;
            var eloStr = elo >= 0 ? '+' + elo : '' + elo;
            html += '<div class="sc-stats">' +
                '<span class="sc-wl">' + wins + 'W-' + losses + 'L</span>' +
                '<span class="sc-elo ' + (elo >= 0 ? 'sc-elo-pos' : 'sc-elo-neg') + '">' + eloStr + ' Elo</span>' +
                '</div>';

            // Top 3 Masterminds
            if (d.Masterminds) {
                html += renderScoutIcons(d.Masterminds, 'hud/img/icons/Items/', 'MMs');
            }
            // Top 3 Wave 1 units
            if (d.Wave1) {
                html += renderScoutIcons(d.Wave1, 'hud/img/icons/', 'W1');
            }
        }

        html += '</div>';
        return html;
    }

    function renderScoutIcons(map, basePath, label) {
        // Sort by count descending, take top 3
        var entries = [];
        for (var name in map) {
            if (map.hasOwnProperty(name)) {
                entries.push({ name: name, count: map[name] });
            }
        }
        entries.sort(function (a, b) { return b.count - a.count; });
        if (entries.length > 3) entries = entries.slice(0, 3);
        if (entries.length === 0) return '';

        var html = '<div class="sc-icons-row">';
        html += '<span class="sc-icons-label">' + escapeHtml(label) + '</span>';
        for (var i = 0; i < entries.length; i++) {
            var iconSrc = basePath + escapeAttr(entries[i].name) + '.png';
            var prettyName = entries[i].name.replace(/_/g, ' ');
            html += '<span class="sc-icon-item" title="' + escapeAttr(prettyName) + ' (' + entries[i].count + ')">' +
                '<img class="sc-icon-img" src="' + iconSrc +
                    '" alt="' + escapeAttr(prettyName) +
                    '" onerror="this.style.display=\'none\'">' +
                '<span class="sc-icon-count">' + entries[i].count + '</span>' +
                '</span>';
        }
        html += '</div>';
        return html;
    }

    // =========================================================================
    //  Main menu settings link (visible only on home screen)
    // =========================================================================

    function renderMainMenuLink() {
        var root = document.getElementById(MAINMENU_ID);
        if (!root) return;

        // Hide when in a match (fighter panel active)
        var inGame = state.inGame && state.dashboardActions && state.dashboardActions.length > 0;
        if (inGame) {
            root.className = 'so-mm-btn so-hidden';
            return;
        }

        root.className = 'so-mm-btn';

        var html = 'SOS';

        // Update notification banner
        if (state.updateAvailable && !state.updateDismissed) {
            html += '<div class="so-update-banner">' +
                '<span class="so-update-text">' +
                    'v' + escapeHtml(state.updateAvailable.version) + ' available on GitHub!' +
                '</span>' +
                '<button id="so-update-dismiss" class="so-update-close" tabindex="-1">\u00d7</button>' +
                '</div>';
        }

        root.innerHTML = html;

        root.onclick = function (e) {
            // Don't toggle settings when clicking the update banner
            if (findAncestorWithClass(e.target, 'so-update-banner')) return;
            state.settingsVisible = !state.settingsVisible;
            renderSettings();
        };

        // Bind dismiss button
        var dismissBtn = document.getElementById('so-update-dismiss');
        if (dismissBtn) {
            dismissBtn.onclick = function (e) {
                e.stopPropagation();
                state.updateDismissed = true;
                try {
                    localStorage.setItem('dismissed_update_version', state.updateAvailable.version);
                } catch (ex) { /* ignore */ }
                renderMainMenuLink();
            };
        }
    }

    // =========================================================================
    //  Settings panel rendering
    // =========================================================================

    function renderSettings() {
        var root = document.getElementById(SETTINGS_ID);
        if (!root) return;

        root.className = 'sg-panel';

        if (!state.settingsVisible) {
            addClass(root, 'so-hidden');
            root.innerHTML = '';
            return;
        }

        var versionLabel = OVERLAY_VERSION === '0.0.0' ? 'dev' : 'v' + OVERLAY_VERSION;
        var html = '<div class="sg-header">' +
            '<span class="sg-header-title">Smart Overlay Settings</span>' +
            '<span class="sg-header-right">' +
                '<span class="sg-header-version">' + escapeHtml(versionLabel) + '</span>' +
                '<button id="sg-close-btn" class="sg-toggle-btn" tabindex="-1">\u00d7</button>' +
            '</span>' +
            '</div>';

        html += renderToggleRow('showScouting', 'Scouting',
            'Fetch player stats (W/L, Elo, openers) from Drachbot API when the scoreboard opens.', false);
        html += renderToggleRow('showTopPicks', 'Top Picks Highlight',
            'Highlight the top 3 recommended units on the game\'s purchase bar with glowing borders.', false);
        html += renderToggleRow('showDefenseStrength', 'Defense Strength',
            'Show the STRONG/NEUTRAL/WEAK indicator for your army vs the current wave.', false);
        html += renderToggleRow('showMercAdviser', 'Merc Adviser',
            'Show the merc advisor panel with opponent breakdown and merc recommendations.', false);
        html += renderToggleRow('showPushForecast', 'Push/Hold Forecast',
            'Show the 5-wave push/hold forecast inside the merc advisor panel.', true);
        html += renderToggleRow('showHotkeyBadges', 'Hotkey Badges',
            'Show keyboard shortcut labels on the game\'s unit, merc, and king action bars.', false);

        html += '<div class="sg-reset-row">' +
            '<button id="sg-reset-btn" class="sg-reset-btn" tabindex="-1">Reset Layout</button>' +
            '</div>';

        root.innerHTML = html;
        bindSettingsEvents();
    }

    function renderToggleRow(key, label, desc, isSub) {
        var active = state[key];
        var disabled = false;

        // Push/Hold is a sub-option of Merc Adviser
        if (key === 'showPushForecast' && !state.showMercAdviser) {
            disabled = true;
            active = false;
        }

        var rowCls = 'sg-toggle-row';
        if (isSub) rowCls += ' sg-toggle-sub';
        if (disabled) rowCls += ' sg-toggle-disabled';

        var indicatorCls = 'sg-indicator' + (active ? ' sg-toggle-active' : '');

        return '<div class="' + rowCls + '" data-setting="' + escapeAttr(key) + '">' +
            '<div class="sg-toggle-content">' +
                '<span class="sg-label">' + escapeHtml(label) + '</span>' +
                '<span class="sg-desc">' + escapeHtml(desc) + '</span>' +
            '</div>' +
            '<span class="' + indicatorCls + '">' + (active ? 'ON' : 'OFF') + '</span>' +
            '</div>';
    }

    function bindSettingsEvents() {
        var root = document.getElementById(SETTINGS_ID);
        if (!root) return;

        var closeBtn = document.getElementById('sg-close-btn');
        if (closeBtn) {
            closeBtn.onclick = function () {
                state.settingsVisible = false;
                renderSettings();
            };
        }

        var resetBtn = document.getElementById('sg-reset-btn');
        if (resetBtn) {
            resetBtn.onclick = function () {
                // Clear saved positions
                try {
                    localStorage.removeItem(STORAGE_KEY_FIGHTER);
                    localStorage.removeItem(STORAGE_KEY_MERC);
                    localStorage.removeItem(STORAGE_KEY_SCOUT);
                } catch (e) { /* ignore */ }
                // Reset panels to CSS defaults
                var panels = [
                    { id: FIGHTER_ID, cls: 'so-panel' },
                    { id: MERC_ID, cls: 'mo-panel' },
                    { id: SCOUT_ID, cls: 'sc-panel' }
                ];
                for (var p = 0; p < panels.length; p++) {
                    var el = document.getElementById(panels[p].id);
                    if (el) {
                        el.style.left = '';
                        el.style.top = '';
                        el.style.right = '';
                    }
                }
            };
        }

        var rows = root.getElementsByClassName('sg-toggle-row');
        for (var i = 0; i < rows.length; i++) {
            (function (row) {
                row.onclick = function () {
                    if (hasClass(row, 'sg-toggle-disabled')) return;
                    var key = row.getAttribute('data-setting');
                    if (!key) return;
                    state[key] = !state[key];

                    // Side effects
                    if (key === 'showHotkeyBadges') {
                        if (!state.showHotkeyBadges) {
                            resetHotkeyBadges();
                        } else {
                            scheduleHotkeyInject();
                        }
                    }
                    if (key === 'showScouting' && !state.showScouting) {
                        state.scoutingPlayers = {};
                        state.scoutingVisible = false;
                    }
                    if (key === 'showMercAdviser' && !state.showMercAdviser) {
                        state.showPushForecast = false;
                    }
                    if (key === 'showTopPicks' && !state.showTopPicks) {
                        state.topFighterIcons = [];
                        clearTopPickHighlights();
                    }

                    saveSettings();
                    renderSettings();
                    renderFighter();
                    renderMerc();
                    renderScouting();
                };
            })(rows[i]);
        }
    }

    // =========================================================================
    //  Public API
    // =========================================================================

    window.SmartOverlay = {
        init: init,
        renderFighter: renderFighter,
        renderMerc: renderMerc,
        renderScouting: renderScouting,
        renderSettings: renderSettings,
        setState: function (newState) {
            for (var key in newState) {
                if (newState.hasOwnProperty(key)) {
                    state[key] = newState[key];
                }
            }
            renderFighter();
            renderMerc();
            renderScouting();
        },
        getState: function () { return state; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
