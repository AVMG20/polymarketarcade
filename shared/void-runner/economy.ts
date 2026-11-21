// ─── Void Runner: the economy, in one place ─────────────────────────────────
//
// Void Runner has no money of its own beyond what you fly home: ferrite,
// cobalt, iridium and xenite out of asteroids, scrap and alloy out of wrecks
// and kills, warp cores off wardens. Every price in the shipyard, workshop and
// station is a bundle of those, so the only way to progress is to fly.
//
// Every number a player sees stays small: a fresh pilot hauls a few dozen
// units a run, a maxed one a few hundred, and the priciest hull costs a few
// thousand. The knobs below shape every curve; `bun scripts/void-runner-economy.ts`
// prints how many runs each tier takes to afford.

import type { VoidResourceBundle, VoidResourceId } from './void'

/** Units of ore one chunk of a broken asteroid is worth (the yield formula multiplies by this). */
export const VOID_UNIT_SCALE = 0.6

/**
 * The catalogue below is authored in the original game's units; every
 * quantity (holds, recipes, prices) is multiplied by this on the way out.
 */
export const VOID_QTY = 0.2

/** Price multipliers per kind of purchase, on top of VOID_QTY. Tuned with the economy sim. */
export const VOID_COST_MULT = {
    /** Station systems (engines, cargo, mining, drones). */
    system: 1.6,
    /** New hulls. */
    ship: 0.55,
    /** Lifting a hull a tier. */
    refit: 0.55,
    /** Crafting gear. */
    craft: 1.4,
    /** Levelling gear +1 … +10. */
    level: 2.4,
    /** Unlocking a pilot skill. */
    skill: 1.5,
    /** One supply (nanites, shield cell, EMP). */
    supply: 1,
    /** What a daily contract asks for. */
    contract: 1
} as const

export type VoidCostKind = keyof typeof VOID_COST_MULT

/**
 * Per-level growth of the station systems and gear levels. The early steps
 * cost about a run, the last ones a long evening.
 */
export const VOID_SYSTEM_GROWTH = 1.55
export const VOID_LEVEL_GROWTH = 1.36

/** What each material counts for in a haul's value (records and the leaderboard). */
export const VOID_RESOURCE_VALUE: Record<VoidResourceId, number> = {
    ferrite: 1,
    scrap: 1,
    cobalt: 2,
    iridium: 2,
    alloy: 3,
    xenite: 3,
    core: 25
}

/**
 * Most a hold can take on per minute of flight, whatever the client says. An
 * honest maxed hull mining a rich deep zone stays well under it; a forged
 * report can't bank more than an excellent pilot could.
 */
export const VOID_HAUL_RATE_CAP = 90
/** Slack over the hull's hold for a haul (rounding and pickups in flight at the dock). */
export const VOID_HOLD_SLACK = 1.1

/** What the Free Trader out in a sector takes from the hold, in units, per offer. */
export const VOID_TRADER_COSTS = { nanites: 30, cell: 25, fuel: 50 } as const

/** A daily contract pays this share of what it asks for back in alloy, plus pilot XP. */
export const VOID_CONTRACT_ALLOY_SHARE = 0.15

/** Round a price or hold to a clean number: units under 20, fives under 200, tens above. */
export function voidRound(n: number) {
    if (!(n > 0)) return 0
    if (n < 20) return Math.max(1, Math.round(n))
    if (n < 200) return Math.round(n / 5) * 5
    return Math.round(n / 10) * 10
}

/** An authored quantity (hold, recipe line) in game units. */
export function voidQty(n: number, mult = 1) {
    return voidRound(n * VOID_QTY * mult)
}

/**
 * A price bundle in game units. Warp cores are trophies: counted one by one,
 * never scaled.
 */
export function voidPrice(bundle: VoidResourceBundle, kind: VoidCostKind, extra = 1): VoidResourceBundle {
    const out: VoidResourceBundle = {}
    for (const [id, amount] of Object.entries(bundle)) {
        const n = id === 'core' ? Math.round(amount ?? 0) : voidQty(amount ?? 0, VOID_COST_MULT[kind] * extra)
        if (n > 0) out[id as VoidResourceId] = n
    }
    return out
}
