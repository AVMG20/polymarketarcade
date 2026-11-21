/**
 * Pirate Raid's economy: doubloons, the game's own currency. Voyages pay them
 * (by the second afloat, plus a completion bonus and a one-off bounty for each
 * new difficulty cleared) and the armory spends them. Every price and pay curve
 * lives here, read by the server (which settles and charges) and the client
 * (which only displays). `bun scripts/pirate-raid-economy.ts` prints how many
 * voyages each purchase takes; tune there.
 *
 * Amounts stay small integers: a new ship's voyage pays about 3, a first clear
 * of the calmest sea 36 (+24 once), a clear at the top of the selector 126 (176
 * with every Letter of Marque); the dearest purchase is 1,800 and everything
 * together about 25,000. The sim puts a full max-out at 30 to 35 hours.
 */

import {
    PIRATE_ABILITIES, PIRATE_ABILITY_MAX_LEVEL, PIRATE_CANNON_TIERS, PIRATE_MAX_CANNON_SLOTS,
    PIRATE_RUN_DURATION_MS, PIRATE_SHIP_SKINS, pirateNormalizeDifficulty, pirateStatMaxLevel,
    type PirateShipStatId
} from './rules'

// ─── Voyage pay ─────────────────────────────────────────────────────────────

/** Survival pay for a full six-minute voyage at difficulty 0, and what each difficulty point adds. */
export const PIRATE_PAY_BASE = 24
export const PIRATE_PAY_PER_DIFFICULTY = 0.06
/** Surviving all six minutes adds this share of the full survival pay. */
export const PIRATE_COMPLETION_BONUS_RATE = 0.5
/** Clearing a difficulty for the first time pays this share of its full survival pay, once. */
export const PIRATE_FIRST_CLEAR_RATE = 1

/** Survival pay for a full voyage at this difficulty (before the completion bonus and the marque). */
export function pirateFullVoyagePay(difficulty: number) {
    return PIRATE_PAY_BASE + pirateNormalizeDifficulty(difficulty) * PIRATE_PAY_PER_DIFFICULTY
}

/** Share of the base pay that arrives at a steady rate; the rest grows with time afloat. */
export const PIRATE_PAY_STEADY_SHARE = 0.7

/**
 * Doubloons banked by surviving `elapsedMs` of a voyage (unrounded; the HUD
 * counts it up). The base pay arrives mostly at a steady rate, but what a
 * harder sea adds grows with the square of time afloat: choosing a sea far too
 * hard and sinking early pays about what the easy sea would have.
 */
export function pirateSurvivalPay(elapsedMs: number, difficulty: number, multiplier = 1) {
    const t = Math.min(1, Math.max(0, elapsedMs / PIRATE_RUN_DURATION_MS))
    const base = PIRATE_PAY_BASE * (t * PIRATE_PAY_STEADY_SHARE + t * t * (1 - PIRATE_PAY_STEADY_SHARE))
    const premium = pirateNormalizeDifficulty(difficulty) * PIRATE_PAY_PER_DIFFICULTY * t * t
    return (base + premium) * multiplier
}

export function pirateCompletionBonus(difficulty: number, multiplier = 1) {
    return Math.round(pirateFullVoyagePay(difficulty) * PIRATE_COMPLETION_BONUS_RATE * multiplier)
}

/** One-off bounty for the first clear of a difficulty (not scaled by the marque). */
export function pirateFirstClearBounty(difficulty: number) {
    return Math.round(pirateFullVoyagePay(difficulty) * PIRATE_FIRST_CLEAR_RATE)
}

export interface PirateVoyagePay {
    survival: number
    completion: number
    firstClear: number
    total: number
}

/**
 * Everything a settled voyage pays. `highestCleared` is the best difficulty
 * cleared before this voyage (-1 for none), so the bounty pays once per level.
 */
export function pirateVoyagePay(elapsedMs: number, difficulty: number, completed: boolean, marqueLevel: number, highestCleared: number): PirateVoyagePay {
    const multiplier = pirateMarqueMultiplier(marqueLevel)
    const survival = Math.floor(pirateSurvivalPay(elapsedMs, difficulty, multiplier))
    const completion = completed ? pirateCompletionBonus(difficulty, multiplier) : 0
    const firstClear = completed && difficulty > highestCleared ? pirateFirstClearBounty(difficulty) : 0
    return { survival, completion, firstClear, total: survival + completion + firstClear }
}

// ─── Letters of Marque ──────────────────────────────────────────────────────
// A standing commission: every level raises survival pay and the completion
// bonus by 4%. A slow investment: it pays for itself in about ten voyages once
// a captain clears the middle of the selector.

export const PIRATE_MARQUE_MAX_LEVEL = 10
export const PIRATE_MARQUE_STEP = 0.04
export const PIRATE_MARQUE_COSTS = [25, 50, 90, 150, 230, 330, 460, 620, 820, 1080] as const

export function pirateMarqueMultiplier(level: number) {
    const clamped = Math.max(0, Math.min(PIRATE_MARQUE_MAX_LEVEL, Math.floor(Number.isFinite(level) ? level : 0)))
    return 1 + clamped * PIRATE_MARQUE_STEP
}

export function pirateMarqueUpgradeCost(level: number): number | null {
    return level >= PIRATE_MARQUE_MAX_LEVEL ? null : PIRATE_MARQUE_COSTS[Math.max(0, level)]!
}

// ─── Ship stats ─────────────────────────────────────────────────────────────

/** Cost of level n → n + 1 for the four ten-level stats (index 0 is level 1 → 2). */
export const PIRATE_STAT_COSTS = [2, 4, 8, 14, 25, 45, 80, 140, 250] as const
/** Repairs (regen) is a short, strong track. */
export const PIRATE_REGEN_COSTS = [12, 40, 130, 380] as const

export function pirateStatUpgradeCost(statId: PirateShipStatId, level: number): number | null {
    if (level >= pirateStatMaxLevel(statId) || level < 1) return null
    const table = statId === 'regen' ? PIRATE_REGEN_COSTS : PIRATE_STAT_COSTS
    return table[level - 1] ?? null
}

// ─── Gun ports and cannons ──────────────────────────────────────────────────

/** Cost to open port n + 1, given n open (index 0 opens the second port). */
export const PIRATE_SLOT_COSTS = [4, 10, 25, 60, 140, 320, 650] as const

export function pirateSlotUnlockCost(currentSlots: number): number | null {
    if (currentSlots >= PIRATE_MAX_CANNON_SLOTS || currentSlots < 1) return null
    return PIRATE_SLOT_COSTS[currentSlots - 1] ?? null
}

export const PIRATE_CANNON_COSTS: Record<string, number> = {
    swivel: 0,
    carronade: 4,
    culverin: 10,
    longgun: 25,
    basilisk: 65,
    mythril: 180,
    adamantite: 480,
    leviathan: 1200
}

export function pirateCannonCost(tierId: string) {
    return PIRATE_CANNON_COSTS[tierId] ?? 0
}

/** Refitting a port trades the old gun in for this share of what it cost. */
export const PIRATE_CANNON_TRADE_IN_RATE = 0.5

export function pirateCannonTradeIn(purchasePrice: number) {
    return Math.floor(purchasePrice * PIRATE_CANNON_TRADE_IN_RATE)
}

// ─── Abilities ──────────────────────────────────────────────────────────────

export const PIRATE_ABILITY_COSTS: Record<string, number> = {
    bomb: 0,
    seekers: 150,
    consort: 150,
    maelstrom: 150,
    firestorm: 150,
    tidal: 150
}

export function pirateAbilityCost(abilityId: string) {
    return PIRATE_ABILITY_COSTS[abilityId] ?? 0
}

/** Cost of ability level n → n + 1 (index 0 is level 1 → 2). */
export const PIRATE_ABILITY_UPGRADE_COSTS = [15, 50, 160, 450] as const

export function pirateAbilityUpgradeCost(level: number): number | null {
    if (level >= PIRATE_ABILITY_MAX_LEVEL || level < 1) return null
    return PIRATE_ABILITY_UPGRADE_COSTS[level - 1] ?? null
}

// ─── Skins (cosmetic) ───────────────────────────────────────────────────────

export const PIRATE_SKIN_COSTS: Record<string, number> = {
    'starter': 0,
    'crimson-privateer': 100,
    'emerald-serpent': 300,
    'royal-aether': 700,
    'crown-of-tides': 1800
}

export function pirateSkinCost(skinId: string) {
    return PIRATE_SKIN_COSTS[skinId] ?? 0
}

// ─── Totals (for the sim and the tests) ─────────────────────────────────────

/** Everything there is to buy, with the top gun in every port bought outright. */
export function pirateFullTreeCost() {
    let total = 0
    for (const statId of ['hull', 'speed', 'defense', 'ammoCapacity', 'regen'] as const) {
        for (let level = 1; level < pirateStatMaxLevel(statId); level++) total += pirateStatUpgradeCost(statId, level) ?? 0
    }
    for (let slots = 1; slots < PIRATE_MAX_CANNON_SLOTS; slots++) total += pirateSlotUnlockCost(slots) ?? 0
    total += pirateCannonCost(PIRATE_CANNON_TIERS[PIRATE_CANNON_TIERS.length - 1]!.id) * PIRATE_MAX_CANNON_SLOTS
    for (const ability of PIRATE_ABILITIES) {
        total += pirateAbilityCost(ability.id)
        for (let level = 1; level < PIRATE_ABILITY_MAX_LEVEL; level++) total += pirateAbilityUpgradeCost(level) ?? 0
    }
    for (let level = 0; level < PIRATE_MARQUE_MAX_LEVEL; level++) total += pirateMarqueUpgradeCost(level) ?? 0
    for (const skin of PIRATE_SHIP_SKINS) total += pirateSkinCost(skin.id)
    return total
}
