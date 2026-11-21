// The Pirate Raid API shapes, shared by the server handlers and the pages.

import type { PirateAbilityId, PirateShipStatId } from './rules'

export type PirateVoyageReason = 'timeout' | 'defeat' | 'cancelled'

export interface PirateShipStatsView {
    maxHp: number
    speed: number
    defenseRating: number
    ammoCapacity: number
    regenRate: number
}

export interface PirateCannonView {
    slotIndex: number
    tierId: string
    name: string
    attackRating: number
    maxDamage: number
    reloadMs: number
    range: number
    shotColor: number
    shotTrail: boolean
    purchasePrice: number
    tradeIn: number
}

export interface PirateDifficultyOption {
    difficulty: number
    /** Survival pay plus completion bonus for a full clear, with the marque. */
    voyagePay: number
    completionBonus: number
    /** One-off bounty for the first clear, 0 once cleared. */
    firstClearBounty: number
    completed: boolean
}

export interface PirateAbilityView {
    id: PirateAbilityId
    name: string
    description: string
    cost: number
    owned: boolean
    equipped: boolean
    level: number
    maxLevel: number
    upgradeCost: number | null
    currentCooldownMs: number
    bestCooldownMs: number
}

export interface PirateSkinView {
    id: string
    name: string
    description: string
    cost: number
    owned: boolean
    equipped: boolean
}

export interface PirateStateResponse {
    doubloons: number
    totalEarned: number
    levels: Record<PirateShipStatId, number>
    maxLevels: Record<PirateShipStatId, number>
    costs: Record<PirateShipStatId, number | null>
    power: number
    stats: PirateShipStatsView
    cannons: PirateCannonView[]
    cannonSlots: number
    maxCannonSlots: number
    nextSlotCost: number | null
    ammo: { capacity: number }
    runsPlayed: number
    bestSurvivalMs: number
    highestCompletedDifficulty: number
    recommendedDifficulty: number
    difficultyOptions: PirateDifficultyOption[]
    skins: PirateSkinView[]
    equippedSkinId: string
    abilities: PirateAbilityView[]
    equippedAbilityId: PirateAbilityId
    equippedAbilityLevel: number
    marque: { level: number, maxLevel: number, multiplier: number, nextMultiplier: number | null, cost: number | null }
    runDurationMs: number
    activeRun: { startedAt: number } | null
}

export interface PirateRuntimeCannon {
    slotIndex: number
    tierId: string
    attackRating: number
    maxDamage: number
    reloadMs: number
    range: number
    shotColor: number
    shotTrail: boolean
}

export interface PirateStartRunResponse {
    runId: string
    power: number
    difficulty: number
    skinId: string
    abilityId: PirateAbilityId
    abilityLevel: number
    payMultiplier: number
    runDurationMs: number
    stats: Omit<PirateShipStatsView, 'ammoCapacity'>
    ammo: number
    cannons: PirateRuntimeCannon[]
}

export interface PirateFinishRunResponse {
    awarded: number
    survivalPay: number
    completionBonus: number
    firstClearBounty: number
    elapsedMs: number
    survived: boolean
    completed: boolean
    difficulty: number
    doubloons: number
}

export interface PirateLogEntry {
    id: string
    loot: number
    durationMs: number
    power: number
    difficulty: number
    survived: boolean
    completed: boolean
    reason: PirateVoyageReason
    kills: number
    shotsFired: number
    skin: { id: string, name: string }
    createdAt: number
}

export interface PirateLegend {
    rank: number
    isCurrentPlayer: boolean
    name: string
    image: string | null
    difficulty: number
    power: number
    loot: number
    skin: { id: string, name: string }
}
