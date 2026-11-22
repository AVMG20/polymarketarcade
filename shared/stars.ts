import { DF_PERK_MAX_LEVEL } from './dead-front/progression'

/**
 * Each arcade game's one star: a milestone about halfway through it. Progress
 * in these games never goes back, so neither does the star. Pure rules over
 * the saved state; server/utils/stars.ts reads the state and tells the hub.
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
