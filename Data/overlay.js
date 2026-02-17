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
    var SCOUT_API = 'https://stats.drachbot.site/api/drachbot_overlay/';
    var RENDER_DEBOUNCE_MS = 100;

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
        isBotGame: false
    };

    var renderTimer = null;

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
        if (!bestMatch || bestDiff > delta * 0.2) return;

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
    //  Scouting — extract player names from scoreboard
    // =========================================================================

    function isBotName(name) {
        if (!name) return false;
        var plain = name.replace(/<[^>]+>/g, '').trim().toLowerCase();
        return /\bbot\b/.test(plain);
    }

    function captureScoutingFromScoreboard(players) {
        if (!players || !players.length) return;

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

        // Collect already-known names
        var seen = {};
        var nextIdx = 0;
        for (var key in state.scoutingPlayers) {
            if (state.scoutingPlayers.hasOwnProperty(key)) {
                seen[state.scoutingPlayers[key].name] = true;
                var n = parseInt(key, 10);
                if (n > nextIdx) nextIdx = n;
            }
        }

        var added = 0;

        // Players in the scoreboard array are allies (including me).
        // Their defenderPlayerName fields are the opponents.
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            if (p.name && !seen[p.name]) {
                seen[p.name] = true;
                nextIdx++;
                state.scoutingPlayers[nextIdx] = {
                    name: p.name, isAlly: true,
                    data: null, loading: true, error: null
                };
                fetchScoutingData(p.name, nextIdx);
                added++;
            }
            if (p.defenderPlayerName && !seen[p.defenderPlayerName]) {
                seen[p.defenderPlayerName] = true;
                nextIdx++;
                state.scoutingPlayers[nextIdx] = {
                    name: p.defenderPlayerName, isAlly: false,
                    data: null, loading: true, error: null
                };
                fetchScoutingData(p.defenderPlayerName, nextIdx);
                added++;
            }
        }

        if (added > 0) {
            state.scoutingVisible = true;
            console.log('[SmartOverlay] Scouting: added ' + added + ' players (total: ' + nextIdx + ').');
            scheduleRender();
        }
    }

    // =========================================================================
    //  Scouting API fetch
    // =========================================================================

    function fetchScoutingData(playerName, playerNum) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', SCOUT_API + encodeURIComponent(playerName), true);
        xhr.timeout = 8000;
        xhr.onload = function () {
            if (xhr.status === 200) {
                try {
                    var data = JSON.parse(xhr.responseText);
                    state.scoutingPlayers[playerNum].data = data;
                    state.scoutingPlayers[playerNum].loading = false;
                } catch (e) {
                    state.scoutingPlayers[playerNum].error = true;
                    state.scoutingPlayers[playerNum].loading = false;
                }
            } else {
                state.scoutingPlayers[playerNum].error = true;
                state.scoutingPlayers[playerNum].loading = false;
            }
            scheduleRender();
        };
        xhr.onerror = xhr.ontimeout = function () {
            if (state.scoutingPlayers[playerNum]) {
                state.scoutingPlayers[playerNum].error = true;
                state.scoutingPlayers[playerNum].loading = false;
            }
            scheduleRender();
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
    //  Drag system (shared for both panels)
    // =========================================================================

    function initDrag() {
        document.addEventListener('mousedown', function (e) {
            var header = findAncestorWithClass(e.target, 'so-header') ||
                         findAncestorWithClass(e.target, 'mo-header') ||
                         findAncestorWithClass(e.target, 'sc-header');
            if (!header) return;
            if (findAncestorWithClass(e.target, 'so-toggle-btn') ||
                findAncestorWithClass(e.target, 'mo-toggle-btn') ||
                findAncestorWithClass(e.target, 'sc-toggle-btn')) return;

            // Determine which panel owns this header
            var panel = findAncestorWithClass(e.target, 'so-panel') ||
                        findAncestorWithClass(e.target, 'mo-panel') ||
                        findAncestorWithClass(e.target, 'sc-panel');
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
            var x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffsetX));
            var y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffsetY));
            dragTarget.style.left = x + 'px';
            dragTarget.style.top = y + 'px';
            dragTarget.style.right = 'auto';
            e.preventDefault();
        });

        document.addEventListener('mouseup', function () {
            if (!dragTarget) return;
            removeClass(dragTarget, 'so-dragging');
            // Save position based on panel id
            var key = dragTarget.id === MERC_ID ? STORAGE_KEY_MERC
                    : dragTarget.id === SCOUT_ID ? STORAGE_KEY_SCOUT
                    : STORAGE_KEY_FIGHTER;
            savePosition(dragTarget, key);
            dragTarget = null;
        });
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
        });

        // --- Mercenary events ---
        engine.on('refreshWindshieldActions', function (actions) {
            state.windshieldActions = actions;
            state.inGame = true;


            scheduleRender();
        });

        engine.on('refreshWindshieldDefender', function (defenderName) {
            state.defenderName = defenderName || '';
            state.defenderNamePlain = (defenderName || '').replace(/<[^>]+>/g, '').trim();
            scheduleRender();
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

        bindGameEvents();
        initDrag();
        renderFighter();
        renderMerc();
        renderScouting();

        console.log('[SmartOverlay] Initialized (fighter + merc + scouting panels).');
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
        if (eng.evaluateDefenseStrength && state.myGrid) {

            var typeResult = eng.evaluateDefenseStrength(
                state.waveNum, state.myDefenseValue, state.myAttackValue
            );

            if (typeResult) {
                var typeScore = typeResult.score;

                var valueScore = 0;
                if (state.recommendedValue > 0 && state.currentValue > 0) {
                    valueScore = (state.currentValue - state.recommendedValue) / state.recommendedValue;
                }

                // Value and types roughly equal weight
                var combined = typeScore + valueScore * 1.0;
                var rec = 'NEUTRAL';
                if (combined > 0.04) rec = 'STRONG';
                else if (combined < -0.04) rec = 'WEAK';
                defStrength = {
                    recommendation: rec,
                    combined: combined,
                    typeScore: typeScore,
                    valueScore: valueScore,
                    waveDmgType: typeResult.waveDmgType,
                    waveDefType: typeResult.waveDefType
                };
            }
        }

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
    }

    function renderFighterHeader() {
        var waveText = state.waveNum > 0 ? 'Wave ' + state.waveNum : 'Pre-game';
        var goldText = state.gold > 0 ? ' | ' + state.gold + 'g' : '';
        var btnLabel = state.fighterMinimized ? '+' : '\u2013';
        return '<div class="so-header">' +
            '<span class="so-header-title">Smart Overlay</span>' +
            '<span class="so-header-wave">' + escapeHtml(waveText) + escapeHtml(goldText) + '</span>' +
            '<button id="so-minimize-btn" class="so-toggle-btn" tabindex="-1">' + btnLabel + '</button>' +
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

        var detail = '';
        if (ds.recommendation === 'STRONG') {
            detail = 'Good vs ' + ds.waveDefType + ' wave';
        } else if (ds.recommendation === 'WEAK') {
            detail = 'Weak vs ' + ds.waveDmgType + ' wave';
        } else {
            detail = 'Balanced matchup';
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
        if (!state.mercVisible || !state.inGame ||
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
            state.mythium
        );

        // Evaluate PUSH/HOLD forecast for current wave + next 4
        var pushForecast = [];
        if (eng.evaluatePushHold && result.totalFighters > 0) {
            for (var fw = state.waveNum; fw < state.waveNum + 5; fw++) {
                var ph = eng.evaluatePushHold(fw, result.defenseValue, result.attackValue);
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
        if (diff >= -20 && diff <= 20) {
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

        // Hide in bot games or when user closed the panel
        if (state.isBotGame || !state.scoutingVisible) {
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
        var plainName = stripHtml(player.name) || '???';

        // Header: name as simple block div (Coherent GT flex bugs collapse spans)
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
    //  Public API
    // =========================================================================

    window.SmartOverlay = {
        init: init,
        renderFighter: renderFighter,
        renderMerc: renderMerc,
        renderScouting: renderScouting,
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
