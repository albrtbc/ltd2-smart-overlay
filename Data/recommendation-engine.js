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
     * Derives a role string from unit stats (HP/DPS ratio).
     * Used as fallback when the action object doesn't include a role.
     * Returns 'role_tank', 'role_balanced', 'role_dps', or ''.
     */
    function computeRole(unit) {
        if (!unit) return '';
        var hp = parseFloat(unit.hp) || 0;
        var dps = parseFloat(unit.dps) || 0;
        if (hp <= 0 || dps <= 0) return '';
        var ratio = hp / dps;
        if (ratio > 27) return 'role_tank';
        if (ratio > 17) return 'role_balanced';
        return 'role_dps';
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
     * Extracts mythium cost from windshield action subheader HTML.
     * e.g. "<img .../> <span style='color: #33bbbb'>20</span>" -> 20
     */
    function extractMythiumCost(subheader) {
        if (!subheader) return 0;
        var match = subheader.match(/>(\d+)<\/span>/);
        return match ? parseInt(match[1], 10) : 0;
    }

    /**
     * Extracts the keyboard shortcut from dashboard action header HTML.
     * e.g. "<b>Deploy Peewee</b> <span...>[Q]</span>" -> "Q"
     */
    function extractShortcutFromHeader(header) {
        if (!header) return '';
        var match = header.match(/\[([A-Z0-9])\]/i);
        if (match) return match[1].toUpperCase();
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
     * Builds a lookup map from unit name (lowercase) to unit object.
     */
    function buildNameLookup() {
        if (!window.SmartOverlayUnits) return {};
        var units = window.SmartOverlayUnits;
        var map = {};
        for (var i = 0; i < units.length; i++) {
            if (units[i].name) map[units[i].name.toLowerCase()] = units[i];
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

            var shortcut = extractShortcutFromHeader(action.header);

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
                    role: action.role || computeRole(dbUnit),
                    actionIndex: action.index,
                    shortcut: shortcut,
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
                    role: action.role || '',
                    actionIndex: action.index,
                    shortcut: shortcut,
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

    /**
     * Analyzes the opponent's fighter grid from scoreboard data.
     * Returns both attack and defense type breakdowns.
     *
     * @param {Array} grid - Array of tower objects from player.grid (each has .image, .unitType)
     * @returns {Object} { defenseBreakdown, attackBreakdown, totalFighters }
     */
    function analyzeOpponentGrid(grid) {
        if (!grid || grid.length === 0) {
            return {
                defenseBreakdown: {}, attackBreakdown: {},
                defenseValue: {}, attackValue: {},
                totalFighters: 0, totalValue: 0
            };
        }

        var iconLookup = buildIconLookup();
        var nameLookup = buildNameLookup();
        var defBreakdown = {};  // count per armor type
        var atkBreakdown = {};  // count per attack type
        var defValue = {};      // gold value per armor type
        var atkValue = {};      // gold value per attack type
        var total = 0;
        var totalVal = 0;

        for (var i = 0; i < grid.length; i++) {
            var tower = grid[i];
            if (!tower.image && !tower.name) continue;

            var iconKey = extractIconName(tower.image);
            var dbUnit = iconKey ? iconLookup[iconKey] : null;
            // Fallback: lookup by name if icon didn't match
            if (!dbUnit && tower.name) {
                dbUnit = nameLookup[tower.name.toLowerCase()] || null;
            }

            if (dbUnit) {
                var armor = dbUnit.armorType || 'Unknown';
                var attack = dbUnit.attackType || 'Unknown';
                var goldVal = parseInt(dbUnit.goldCost, 10) || 50;

                defBreakdown[armor] = (defBreakdown[armor] || 0) + 1;
                atkBreakdown[attack] = (atkBreakdown[attack] || 0) + 1;
                defValue[armor] = (defValue[armor] || 0) + goldVal;
                atkValue[attack] = (atkValue[attack] || 0) + goldVal;
                total++;
                totalVal += goldVal;
            } else {
                defBreakdown['Unknown'] = (defBreakdown['Unknown'] || 0) + 1;
                atkBreakdown['Unknown'] = (atkBreakdown['Unknown'] || 0) + 1;
                total++;
            }
        }

        return {
            defenseBreakdown: defBreakdown, attackBreakdown: atkBreakdown,
            defenseValue: defValue, attackValue: atkValue,
            totalFighters: total, totalValue: totalVal
        };
    }

    /**
     * Scores mercenaries against the opponent's fighter composition.
     * Filters to show only affordable mercs + a few near-affordable ones (dimmed).
     *
     * @param {Array}  actions - Windshield actions (mercenary bar).
     * @param {Array}  defenderGrid - Cached grid array from defender's scoreboard data.
     * @param {number} mythium - Player's current mythium.
     * @returns {Object} { defenseBreakdown, totalFighters, recommendations[] }
     */
    function scoreMercenaries(actions, defenderGrid, mythium) {
        var result = {
            defenseBreakdown: {},
            attackBreakdown: {},
            defenseValue: {},
            attackValue: {},
            totalFighters: 0,
            totalValue: 0,
            recommendations: [],
            totalScored: 0
        };

        if (!actions || actions.length === 0) return result;

        var analysis = analyzeOpponentGrid(defenderGrid);
        result.defenseBreakdown = analysis.defenseBreakdown;
        result.attackBreakdown = analysis.attackBreakdown;
        result.defenseValue = analysis.defenseValue;
        result.attackValue = analysis.attackValue;
        result.totalFighters = analysis.totalFighters;
        result.totalValue = analysis.totalValue;

        var iconLookup = buildIconLookup();
        var scored = [];
        var currentMythium = mythium || 0;

        for (var i = 0; i < actions.length; i++) {
            var action = actions[i];
            var iconKey = extractIconName(action.image);
            var dbUnit = iconKey ? iconLookup[iconKey] : null;
            var shortcut = extractShortcutFromHeader(action.header);
            // Merc cost is mythium, stored in subheader HTML, not goldCost
            var cost = action.goldCost || extractMythiumCost(action.subheader) || 0;
            var canAfford = currentMythium > 0 ? cost <= currentMythium : !action.grayedOut;
            // "Near affordable" = within 30 mythium of being able to buy
            var nearAffordable = !canAfford && currentMythium > 0 && cost <= currentMythium + 30;

            if (dbUnit && analysis.totalFighters > 0) {
                // Offensive score: merc attack vs opponent defense types
                // Weighted by gold value so evolved units matter more
                var offTotal = 0;
                var offWeight = 0;
                for (var defType in analysis.defenseValue) {
                    if (defType === 'Unknown') continue;
                    var defGold = analysis.defenseValue[defType];
                    var offMult = getDamageMultiplier(dbUnit.attackType, defType);
                    offTotal += offMult * defGold;
                    offWeight += defGold;
                }
                var avgOffMult = offWeight > 0 ? offTotal / offWeight : 1.0;

                // Defensive score: opponent attack types vs merc armor
                // Weighted by gold value
                var defTotal = 0;
                var defWeight = 0;
                for (var atkType in analysis.attackValue) {
                    if (atkType === 'Unknown') continue;
                    var atkGold = analysis.attackValue[atkType];
                    var defMult = getDamageMultiplier(atkType, dbUnit.armorType);
                    defTotal += defMult * atkGold;
                    defWeight += atkGold;
                }
                var avgDefMult = defWeight > 0 ? defTotal / defWeight : 1.0;
                // Invert: lower damage taken = better survival
                var survivalMult = 2.0 - avgDefMult;

                // Combine: 60% offense (how much damage merc deals), 40% survival
                var offScore = ((avgOffMult - 0.75) / 0.50) * 100;
                offScore = clamp(offScore, 0, 100);
                var defScore = ((survivalMult - 0.75) / 0.50) * 100;
                defScore = clamp(defScore, 0, 100);

                var totalScore = offScore * 0.6 + defScore * 0.4;

                scored.push({
                    unit: dbUnit,
                    totalScore: Math.round(totalScore * 10) / 10,
                    avgOffMult: avgOffMult,
                    avgDefMult: avgDefMult,
                    cost: cost,
                    grayedOut: !!action.grayedOut,
                    canAfford: canAfford,
                    nearAffordable: nearAffordable,
                    actionId: action.actionId != null ? action.actionId : '',
                    role: action.role || computeRole(dbUnit),
                    actionIndex: action.index,
                    shortcut: shortcut
                });
            } else {
                // No opponent data or unmatched merc
                var unitName = extractUnitNameFromHeader(action.header) || iconKey || 'Unknown';
                var fallbackUnit = dbUnit || {
                    name: unitName,
                    iconPath: action.image || '',
                    attackType: '?',
                    armorType: '?'
                };
                scored.push({
                    unit: fallbackUnit,
                    totalScore: 0,
                    avgOffMult: 1.0,
                    avgDefMult: 1.0,
                    cost: cost,
                    grayedOut: !!action.grayedOut,
                    canAfford: canAfford,
                    nearAffordable: nearAffordable,
                    actionId: action.actionId != null ? action.actionId : '',
                    role: action.role || computeRole(dbUnit),
                    actionIndex: action.index,
                    shortcut: shortcut
                });
            }
        }

        scored.sort(function (a, b) { return b.totalScore - a.totalScore; });

        // Filter: show affordable mercs + near-affordable (dimmed), hide the rest
        var filtered = [];
        for (var j = 0; j < scored.length; j++) {
            if (scored[j].canAfford || scored[j].nearAffordable) {
                filtered.push(scored[j]);
            }
        }

        result.recommendations = filtered;
        result.totalScored = filtered.length;
        return result;
    }

    /**
     * Evaluates whether to PUSH (send mercs) or HOLD (save mythium) based on
     * how the current wave's type matchups interact with the opponent's army.
     *
     * @param {number} waveNum - Current wave number.
     * @param {Object} defenseValue - Opponent armor types keyed by gold value.
     * @param {Object} attackValue - Opponent attack types keyed by gold value.
     * @returns {Object|null} { recommendation, score, waveOffAvg, oppKillAvg, waveName, waveDmgType, waveDefType }
     */
    function evaluatePushHold(waveNum, defenseValue, attackValue) {
        var wave = findWave(waveNum);
        if (!wave) return null;

        // How well does this wave's attack threaten the opponent's army?
        var waveOffTotal = 0, waveOffWeight = 0;
        for (var defType in defenseValue) {
            if (defType === 'Unknown') continue;
            var gold = defenseValue[defType];
            var mult = getDamageMultiplier(wave.dmgType, defType);
            waveOffTotal += mult * gold;
            waveOffWeight += gold;
        }
        var waveOffAvg = waveOffWeight > 0 ? waveOffTotal / waveOffWeight : 1.0;

        // How well does the opponent's army kill this wave?
        var oppKillTotal = 0, oppKillWeight = 0;
        for (var atkType in attackValue) {
            if (atkType === 'Unknown') continue;
            var gold2 = attackValue[atkType];
            var mult2 = getDamageMultiplier(atkType, wave.defType);
            oppKillTotal += mult2 * gold2;
            oppKillWeight += gold2;
        }
        var oppKillAvg = oppKillWeight > 0 ? oppKillTotal / oppKillWeight : 1.0;

        // Score > 0 = PUSH, Score < 0 = HOLD
        var pushScore = (waveOffAvg - 1.0) - (oppKillAvg - 1.0);

        return {
            recommendation: pushScore >= 0 ? 'PUSH' : 'HOLD',
            score: pushScore,
            waveOffAvg: waveOffAvg,
            oppKillAvg: oppKillAvg,
            waveName: wave.name,
            waveDmgType: wave.dmgType,
            waveDefType: wave.defType
        };
    }

    /**
     * Simulates optimal spending: greedily buys the best-scored units
     * for the current wave, then returns projected type breakdown + value.
     *
     * @param {Object} currentDefenseValue - Current armor types by gold value.
     * @param {Object} currentAttackValue - Current attack types by gold value.
     * @param {number} currentValue - Current total fighter value.
     * @param {Array}  scoredActions - Sorted recommendations from scoreFromDashboardActions.
     * @param {number} gold - Available gold to spend.
     * @returns {Object} { defenseValue, attackValue, projectedValue, purchaseCount }
     */
    function projectOptimalSpending(currentDefenseValue, currentAttackValue, currentValue, scoredActions, gold) {
        // Clone current type maps
        var defVal = {};
        var atkVal = {};
        for (var d in currentDefenseValue) {
            if (currentDefenseValue.hasOwnProperty(d)) defVal[d] = currentDefenseValue[d];
        }
        for (var a in currentAttackValue) {
            if (currentAttackValue.hasOwnProperty(a)) atkVal[a] = currentAttackValue[a];
        }

        var remaining = gold;
        var projValue = currentValue;
        var purchases = 0;

        // Greedy: buy best-scored affordable units
        for (var i = 0; i < scoredActions.length; i++) {
            var rec = scoredActions[i];
            if (rec.grayedOut) continue;
            var cost = rec.cost || 0;
            if (cost <= 0 || cost > remaining) continue;

            var unit = rec.unit;
            if (!unit) continue;

            var armor = unit.armorType || 'Unknown';
            var attack = unit.attackType || 'Unknown';

            defVal[armor] = (defVal[armor] || 0) + cost;
            atkVal[attack] = (atkVal[attack] || 0) + cost;
            remaining -= cost;
            projValue += cost;
            purchases++;
        }

        return {
            defenseValue: defVal,
            attackValue: atkVal,
            projectedValue: projValue,
            purchaseCount: purchases
        };
    }

    /**
     * Evaluates how well our own army handles a given wave.
     * STRONG = our army counters the wave type matchup.
     * WEAK = wave type matchup is bad for us.
     *
     * @param {number} waveNum - Wave number to evaluate.
     * @param {Object} myDefenseValue - Our armor types keyed by gold value.
     * @param {Object} myAttackValue - Our attack types keyed by gold value.
     * @returns {Object|null} { recommendation, score, ourOffAvg, waveDmgAvg, ... }
     */
    function evaluateDefenseStrength(waveNum, myDefenseValue, myAttackValue) {
        var wave = findWave(waveNum);
        if (!wave) return null;

        // How well do our attacks kill this wave?
        var ourOffTotal = 0, ourOffWeight = 0;
        for (var atkType in myAttackValue) {
            if (atkType === 'Unknown') continue;
            var gold = myAttackValue[atkType];
            var mult = getDamageMultiplier(atkType, wave.defType);
            ourOffTotal += mult * gold;
            ourOffWeight += gold;
        }
        var ourOffAvg = ourOffWeight > 0 ? ourOffTotal / ourOffWeight : 1.0;

        // How well does this wave's attack hurt our army?
        var waveDmgTotal = 0, waveDmgWeight = 0;
        for (var defType in myDefenseValue) {
            if (defType === 'Unknown') continue;
            var gold2 = myDefenseValue[defType];
            var mult2 = getDamageMultiplier(wave.dmgType, defType);
            waveDmgTotal += mult2 * gold2;
            waveDmgWeight += gold2;
        }
        var waveDmgAvg = waveDmgWeight > 0 ? waveDmgTotal / waveDmgWeight : 1.0;

        // positive = STRONG, negative = WEAK
        // Weight offense more — killing the wave fast matters most
        var defenseScore = (ourOffAvg - 1.0) * 0.7 - (waveDmgAvg - 1.0) * 0.3;

        return {
            recommendation: defenseScore >= 0 ? 'STRONG' : 'WEAK',
            score: defenseScore,
            ourOffAvg: ourOffAvg,
            waveDmgAvg: waveDmgAvg,
            waveName: wave.name,
            waveDmgType: wave.dmgType,
            waveDefType: wave.defType
        };
    }

    // Public API
    return {
        getRecommendations: getRecommendations,
        scoreFromDashboardActions: scoreFromDashboardActions,
        scoreMercenaries: scoreMercenaries,
        evaluatePushHold: evaluatePushHold,
        evaluateDefenseStrength: evaluateDefenseStrength,
        projectOptimalSpending: projectOptimalSpending,
        analyzeGrid: analyzeOpponentGrid,
        getDamageMultiplier: getDamageMultiplier,
        multiplierToPercent: multiplierToPercent,
        multiplierClass: multiplierClass,
        DAMAGE_MATRIX: DAMAGE_MATRIX
    };
})();

window.SmartOverlayEngine = SmartOverlayEngine;
