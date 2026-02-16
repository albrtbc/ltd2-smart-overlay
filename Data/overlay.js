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
    var ICON_CDN = 'https://cdn.legiontd2.com/icons/';
    var STORAGE_KEY_FIGHTER = 'smartOverlayPosition';
    var STORAGE_KEY_MERC = 'mercOverlayPosition';
    var RENDER_DEBOUNCE_MS = 100;

    // --- Shared state ---
    var state = {
        waveNum: 0,
        gold: 0,
        mythium: 0,
        inGame: false,
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
        mercVisible: true
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
                         findAncestorWithClass(e.target, 'mo-header');
            if (!header) return;
            if (findAncestorWithClass(e.target, 'so-toggle-btn') ||
                findAncestorWithClass(e.target, 'mo-toggle-btn')) return;

            // Determine which panel owns this header
            var panel = findAncestorWithClass(e.target, 'so-panel') ||
                        findAncestorWithClass(e.target, 'mo-panel');
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
            var key = dragTarget.id === MERC_ID ? STORAGE_KEY_MERC : STORAGE_KEY_FIGHTER;
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
            state.recommendedValue = recommendedValue;
            state.recThresholds = thresholds || null;
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
            // Only cache when viewing enemy fighters (Tab+Space)
            if (showingEnemies && scoreboardInfo && scoreboardInfo.length) {
                cacheDefenderGrid(scoreboardInfo);
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

        bindGameEvents();
        initDrag();
        renderFighter();
        renderMerc();

        console.log('[SmartOverlay] Initialized (fighter + merc panels).');
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

        root.innerHTML = renderFighterHeader() +
            renderWaveInfo(result.wave) +
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

        // Save scroll position before re-rendering
        var oldRecList = document.getElementById('mo-rec-list');
        var savedScroll = oldRecList ? oldRecList.scrollTop : 0;

        root.innerHTML = renderMercHeader() +
            renderDefenseBreakdown(result) +
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

        // Build center info: "995g (-5) | 120 myth"
        var infoParts = [];
        if (state.defenderValue > 0) {
            var assess = getValueAssessment(state.defenderValueDelta);
            var valText = state.defenderValue + 'g';
            if (assess.label) {
                valText += ' <span class="mo-val-badge ' + assess.cls + '">' + assess.label + '</span>';
            }
            infoParts.push(valText);
        }
        if (state.mythium > 0) {
            infoParts.push(state.mythium + ' myth');
        }
        var infoText = infoParts.length > 0 ? infoParts.join(' | ') : '';

        // Single header row: title | info | button (mirrors fighter header)
        var html = '<div class="mo-header">' +
            '<span class="mo-header-title">Merc Advisor</span>' +
            '<span class="mo-header-info">' + infoText + '</span>' +
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
                    '<span class="so-unit-cost">' + rec.cost + ' myth</span>' +
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
    //  Public API
    // =========================================================================

    window.SmartOverlay = {
        init: init,
        renderFighter: renderFighter,
        renderMerc: renderMerc,
        setState: function (newState) {
            for (var key in newState) {
                if (newState.hasOwnProperty(key)) {
                    state[key] = newState[key];
                }
            }
            renderFighter();
            renderMerc();
        },
        getState: function () { return state; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
