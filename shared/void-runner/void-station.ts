// ─── Void Runner: station services ──────────────────────────────────────────
//
// The recurring sinks that keep a maxed pilot coming back:
// - Supplies: consumables bought with tier-appropriate materials and loaded
//   into every run (keys 1-3); a launch spends what it loads. Their price follows your progress.
// - Station contracts: three deliveries a day that trade common materials
//   for alloy and pilot XP.
// Part Overclocks (the endless upgrade levels) live next to the parts in void.ts.

import { VOID_CONTRACT_ALLOY_SHARE, VOID_COST_MULT, voidPrice, voidQty } from './economy'
import { voidSectorResources, type VoidResourceBundle, type VoidResourceId } from './void'

// ─── Supplies ───────────────────────────────────────────────────────────────

export type VoidSupplyId = 'nanites' | 'cell' | 'emp'

export interface VoidSupplyDefinition {
    id: VoidSupplyId
    name: string
    key: string
    description: string
    icon: string
    color: number
    /** Price weight against the tier recipe. */
    weight: number
}

export const VOID_SUPPLIES: VoidSupplyDefinition[] = [
    { id: 'nanites', name: 'Repair Nanites', key: '1', description: 'Repairs 40% hull over 3 seconds.', icon: 'i-lucide-wrench', color: 0x7dff9a, weight: 1 },
    { id: 'cell', name: 'Shield Cell', key: '2', description: 'Instantly restores 60% shield.', icon: 'i-lucide-battery-charging', color: 0x6fd8ff, weight: 0.8 },
    { id: 'emp', name: 'EMP Charge', key: '3', description: 'Jams hostile weapons within 80m for 1.5 seconds. Elites shrug off half; wardens are immune.', icon: 'i-lucide-zap', color: 0xc49bff, weight: 1.4 }
]

export const VOID_SUPPLY_IDS: VoidSupplyId[] = VOID_SUPPLIES.map(s => s.id)

/** Most of each supply a ship carries into a run. */
export const VOID_SUPPLY_CARRY = 3
/** Most of each supply the station will stockpile for you. */
export const VOID_SUPPLY_STOCK_MAX = 30

const SUPPLY_RECIPES: VoidResourceBundle[] = [
    { ferrite: 25, scrap: 15 },
    { ferrite: 40, cobalt: 20, scrap: 20 },
    { cobalt: 50, iridium: 18, alloy: 5 },
    { iridium: 50, xenite: 14, alloy: 8 },
    { iridium: 70, xenite: 28, alloy: 14 }
]

/**
 * One supply's price. It is built from the deepest sector you can fly, so it
 * stays a real share of every haul instead of fading into pocket change.
 */
export function voidSupplyCost(id: VoidSupplyId, highestSectorCleared: number, discount = false) {
    const def = VOID_SUPPLIES.find(s => s.id === id) ?? VOID_SUPPLIES[0]!
    const tier = Math.max(1, Math.min(5, highestSectorCleared + 1))
    const recipe = SUPPLY_RECIPES[tier - 1]!
    return { resources: voidPrice(recipe, 'supply', def.weight * (discount ? 0.75 : 1)) }
}

export function voidNormalizeSupplies(raw: Record<string, unknown> | null | undefined, max = VOID_SUPPLY_STOCK_MAX) {
    const out = {} as Record<VoidSupplyId, number>
    for (const id of VOID_SUPPLY_IDS) out[id] = Math.max(0, Math.min(max, Math.floor(Number(raw?.[id]) || 0)))
    return out
}

// ─── Station contracts ──────────────────────────────────────────────────────

export const VOID_CONTRACTS_PER_DAY = 3

const CONTRACT_BASE: Record<VoidResourceId, number> = {
    ferrite: 600, scrap: 500, cobalt: 400, alloy: 60, iridium: 350, xenite: 150, core: 0
}

export interface VoidContract {
    index: number
    resource: VoidResourceId
    amount: number
    /** Alloy paid on delivery. */
    alloy: number
    xp: number
}

/** UTC day key; contracts roll over at midnight UTC. */
export function voidContractDay(now = new Date()) {
    return now.toISOString().slice(0, 10)
}

/** When today's contracts roll over, as an ISO timestamp. */
export function voidContractResetAt(now = new Date()) {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    return next.toISOString()
}

function hash(text: string) {
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return h >>> 0
}

/**
 * The day's contracts for a pilot. Picked by a stable hash of user and day so
 * they never reroll on refresh; there are only three a day.
 */
export function voidContractsFor(userId: string, day: string, highestSectorCleared: number): VoidContract[] {
    const tier = Math.max(1, Math.min(5, highestSectorCleared + 1))
    const pool = [...voidSectorResources(tier)].filter(id => id !== 'core')
    const out: VoidContract[] = []
    const used = new Set<VoidResourceId>()
    for (let i = 0; i < VOID_CONTRACTS_PER_DAY; i++) {
        const options = pool.filter(id => !used.has(id))
        const resource = (options.length ? options : pool)[hash(`${userId}:${day}:${i}`) % (options.length || pool.length)]!
        used.add(resource)
        const amount = voidQty(CONTRACT_BASE[resource] * (1 + highestSectorCleared * 0.8), VOID_COST_MULT.contract)
        out.push({
            index: i,
            resource,
            amount,
            alloy: resource === 'alloy' ? 0 : Math.max(1, Math.round(amount * VOID_CONTRACT_ALLOY_SHARE)),
            xp: 150 * tier
        })
    }
    return out
}
