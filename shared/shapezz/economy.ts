/**
 * SHAPEZZ's own economy: shards. A run's length, difficulty and loot make a
 * shard offer at every checkpoint; cashing out banks the offer, dying salvages
 * a share of it. Shards buy the workshop: chassis levels and weapons. Every
 * cost and reward curve lives here, shared by the server (settlement,
 * prices) and the client (the live offer, the workshop).
 * `bun scripts/shapezz-economy.ts` prints what the curves add up to.
 */
import {
    SHAPEZZ_CHECKPOINT_MS,
    SHAPEZZ_PERMANENT_UPGRADES,
    shapezzCheckpointCount,
    shapezzCheckpointPressure,
    shapezzDifficulty,
    type ShapezzDifficultyId,
    type ShapezzPermanentUpgradeId,
    type ShapezzWeaponRarity,
    type ShapezzWeaponType
} from './rules'

// ─── Earning ────────────────────────────────────────────────────────────────

/**
 * Loot points one enemy drops (the in-run score the shard offer is made of).
 * Later mutations raise both the value and the density of the crowd, and the
 * selected difficulty multiplies it.
 */
export const SHAPEZZ_LOOT_SCALE = 10

export function shapezzEnemyLoot(baseReward: number, elapsedMs: number, difficultyId: ShapezzDifficultyId) {
    const pressure = shapezzCheckpointPressure(shapezzCheckpointCount(elapsedMs))
    const minutes = Math.max(0, elapsedMs) / 60_000
    return Math.max(1, Math.round(
        Math.max(0, baseReward)
        * SHAPEZZ_LOOT_SCALE
        * shapezzDifficulty(difficultyId).reward
        * pressure.reward
        * (1 + minutes * 0.025)
    ))
}

/**
 * The most loot a run of this length and difficulty can claim (excellent play
 * reaches it). Settlement only believes the client's loot up to here, and the
 * length itself is capped by the server's clock.
 */
export const SHAPEZZ_LOOT_HEADROOM = 4096
export const SHAPEZZ_LOOT_EXPONENT = 2.4

export function shapezzLootCeiling(elapsedMs: number, difficultyId: ShapezzDifficultyId) {
    const bounded = Math.max(0, Math.min(elapsedMs, 60 * 60_000))
    return Math.floor(
        SHAPEZZ_LOOT_HEADROOM
        * Math.pow(bounded / SHAPEZZ_CHECKPOINT_MS, SHAPEZZ_LOOT_EXPONENT)
        * shapezzDifficulty(difficultyId).reward
    )
}

/**
 * The shard offer for a run so far: the same number on the HUD and at
 * settlement. It grows faster than the run is long (`OFFER_DEPTH`), so pushing
 * to a later checkpoint always pays more per minute than banking early and
 * restarting, and harder difficulties pay more for the same time. The loot the
 * run actually collected, against the ceiling, scales it: a sloppy run that
 * lets its drops expire banks less than a clean one of the same length.
 */
export const SHAPEZZ_OFFER_BASE = 7
export const SHAPEZZ_OFFER_DEPTH = 1.5
export const SHAPEZZ_OFFER_DIFFICULTY: Record<ShapezzDifficultyId, number> = {
    spark: 0.8,
    surge: 1,
    overdrive: 1.25,
    mayhem: 1.5,
    annihilation: 1.8
}

/** How much of the loot ceiling the run collected, as the offer's 0-1 quality factor. */
export function shapezzLootQuality(loot: number, elapsedMs: number, difficultyId: ShapezzDifficultyId) {
    const ceiling = shapezzLootCeiling(elapsedMs, difficultyId)
    if (ceiling <= 0) return 0
    const safe = Math.max(0, Number.isFinite(loot) ? loot : 0)
    return Math.sqrt(Math.min(1, safe / ceiling))
}

export function shapezzRunOffer(loot: number, elapsedMs: number, difficultyId: ShapezzDifficultyId) {
    const rounds = Math.max(0, Math.min(elapsedMs, 60 * 60_000)) / SHAPEZZ_CHECKPOINT_MS
    return Math.floor(
        SHAPEZZ_OFFER_BASE
        * SHAPEZZ_OFFER_DIFFICULTY[shapezzDifficulty(difficultyId).id]
        * Math.pow(rounds, SHAPEZZ_OFFER_DEPTH)
        * shapezzLootQuality(loot, elapsedMs, difficultyId)
    )
}

/** Dying keeps this share of the offer; cashing out at a checkpoint keeps all of it. */
export const SHAPEZZ_DEFEAT_SHARE = 0.25

export function shapezzDefeatSalvage(offer: number) {
    return Math.floor(Math.max(0, offer) * SHAPEZZ_DEFEAT_SHARE)
}

// ─── Spending ───────────────────────────────────────────────────────────────

/** Chassis tracks: first level and per-level growth. Blood Battery has its own short list. */
export const SHAPEZZ_CHASSIS_COSTS: Record<Exclude<ShapezzPermanentUpgradeId, 'killHeal'>, { base: number, growth: number }> = {
    core: { base: 14, growth: 1.28 },
    overclock: { base: 15, growth: 1.28 },
    armor: { base: 12, growth: 1.28 },
    thrusters: { base: 12, growth: 1.28 },
    magnet: { base: 10, growth: 1.28 }
}
export const SHAPEZZ_KILL_HEAL_COSTS = [250, 550, 1000, 1800]

export function shapezzPermanentUpgradeCost(id: ShapezzPermanentUpgradeId, level: number): number | null {
    if (level < 0 || level >= SHAPEZZ_PERMANENT_UPGRADES[id].maxLevel) return null
    if (id === 'killHeal') return SHAPEZZ_KILL_HEAL_COSTS[level] ?? null
    const { base, growth } = SHAPEZZ_CHASSIS_COSTS[id]
    return Math.round(base * Math.pow(growth, level))
}

/** What a weapon costs outright. The Common Pulse Carbine is the free starter. */
export const SHAPEZZ_WEAPON_PRICES: Record<ShapezzWeaponType, Record<ShapezzWeaponRarity, number>> = {
    blaster: { common: 0, rare: 100, epic: 350, legendary: 1100, mythic: 2600 },
    launcher: { common: 80, rare: 200, epic: 550, legendary: 1500, mythic: 3200 },
    shotgun: { common: 60, rare: 170, epic: 480, legendary: 1350, mythic: 3000 },
    arcCoil: { common: 70, rare: 190, epic: 520, legendary: 1400, mythic: 3100 },
    railgun: { common: 90, rare: 220, epic: 600, legendary: 1600, mythic: 3300 }
}

export function shapezzWeaponPrice(type: ShapezzWeaponType, rarity: ShapezzWeaponRarity) {
    return SHAPEZZ_WEAPON_PRICES[type][rarity]
}

/** Moving up a weapon type trades in this share of what the previous rarity cost. */
export const SHAPEZZ_WEAPON_TRADE_IN = 0.25

export function shapezzWeaponRefund(purchasePrice: number) {
    return Math.floor(Math.max(0, purchasePrice) * SHAPEZZ_WEAPON_TRADE_IN)
}

export function shapezzWeaponReplacement(purchasePrice: number, nextWeaponCost: number) {
    const refund = shapezzWeaponRefund(purchasePrice)
    return { refund, netCost: Math.max(0, nextWeaponCost) - refund }
}
