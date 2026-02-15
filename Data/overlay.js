/**
 * LTD2 Smart Overlay - Main UI Component
 *
 * Hooks into the game's Coherent UI engine events (refreshWaveNumber,
 * refreshGold, refreshDashboardActions) to auto-detect game state and
 * recommend optimal unit purchases from the player's purchase bar.
 */
(function () {
    'use strict';

    var OVERLAY_ID = 'smart-overlay-root';
    var ICON_CDN = 'https://cdn.legiontd2.com/icons/';
    var STORAGE_KEY = 'smartOverlayPosition';
    var RENDER_DEBOUNCE_MS = 100;

    var state = {
        waveNum: 0,
        gold: 0,
        dashboardActions: null,
        minimized: false,
        visible: true,
        inGame: false
    };

    var renderTimer = null;
    var dragging = false;
    var dragOffsetX = 0;
    var dragOffsetY = 0;

    /**
     * Schedule a debounced render to batch rapid updates (gold changes frequently).
     */
    function scheduleRender() {
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(function () {
            renderTimer = null;
            render();
        }, RENDER_DEBOUNCE_MS);
    }

    /**
     * Initialize the overlay: create DOM, bind events, restore position.
     */
    function init() {
        if (document.getElementById(OVERLAY_ID)) return;

        var root = document.createElement('div');
        root.id = OVERLAY_ID;
        document.body.appendChild(root);

        restorePosition(root);
        bindGameEvents();
        bindKeyboard();
        bindDrag(root);
        render();

        console.log('[SmartOverlay] Initialized.');
    }

    /**
     * Hook into the game's native Coherent UI engine events.
     * Our script loads after bindings.js, so `engine` and `globalState` exist.
     */
    function bindGameEvents() {
        if (typeof engine === 'undefined') {
            console.warn('[SmartOverlay] engine not available.');
            return;
        }

        // Wave number
        engine.on('refreshWaveNumber', function (waveNumber) {
            state.waveNum = waveNumber;
            state.inGame = true;
            scheduleRender();
        });

        // Gold
        engine.on('refreshGold', function (value) {
            state.gold = value;
            scheduleRender();
        });

        // Dashboard actions = purchase bar units
        engine.on('refreshDashboardActions', function (actions) {
            state.dashboardActions = actions;
            state.inGame = true;
            scheduleRender();
        });

        // Read initial globalState if already set
        if (typeof globalState !== 'undefined') {
            if (globalState.waveNumber > 0) {
                state.waveNum = globalState.waveNumber;
            }
            if (globalState.gold > 0) {
                state.gold = globalState.gold;
            }
        }

        console.log('[SmartOverlay] Engine events bound.');
    }

    /**
     * Toggle overlay with keyboard shortcuts.
     */
    function bindKeyboard() {
        document.addEventListener('keydown', function (e) {
            if (e.key === 'F7') {
                state.minimized = !state.minimized;
                render();
            }
            if (e.key === 'F8') {
                state.visible = !state.visible;
                render();
            }
        });
    }

    /**
     * Make the overlay draggable by its header.
     */
    function bindDrag(root) {
        document.addEventListener('mousedown', function (e) {
            var header = e.target.closest('.so-header');
            if (!header) return;
            // Don't drag if clicking the minimize button
            if (e.target.closest('.so-toggle-btn')) return;

            dragging = true;
            var rect = root.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            root.classList.add('so-dragging');
            e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var x = e.clientX - dragOffsetX;
            var y = e.clientY - dragOffsetY;
            // Clamp to viewport
            x = Math.max(0, Math.min(window.innerWidth - 100, x));
            y = Math.max(0, Math.min(window.innerHeight - 40, y));
            root.style.left = x + 'px';
            root.style.top = y + 'px';
            root.style.right = 'auto';
            e.preventDefault();
        });

        document.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            root.classList.remove('so-dragging');
            savePosition(root);
        });
    }

    function savePosition(root) {
        try {
            var pos = { left: root.style.left, top: root.style.top };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
        } catch (e) { /* localStorage may not be available */ }
    }

    function restorePosition(root) {
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                var pos = JSON.parse(saved);
                if (pos.left && pos.top) {
                    root.style.left = pos.left;
                    root.style.top = pos.top;
                    root.style.right = 'auto';
                }
            }
        } catch (e) { /* ignore */ }
    }

    /**
     * Main render function - rebuilds the overlay DOM.
     */
    function render() {
        var root = document.getElementById(OVERLAY_ID);
        if (!root) return;

        root.className = '';
        if (!state.visible) {
            root.className = 'so-hidden';
            root.innerHTML = '';
            return;
        }
        if (state.minimized) {
            root.className = 'so-minimized';
        }

        var eng = window.SmartOverlayEngine;
        if (!eng) {
            root.innerHTML = renderChrome('Engine not loaded', '');
            return;
        }

        // If no dashboard actions yet, show waiting state
        if (!state.dashboardActions || state.dashboardActions.length === 0) {
            var html = renderHeader();
            html += '<div class="so-waiting">Waiting for game...</div>';
            html += renderFooter(0);
            root.innerHTML = html;
            bindHeaderButton();
            return;
        }

        // Score units from dashboard actions
        var result = eng.scoreFromDashboardActions(
            state.dashboardActions,
            state.waveNum,
            state.gold
        );

        var html = renderHeader();
        html += renderWaveInfo(result.wave);
        html += renderRecommendations(result.recommendations);
        html += renderFooter(result.totalScored);

        root.innerHTML = html;
        bindHeaderButton();
    }

    function bindHeaderButton() {
        var minBtn = document.getElementById('so-minimize-btn');
        if (minBtn) {
            minBtn.onclick = function () {
                state.minimized = !state.minimized;
                render();
            };
        }
    }

    function renderHeader() {
        var waveText = state.waveNum > 0 ? 'Wave ' + state.waveNum : 'Pre-game';
        var goldText = state.gold > 0 ? ' | ' + state.gold + 'g' : '';
        var btnLabel = state.minimized ? '+' : '\u2013';
        return '<div class="so-header">' +
            '<span class="so-header-title">Smart Overlay</span>' +
            '<span class="so-header-wave">' + escapeHtml(waveText) + escapeHtml(goldText) + '</span>' +
            '<button id="so-minimize-btn" class="so-toggle-btn">' + btnLabel + '</button>' +
            '</div>';
    }

    function renderWaveInfo(wave) {
        if (!wave) {
            return '<div class="so-wave-info">' +
                '<span class="so-wave-creature">No wave data</span>' +
                '</div>';
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

    function renderRecommendations(recs) {
        if (!recs || recs.length === 0) {
            return '<div class="so-empty">No units available</div>';
        }

        var html = '<div class="so-recommendations">';
        for (var i = 0; i < recs.length; i++) {
            html += renderUnitCard(recs[i], i + 1);
        }
        html += '</div>';
        return html;
    }

    function renderUnitCard(rec, rank) {
        var unit = rec.unit;
        var eng = window.SmartOverlayEngine;
        var iconUrl = getIconUrl(unit.iconPath);
        var offPct = eng.multiplierToPercent(rec.offensiveMultiplier);
        var defMult = 2.0 - rec.defensiveMultiplier;
        var defPct = eng.multiplierToPercent(defMult);
        var offClass = eng.multiplierClass(rec.offensiveMultiplier);
        var defClass = eng.multiplierClass(defMult);

        var cardClass = 'so-unit-card';
        if (!rec.canAfford) cardClass += ' so-unaffordable';
        if (rec.grayedOut) cardClass += ' so-grayed';

        var unitName = unit.name || unit.unitId || 'Unknown';

        return '<div class="' + cardClass + '">' +
            '<span class="so-unit-rank">' + rank + '</span>' +
            '<img class="so-unit-icon" src="' + escapeAttr(iconUrl) +
                '" alt="" onerror="this.style.display=\'none\'">' +
            '<div class="so-unit-details">' +
                '<div class="so-unit-name">' + escapeHtml(unitName) + '</div>' +
                '<div class="so-unit-meta">' +
                    '<span class="so-unit-cost">' + rec.cost + 'g</span>' +
                    '<span>' + escapeHtml(unit.attackType || '?') + ' / ' +
                        escapeHtml(unit.armorType || '?') + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="so-unit-matchups">' +
                '<span class="so-matchup ' + offClass +
                    '" title="Your ATK vs wave DEF">' + offPct + '</span>' +
                '<span class="so-matchup ' + defClass +
                    '" title="Wave ATK vs your DEF">' + defPct + '</span>' +
            '</div>' +
            '<span class="so-score">' + rec.totalScore + '</span>' +
            '</div>';
    }

    function renderFooter(totalScored) {
        var count = totalScored || 0;
        return '<div class="so-footer">' +
            count + ' units scored | F7 minimize | F8 hide' +
            '</div>';
    }

    function renderChrome(title, body) {
        return '<div class="so-header">' +
            '<span class="so-header-title">' + escapeHtml(title) + '</span>' +
            '</div>' +
            '<div class="so-empty">' + escapeHtml(body) + '</div>';
    }

    function getIconUrl(iconPath) {
        if (!iconPath) return '';
        var name = iconPath.replace(/^icons\//i, '').replace('.png', '');
        return ICON_CDN + name + '.png';
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
        return escapeHtml(str);
    }

    // --- Expose for external control ---
    window.SmartOverlay = {
        init: init,
        render: render,
        setState: function (newState) {
            for (var key in newState) {
                if (newState.hasOwnProperty(key)) {
                    state[key] = newState[key];
                }
            }
            render();
        },
        getState: function () { return state; }
    };

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
