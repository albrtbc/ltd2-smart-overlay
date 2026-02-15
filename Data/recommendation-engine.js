/**
 * LTD2 Smart Overlay - Recommendation Engine
 *
 * Scores available units against the current wave's attack/defense types
 * and the player's gold to recommend optimal purchases and upgrades.
 */
var SmartOverlayEngine = (function () {
    'use strict';

    // Damage multiplier matrix: attackType -> armorType -> multiplier
    // Values from the game's globals.xml / PeewUI data
    var DAMAGE_MATRIX = {
        Pierce:    { Fortified: 0.80, Natural: 0.85, Immaterial: 1.00, Arcane: 1.15, Swift: 1.20 },
        Impact:    { Fortified: 1.15, Natural: 0.90, Immaterial: 1.00, Arcane: 1.15, Swift: 0.80 },
        Magic:     { Fortified: 1.05, Natural: 1.25, Immaterial: 1.00, Arcane: 0.75, Swift: 1.00 },
        Pure:      { Fortified: 1.00, Natural: 1.00, Immaterial: 1.00, Arcane: 1.00, Swift: 1.00 }
    };

    // Scoring weights (tunable)
    var WEIGHTS = {
        offensiveTypeMatch: 35,   // How well your unit's attack counters the wave's defense
        defensiveTypeMatch: 25,   // How well your unit's armor resists the wave's attack
        goldEfficiency:     20,   // DPS per gold spent
        upgradeBonus:       15,   // Bonus if upgrading an existing unit
        tierRelevance:       5    // Penalty for over/under-tiered units
    };

    // Approximate tier-to-wave mapping
    var TIER_WAVE_MAP = {
        'Tier-1': { min: 1,  max: 5  },
        'Tier-2': { min: 3,  max: 10 },
        'Tier-3': { min: 6,  max: 14 },
        'Tier-4': { min: 10, max: 18 },
        'Tier-5': { min: 14, max: 21 },
        'Tier-6': { min: 17, max: 21 }
    };

    /**
     * Returns the damage multiplier for a given attack type vs armor type.
     */
    function getDamageMultiplier(attackType, armorType) {
        if (!attackType || !armorType) return 1.0;
        var row = DAMAGE_MATRIX[attackType];
        if (!row) return 1.0;
        return row[armorType] || 1.0;
    }

    /**
     * Converts a damage multiplier to a human-readable percentage string.
     */
    function multiplierToPercent(mult) {
        var pct = Math.round((mult - 1.0) * 100);
        if (pct > 0) return '+' + pct + '%';
        if (pct < 0) return pct + '%';
        return '0%';
    }

    /**
     * Returns a CSS class name for color-coding a multiplier.
     */
    function multiplierClass(mult) {
        if (mult >= 1.15) return 'so-match-strong';
        if (mult >= 1.05) return 'so-match-good';
        if (mult <= 0.85) return 'so-match-weak';
        if (mult <= 0.95) return 'so-match-poor';
        return 'so-match-neutral';
    }

    /**
     * Scores a single unit against the current wave.
     *
     * @param {Object} unit - Unit data from the database.
     * @param {Object} wave - Current wave data (dmgType, defType).
     * @param {number} gold - Player's available gold.
     * @param {Array}  boardUnits - IDs of units currently on the player's board.
     * @returns {Object|null} Score breakdown, or null if unit can't be purchased.
     */
    function scoreUnit(unit, wave, gold, boardUnits) {
        var cost = parseInt(unit.goldCost, 10) || 0;
        if (cost <= 0 || cost > gold) return null;
        if (unit.unitClass === 'Creature' || unit.unitClass === 'King') return null;

        var offMult = getDamageMultiplier(unit.attackType, wave.defType);
        var defMult = getDamageMultiplier(wave.dmgType, unit.armorType);
        // For defense, lower multiplier is better (wave deals less damage to you)
        var defScore = 2.0 - defMult; // Invert: 0.80 -> 1.20 (good), 1.20 -> 0.80 (bad)

        // Offensive type match score (0-100 scale)
        var offensiveScore = ((offMult - 0.75) / 0.50) * 100;
        offensiveScore = clamp(offensiveScore, 0, 100);

        // Defensive type match score (0-100 scale)
        var defensiveScore = ((defScore - 0.75) / 0.50) * 100;
        defensiveScore = clamp(defensiveScore, 0, 100);

        // Gold efficiency: DPS per gold (normalized)
        var dps = parseFloat(unit.dps) || 0;
        var goldEff = cost > 0 ? (dps / cost) * 100 : 0;
        goldEff = clamp(goldEff, 0, 100);

        // Upgrade bonus: if this unit upgrades from something on the board
        var isUpgrade = false;
        if (unit.upgradesFrom && boardUnits && boardUnits.length > 0) {
            for (var i = 0; i < boardUnits.length; i++) {
                if (boardUnits[i] === unit.upgradesFrom) {
                    isUpgrade = true;
                    break;
                }
            }
        }
        var upgradeScore = isUpgrade ? 100 : 0;

        // Tier relevance
        var tierScore = scoreTierRelevance(unit.infoTier, wave.wave);

        var totalScore =
            (offensiveScore * WEIGHTS.offensiveTypeMatch +
             defensiveScore * WEIGHTS.defensiveTypeMatch +
             goldEff        * WEIGHTS.goldEfficiency +
             upgradeScore   * WEIGHTS.upgradeBonus +
             tierScore      * WEIGHTS.tierRelevance) / 100;

        return {
            unit: unit,
            totalScore: Math.round(totalScore * 10) / 10,
            offensiveMultiplier: offMult,
            defensiveMultiplier: defMult,
            goldEfficiency: Math.round(goldEff * 10) / 10,
            isUpgrade: isUpgrade,
            cost: cost
        };
    }

    /**
     * Returns a 0-100 score for how relevant a unit's tier is to the current wave.
     */
    function scoreTierRelevance(tier, waveNum) {
        if (!tier || !waveNum) return 50;
        var range = TIER_WAVE_MAP[tier];
        if (!range) return 50;
        if (waveNum >= range.min && waveNum <= range.max) return 100;
        var distance = waveNum < range.min
            ? range.min - waveNum
            : waveNum - range.max;
        return clamp(100 - distance * 15, 0, 100);
    }

    /**
     * Generates ranked recommendations for the current game state.
     *
     * @param {Object} params
     * @param {number} params.waveNum - Current wave number (1-21).
     * @param {number} params.gold - Player's available gold.
     * @param {string} params.legionId - Player's selected legion ID.
     * @param {Array}  params.boardUnitIds - Unit IDs on the player's board.
     * @param {number} [params.topN=5] - Number of top recommendations to return.
     * @returns {Object} Recommendations and wave info.
     */
    function getRecommendations(params) {
        var waveNum = params.waveNum || 1;
        var gold = params.gold || 0;
        var legionId = params.legionId || '';
        var boardUnitIds = params.boardUnitIds || [];
        var topN = params.topN || 5;

        // Look up wave data
        var wave = findWave(waveNum);
        if (!wave) {
            return { wave: null, recommendations: [], error: 'Wave not found: ' + waveNum };
        }

        // Get all units available for this legion
        var availableUnits = getUnitsForLegion(legionId);

        // Score each unit
        var scored = [];
        for (var i = 0; i < availableUnits.length; i++) {
            var result = scoreUnit(availableUnits[i], wave, gold, boardUnitIds);
            if (result) {
                scored.push(result);
            }
        }

        // Sort by total score descending
        scored.sort(function (a, b) { return b.totalScore - a.totalScore; });

        return {
            wave: wave,
            recommendations: scored.slice(0, topN),
            totalScored: scored.length
        };
    }

    /**
     * Finds wave data by wave number.
     */
    function findWave(waveNum) {
        if (!window.SmartOverlayWaves) return null;
        var waves = window.SmartOverlayWaves;
        for (var i = 0; i < waves.length; i++) {
            if (waves[i].wave === waveNum) return waves[i];
        }
        return null;
    }

    /**
     * Returns all Fighter units for a given legion.
     * If no legionId provided, returns all fighters.
     */
    function getUnitsForLegion(legionId) {
        if (!window.SmartOverlayUnits) return [];
        var units = window.SmartOverlayUnits;
        var result = [];
        for (var i = 0; i < units.length; i++) {
            var u = units[i];
            if (u.unitClass !== 'Fighter') continue;
            if (legionId && u.legionId && u.legionId !== legionId) continue;
            result.push(u);
        }
        return result;
    }

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    /**
     * Extracts the icon filename (lowercase, no extension) from a path.
     * e.g. "icons/Peewee.png" -> "peewee", "Icons/Peewee.png" -> "peewee"
     */
    function extractIconName(path) {
        if (!path) return '';
        var parts = path.replace(/\\/g, '/').split('/');
        var filename = parts[parts.length - 1];
        return filename.replace(/\.png$/i, '').toLowerCase();
    }

    /**
     * Extracts a unit name from dashboard action header HTML.
     * e.g. "<b>Deploy Peewee</b> <span...>[Q]</span>" -> "Peewee"
     */
    function extractUnitNameFromHeader(header) {
        if (!header) return '';
        var match = header.match(/<b>Deploy\s+(.+?)<\/b>/i);
        if (match) return match[1].trim();
        // Fallback: try without "Deploy"
        match = header.match(/<b>(.+?)<\/b>/i);
        if (match) return match[1].trim();
        return '';
    }

    /**
     * Builds a lookup map from icon filename (lowercase) to unit object.
     */
    function buildIconLookup() {
        if (!window.SmartOverlayUnits) return {};
        var units = window.SmartOverlayUnits;
        var map = {};
        for (var i = 0; i < units.length; i++) {
            var key = extractIconName(units[i].iconPath);
            if (key) map[key] = units[i];
        }
        return map;
    }

    /**
     * Scores units from dashboard actions (the in-game purchase bar).
     *
     * @param {Array}  actions  - Dashboard action objects from refreshDashboardActions.
     * @param {number} waveNum  - Current wave number (1-21).
     * @param {number} gold     - Player's current gold.
     * @returns {Object} Wave info and sorted recommendations.
     */
    function scoreFromDashboardActions(actions, waveNum, gold) {
        var effectiveWave = waveNum > 0 ? waveNum : 1;
        var wave = findWave(effectiveWave);
        if (!wave) {
            return { wave: null, recommendations: [], totalScored: 0 };
        }

        var iconLookup = buildIconLookup();
        var scored = [];

        for (var i = 0; i < actions.length; i++) {
            var action = actions[i];
            var iconKey = extractIconName(action.image);
            var dbUnit = iconKey ? iconLookup[iconKey] : null;

            if (dbUnit) {
                // Score against wave using existing logic
                var offMult = getDamageMultiplier(dbUnit.attackType, wave.defType);
                var defMult = getDamageMultiplier(wave.dmgType, dbUnit.armorType);
                var defScore = 2.0 - defMult;

                var offensiveScore = ((offMult - 0.75) / 0.50) * 100;
                offensiveScore = clamp(offensiveScore, 0, 100);

                var defensiveScore = ((defScore - 0.75) / 0.50) * 100;
                defensiveScore = clamp(defensiveScore, 0, 100);

                var dps = parseFloat(dbUnit.dps) || 0;
                var cost = parseInt(dbUnit.goldCost, 10) || action.goldCost || 0;
                var goldEff = cost > 0 ? (dps / cost) * 100 : 0;
                goldEff = clamp(goldEff, 0, 100);

                var tierScore = scoreTierRelevance(dbUnit.infoTier, effectiveWave);

                var totalScore =
                    (offensiveScore * WEIGHTS.offensiveTypeMatch +
                     defensiveScore * WEIGHTS.defensiveTypeMatch +
                     goldEff        * WEIGHTS.goldEfficiency +
                     tierScore      * WEIGHTS.tierRelevance) / 100;

                scored.push({
                    unit: dbUnit,
                    totalScore: Math.round(totalScore * 10) / 10,
                    offensiveMultiplier: offMult,
                    defensiveMultiplier: defMult,
                    goldEfficiency: Math.round(goldEff * 10) / 10,
                    isUpgrade: false,
                    cost: action.goldCost || cost,
                    grayedOut: !!action.grayedOut,
                    actionIndex: action.index,
                    canAfford: gold > 0 ? (action.goldCost || cost) <= gold : true
                });
            } else {
                // Unmatched action — include with neutral score
                var unitName = extractUnitNameFromHeader(action.header) || iconKey || 'Unknown';
                scored.push({
                    unit: {
                        name: unitName,
                        iconPath: action.image || '',
                        attackType: '?',
                        armorType: '?',
                        unitId: action.actionId || ''
                    },
                    totalScore: 0,
                    offensiveMultiplier: 1.0,
                    defensiveMultiplier: 1.0,
                    goldEfficiency: 0,
                    isUpgrade: false,
                    cost: action.goldCost || 0,
                    grayedOut: !!action.grayedOut,
                    actionIndex: action.index,
                    canAfford: gold > 0 ? (action.goldCost || 0) <= gold : true
                });
            }
        }

        scored.sort(function (a, b) { return b.totalScore - a.totalScore; });

        return {
            wave: wave,
            recommendations: scored,
            totalScored: scored.length
        };
    }

    // Public API
    return {
        getRecommendations: getRecommendations,
        scoreFromDashboardActions: scoreFromDashboardActions,
        getDamageMultiplier: getDamageMultiplier,
        multiplierToPercent: multiplierToPercent,
        multiplierClass: multiplierClass,
        DAMAGE_MATRIX: DAMAGE_MATRIX
    };
})();

window.SmartOverlayEngine = SmartOverlayEngine;
