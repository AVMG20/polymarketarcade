import { DF_PERK_MAX_LEVEL } from './dead-front/progression'

/**
 * Each arcade game's star levels: one milestone about halfway through for the
 * action games, five for Polytown. Progress in these games never goes back,
 * so neither do the stars. Pure rules over the saved state;
 * server/utils/stars.ts reads the state and tells the hub.
 */

export const DF_STAR_PERKS = 3
export const SHAPEZZ_STAR_CHECKPOINT = 10
export const PIRATE_STAR_DIFFICULTY = 500
export const VOID_STAR_SECTOR = 2

export function deadFrontStars(perkLevels: Partial<Record<string, number>>): number {
    return Object.values(perkLevels).filter(level => (level ?? 0) >= DF_PERK_MAX_LEVEL).length >= DF_STAR_PERKS ? 1 : 0
}

export function shapezzStars(bestCheckpoint: number): number {
    return bestCheckpoint >= SHAPEZZ_STAR_CHECKPOINT ? 1 : 0
}

export function pirateStars(highestCompletedDifficulty: number): number {
    return highestCompletedDifficulty >= PIRATE_STAR_DIFFICULTY ? 1 : 0
}

export function voidStars(highestSectorCleared: number): number {
    return highestSectorCleared >= VOID_STAR_SECTOR ? 1 : 0
}

/** Polytown: a level per this many monument stages built, across all five monuments. */
export const POLYTOWN_STAGES_PER_STAR = 8
export const POLYTOWN_MAX_STARS = 5

export function polytownStars(monumentStages: number): number {
    return Math.max(0, Math.min(POLYTOWN_MAX_STARS, Math.floor(monumentStages / POLYTOWN_STAGES_PER_STAR)))
}

/** Gridworks: claiming the Motors goal (tier 3, halfway through the five tiers). */
export const GRIDWORKS_STAR_GOAL = 'motors'

export function gridworksStars(goals: readonly string[]): number {
    return goals.includes(GRIDWORKS_STAR_GOAL) ? 1 : 0
}
