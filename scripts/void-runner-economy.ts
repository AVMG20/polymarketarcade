// Void Runner economy sim: how many runs (and hours) each purchase takes for
// three kinds of pilot, using the real price functions from shared/void-runner.
// A model, not a measurement: tune VOID_COST_MULT and friends in
// shared/void-runner/economy.ts until the table reads right.
//
//   bun scripts/void-runner-economy.ts

import { VOID_COST_MULT, VOID_HAUL_RATE_CAP } from '../shared/void-runner/economy'
import {
    VOID_MAX_SHIP_TIER, VOID_RESOURCE_IDS, VOID_SECTORS, VOID_SHIPS, VOID_UPGRADES, voidRefitCost, voidShip, voidUpgradeCost,
    type VoidResourceBundle, type VoidResourceId
} from '../shared/void-runner/void'
import { VOID_ITEM_MAX_LEVEL, voidCraftCost, voidItemUpgradeCost, type VoidItemKind } from '../shared/void-runner/void-items'
import { VOID_SKILLS, voidSkillCost } from '../shared/void-runner/void-skills'
import { voidSupplyCost } from '../shared/void-runner/void-station'

interface Pilot {
    name: string
    /** Minutes per run, launch to dock. */
    minutes: number
    /** Share of runs that make it home with the hold. */
    extraction: number
    /** Units a minute in sector 1 with a stock mining rig: ore, scrap and alloy together. */
    rate: number
    /** Chance a run in a sector the pilot is geared for brings a warden kill home. */
    warden: number
}

const PILOTS: Pilot[] = [
    { name: 'casual', minutes: 6, extraction: 0.7, rate: 10, warden: 0.15 },
    { name: 'regular', minutes: 8, extraction: 0.85, rate: 15, warden: 0.35 },
    { name: 'skilled', minutes: 10, extraction: 0.95, rate: 22, warden: 0.6 }
]

/** Share of a haul that is salvage, and alloy's share of that salvage. */
const SALVAGE_SHARE = 0.3
const ALLOY_SHARE = 0.15

/**
 * What a pilot has at a stage of the game (stage = highest sector cleared):
 * the hold of a typical hull for that stage and the mining rig level.
 */
function stageKit(stage: number) {
    const hull = ['mule', 'kestrel', 'aegis', 'seraph', 'bastion', 'leviathan'][stage]!
    return { hold: voidShip(hull).cargo * 1.3, mining: Math.min(8, Math.round(stage * 1.6)) }
}

/** Expected banked materials from one run in `tier` at `stage`. */
function runYield(p: Pilot, tier: number, stage: number): VoidResourceBundle {
    const kit = stageKit(stage)
    const sector = VOID_SECTORS[tier - 1]!
    const rate = p.rate * (1 + kit.mining * 0.1) * (1 + (tier - 1) * 0.12)
    const units = Math.min(kit.hold, rate * p.minutes, VOID_HAUL_RATE_CAP * p.minutes) * p.extraction
    const ores = Object.entries(sector.ores) as [VoidResourceId, number][]
    const oreWeight = ores.reduce((s, [, w]) => s + w, 0)
    const out: VoidResourceBundle = {}
    for (const [id, w] of ores) out[id] = units * (1 - SALVAGE_SHARE) * (w / oreWeight)
    out.scrap = units * SALVAGE_SHARE * (1 - ALLOY_SHARE)
    out.alloy = units * SALVAGE_SHARE * ALLOY_SHARE
    // Wardens only fall to a pilot geared for the sector they fly.
    const geared = tier <= stage + 1
    out.core = (geared ? p.warden * (1 + Math.ceil(tier / 2)) : 0) + 0.15 * tier
    return out
}

/** Runs to afford `cost` at `stage`, farming whichever open sector gets there fastest. */
function runsFor(p: Pilot, cost: VoidResourceBundle, stage: number) {
    let best = Infinity
    for (let tier = 1; tier <= Math.min(VOID_SECTORS.length, stage + 1); tier++) {
        const y = runYield(p, tier, stage)
        let runs = 0
        for (const id of VOID_RESOURCE_IDS) {
            const need = cost[id] ?? 0
            if (need <= 0) continue
            const per = y[id] ?? 0
            runs = Math.max(runs, per > 0 ? need / per : Infinity)
        }
        best = Math.min(best, runs)
    }
    return best
}

const fmt = (runs: number) => (runs === Infinity ? '  never' : runs < 10 ? runs.toFixed(1).padStart(7) : String(Math.round(runs)).padStart(7))
const bundle = (b: VoidResourceBundle) => Object.entries(b).filter(([, n]) => n).map(([id, n]) => `${n} ${id}`).join(', ')
const hours = (p: Pilot, runs: number) => runs * p.minutes / 60

interface Purchase { group: string, label: string, cost: VoidResourceBundle, stage: number }

const purchases: Purchase[] = []

// Station systems: early levels at stage 0, the cobalt band from sector 1, the deep band from sector 3.
for (const u of VOID_UPGRADES) {
    for (let level = 0; level < u.maxLevel; level++) {
        purchases.push({ group: 'systems', label: `${u.name} Mk ${level + 1}`, cost: voidUpgradeCost(u.id, level)!.resources, stage: level < 3 ? 0 : level < 6 ? 2 : 4 })
    }
}
for (const ship of VOID_SHIPS) {
    if (ship.id === 'sparrow') continue
    purchases.push({ group: 'hulls', label: ship.name, cost: ship.cost, stage: ship.requiresSector })
}
for (let tier = 2; tier <= VOID_MAX_SHIP_TIER; tier++) {
    purchases.push({ group: 'refits', label: `Refit to T${tier}`, cost: voidRefitCost(tier)!.resources, stage: Math.min(5, tier - 1) })
}
const KINDS: VoidItemKind[] = ['gun', 'turret', 'armor', 'shield', 'secondary', 'device']
for (let tier = 1; tier <= 5; tier++) {
    purchases.push({ group: 'gear', label: `Craft T${tier} gun`, cost: voidCraftCost('gun', tier).resources, stage: tier - 1 })
    for (const level of [0, 4, 9]) {
        purchases.push({ group: 'gear', label: `  T${tier} gun +${level + 1}`, cost: voidItemUpgradeCost({ kind: 'gun', tier, level })!.resources, stage: tier - 1 })
    }
}
for (const skill of VOID_SKILLS.slice(1)) {
    purchases.push({ group: 'skills', label: skill.name, cost: voidSkillCost(skill), stage: skill.requiresSector })
}
for (let stage = 0; stage < 5; stage++) {
    purchases.push({ group: 'supplies', label: `Repair Nanites (sector ${stage + 1} price)`, cost: voidSupplyCost('nanites', stage).resources, stage })
}

console.log(`Void Runner economy · cost multipliers ${JSON.stringify(VOID_COST_MULT)}\n`)
console.log(`Run yield (units banked per run, typical kit for the stage):`)
for (const p of PILOTS) {
    const line = [0, 2, 4].map((stage) => {
        const y = runYield(p, stage + 1, stage)
        const total = Object.entries(y).reduce((s, [id, n]) => s + (id === 'core' ? 0 : n ?? 0), 0)
        return `sector ${stage + 1}: ${Math.round(total)}`
    }).join(' · ')
    console.log(`  ${p.name.padEnd(8)} ${p.minutes} min runs · ${line}`)
}

let group = ''
console.log(`\nRuns to afford (from zero, farming the best open sector at that stage):`)
console.log(`${''.padEnd(34)}${PILOTS.map(p => p.name.padStart(8)).join('')}  price`)
for (const item of purchases) {
    if (item.group !== group) {
        group = item.group
        console.log(`\n${group}`)
    }
    console.log(`  ${item.label.padEnd(32)}${PILOTS.map(p => ` ${fmt(runsFor(p, item.cost, item.stage))}`).join('')}  ${bundle(item.cost)}`)
}

// Full max-out: every system, every hull, every refit, every skill, and the
// flagship's 17 slots in T5 gear at +10.
const flagship = voidShip('sovereign')
const slots: VoidItemKind[] = ['gun', 'secondary', 'device', ...Array<VoidItemKind>(flagship.turrets).fill('turret'), ...Array<VoidItemKind>(flagship.armor).fill('armor'), ...Array<VoidItemKind>(flagship.shields).fill('shield')]
console.log('\nFull max-out (all systems, hulls, refits and skills, the flagship in T5 +10 gear):')
for (const p of PILOTS) {
    const parts: Record<string, number> = { systems: 0, hulls: 0, refits: 0, skills: 0, 'flagship gear': 0 }
    for (const item of purchases) {
        if (item.group === 'systems' || item.group === 'hulls' || item.group === 'skills') parts[item.group]! += runsFor(p, item.cost, item.stage)
    }
    // Every hull refitted to T6 from its native tier.
    for (const ship of VOID_SHIPS) {
        for (let tier = ship.requiresSector + 2; tier <= VOID_MAX_SHIP_TIER; tier++) parts.refits! += runsFor(p, voidRefitCost(tier)!.resources, Math.min(5, tier - 1))
    }
    for (const kind of slots) {
        parts['flagship gear']! += runsFor(p, voidCraftCost(kind, 5).resources, 5)
        for (let level = 0; level < VOID_ITEM_MAX_LEVEL; level++) parts['flagship gear']! += runsFor(p, voidItemUpgradeCost({ kind, tier: 5, level })!.resources, 5)
    }
    const runs = Object.values(parts).reduce((a, b) => a + b, 0)
    const split = Object.entries(parts).map(([k, v]) => `${k} ${Math.round(hours(p, v))}h`).join(', ')
    console.log(`  ${p.name.padEnd(8)} ${Math.round(runs)} runs · ${Math.round(hours(p, runs))} hours (${split})`)
}

// The first steps: what a new pilot can buy after their first runs.
console.log('\nFirst session (regular pilot, sector 1, Sparrow hold):')
{
    const p = PILOTS[1]!
    const y = runYield(p, 1, 0)
    const sparrow = Math.min(voidShip('sparrow').cargo, p.rate * p.minutes) * p.extraction
    console.log(`  a Sparrow run banks ~${Math.round(sparrow)} units (${bundle(Object.fromEntries(Object.entries(y).map(([k, v]) => [k, Math.round((v ?? 0) * sparrow / Math.max(1, Object.values(y).reduce((s, n) => s + (n ?? 0), 0)))])))})`)
}
