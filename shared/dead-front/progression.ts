import type { DfMatchResult } from './types'

// The between-match economy: medals. A match pays medals from the server's
// own result (rounds the squad completed, your kills, the easter egg); the
// Research tab spends them on perk research levels, and each level unlocks
// one of the perk's modifiers. Tuned with scripts/dead-front-economy.ts:
// the first level after a match or two, a new level every few matches, every
// perk fully researched after dozens of hours.

/** Research levels per perk (one modifier each). */
export const DF_PERK_MAX_LEVEL = 6

/** Medals to research level 1..6 of a perk (index 0 buys level 1). Every perk costs the same. */
export const DF_RESEARCH_COSTS: readonly number[] = [20, 45, 90, 160, 260, 400]

/** Medals to research the next level of a perk at `level`, or null when it is fully researched. */
export function dfResearchCost(level: number): number | null {
    return level >= 0 && level < DF_PERK_MAX_LEVEL ? DF_RESEARCH_COSTS[level]! : null
}

/**
 * Medals for completing round `round`: nothing for the two warm-up rounds,
 * then one more each round, so the pay keeps up with rounds that get longer
 * and a deep run earns more per hour than restarting short ones.
 */
export function dfRoundMedals(round: number): number {
    return Math.max(0, Math.floor(round) - 2)
}

/** Kills per medal, on top of the rounds. */
export const DF_KILLS_PER_MEDAL = 25
/** Medals for completing the Arc Generator easter egg. */
export const DF_EGG_MEDALS = 40
/** The most one match can pay. */
export const DF_MATCH_MEDAL_CAP = 400

const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/**
 * Medals one match pays one player. Rounds count only once the squad
 * completes them, so quitting at once pays nothing, and the per-round pay
 * grows with the round so a deep run out-earns restarting early ones.
 */
export function dfMedalsFromMatch(result: Pick<DfMatchResult, 'roundsSurvived' | 'kills' | 'completedEasterEgg'>): number {
    const rounds = Math.min(200, nonNeg(result.roundsSurvived))
    const kills = Math.min(5000, nonNeg(result.kills))
    let medals = 0
    for (let r = 1; r <= rounds; r++) medals += dfRoundMedals(r)
    if (rounds > 0) medals += Math.floor(kills / DF_KILLS_PER_MEDAL)
    if (result.completedEasterEgg) medals += DF_EGG_MEDALS
    return Math.min(DF_MATCH_MEDAL_CAP, medals)
}

/** Medals to research every perk fully. */
export function dfResearchTotal(perks: number): number {
    return perks * DF_RESEARCH_COSTS.reduce((sum, cost) => sum + cost, 0)
}
