/**
 * SHAPEZZ shard economy: what a run pays at each stage of progression and how
 * long the workshop takes to afford. `bun scripts/shapezz-economy.ts`
 *
 * A sim, not a test. Survival comes from the playtest bot driving the real
 * engine (`scripts/shapezz-playtest.ts`, 16 runs per cell, blaster and mortar):
 * for five builds and every difficulty, the share of runs that reached each
 * checkpoint and how much of the loot ceiling they collected. Offers and prices
 * come live from shared/shapezz/economy.ts, so retuning a constant there shows
 * up here at once. Re-measure the table after changing combat rules.
 *
 * A build between two measured ones blends their curves by power. Skill bends
 * them: a casual player survives as if the run were shorter and drops more
 * loot, a skilled one the other way. Every run picks the difficulty and the
 * cash-out checkpoint with the best expected shards per minute, deaths salvage
 * their share, and shards buy the next upgrade with the most power per shard.
 */
import {
    SHAPEZZ_CHECKPOINT_MS,
    SHAPEZZ_DIFFICULTY_IDS,
    SHAPEZZ_PERMANENT_UPGRADE_IDS,
    SHAPEZZ_PERMANENT_UPGRADES,
    SHAPEZZ_WEAPON_RARITIES,
    SHAPEZZ_WEAPON_TYPES,
    shapezzPower,
    shapezzWeapon,
    type ShapezzDifficultyId,
    type ShapezzPermanentLevels,
    type ShapezzPermanentUpgradeId,
    type ShapezzWeaponRarity
} from '../shared/shapezz/rules'
import {
    shapezzDefeatSalvage,
    shapezzLootCeiling,
    shapezzPermanentUpgradeCost,
    shapezzRunOffer,
    shapezzWeaponPrice,
    shapezzWeaponReplacement
} from '../shared/shapezz/economy'

// ─── Measured survival (playtest bot) ───────────────────────────────────────

interface Cell {
    /** Mean loot quality (sqrt of loot / ceiling) at the checkpoints reached. */
    quality: number
    /** Share of runs that reached checkpoint 1, 2, 3, … */
    reach: number[]
}

const BUILDS: { id: string, levels: ShapezzPermanentLevels, rarity: ShapezzWeaponRarity, cells: Record<ShapezzDifficultyId, Cell> }[] = [
    {
        id: 'fresh',
        levels: { core: 0, overclock: 0, armor: 0, thrusters: 0, magnet: 0, killHeal: 0 },
        rarity: 'common',
        cells: {
            spark: { quality: 0.56, reach: [1.0, 1.0, 0.62, 0.25, 0.12, 0.0] },
            surge: { quality: 0.57, reach: [1.0, 0.38, 0.06, 0.06, 0.0] },
            overdrive: { quality: 0.48, reach: [0.06, 0.0] },
            mayhem: { quality: 0.38, reach: [0.0] },
            annihilation: { quality: 0.25, reach: [0.0] }
        }
    },
    {
        id: 'low',
        levels: { core: 3, overclock: 3, armor: 3, thrusters: 2, magnet: 2, killHeal: 0 },
        rarity: 'rare',
        cells: {
            spark: { quality: 0.64, reach: [1.0, 1.0, 1.0, 0.88, 0.81, 0.62, 0.06, 0.0] },
            surge: { quality: 0.66, reach: [1.0, 1.0, 0.81, 0.75, 0.44, 0.06, 0.0] },
            overdrive: { quality: 0.65, reach: [1.0, 0.62, 0.06, 0.0] },
            mayhem: { quality: 0.6, reach: [0.81, 0.0] },
            annihilation: { quality: 0.59, reach: [0.0] }
        }
    },
    {
        id: 'mid',
        levels: { core: 7, overclock: 7, armor: 7, thrusters: 6, magnet: 6, killHeal: 1 },
        rarity: 'epic',
        cells: {
            spark: { quality: 0.72, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.5, 0.12, 0.0] },
            surge: { quality: 0.72, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 0.62, 0.19, 0.0] },
            overdrive: { quality: 0.76, reach: [1.0, 1.0, 1.0, 0.75, 0.31, 0.12, 0.0] },
            mayhem: { quality: 0.78, reach: [1.0, 0.94, 0.5, 0.25, 0.06, 0.0] },
            annihilation: { quality: 0.74, reach: [1.0, 0.06, 0.0] }
        }
    },
    {
        id: 'high',
        levels: { core: 13, overclock: 13, armor: 13, thrusters: 11, magnet: 11, killHeal: 2 },
        rarity: 'legendary',
        cells: {
            spark: { quality: 0.8, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.88, 0.44, 0.06, 0.0] },
            surge: { quality: 0.79, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.94, 0.56, 0.12, 0.0] },
            overdrive: { quality: 0.86, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 0.88, 0.38, 0.0] },
            mayhem: { quality: 0.88, reach: [1.0, 1.0, 0.94, 0.81, 0.56, 0.25, 0.0] },
            annihilation: { quality: 0.89, reach: [1.0, 1.0, 0.75, 0.31, 0.12, 0.0] }
        }
    },
    {
        id: 'max',
        levels: { core: 20, overclock: 20, armor: 20, thrusters: 20, magnet: 20, killHeal: 4 },
        rarity: 'mythic',
        cells: {
            spark: { quality: 0.86, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.75, 0.44, 0.06, 0.0] },
            surge: { quality: 0.85, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.94, 0.5, 0.12, 0.12, 0.06, 0.0] },
            overdrive: { quality: 0.91, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.94, 0.25, 0.06, 0.0] },
            mayhem: { quality: 0.94, reach: [1.0, 1.0, 1.0, 1.0, 1.0, 0.94, 0.69, 0.12, 0.06, 0.0] },
            annihilation: { quality: 0.93, reach: [1.0, 1.0, 1.0, 1.0, 0.81, 0.56, 0.31, 0.0] }
        }
    }
]

const powerOf = (levels: ShapezzPermanentLevels, rarity: ShapezzWeaponRarity) => shapezzPower(levels, shapezzWeapon('blaster', rarity))
const BUILD_POWER = BUILDS.map(build => powerOf(build.levels, build.rarity))

// ─── Skill ──────────────────────────────────────────────────────────────────

interface Skill {
    id: string
    /** Survival time relative to the bot. */
    survival: number
    /** Loot quality relative to the bot. */
    loot: number
    /** Minutes per run outside the arena: menus, the workshop, a breather. */
    overhead: number
}

const SKILLS: Skill[] = [
    { id: 'casual', survival: 0.7, loot: 0.85, overhead: 0.5 },
    { id: 'decent', survival: 1, loot: 1, overhead: 0.35 },
    { id: 'skilled', survival: 1.25, loot: 1.05, overhead: 0.3 }
]

/** Seconds spent on each checkpoint screen. */
const PICK_SECONDS = 8

/** Share of runs reaching checkpoint `k` (fractional k interpolates). */
function reachAt(reach: number[], k: number) {
    if (k <= 0) return 1
    const index = k - 1
    const lower = Math.floor(index)
    const at = (i: number) => (i < 0 ? 1 : reach[i] ?? 0)
    return at(lower) + (at(lower + 1) - at(lower)) * (index - lower)
}

/** The survival curve and loot quality of a build of this power, for this skill. */
function cellFor(power: number, difficulty: ShapezzDifficultyId, skill: Skill) {
    let upper = BUILD_POWER.findIndex(p => p >= power)
    if (upper < 0) upper = BUILDS.length - 1
    const lower = Math.max(0, upper - 1)
    const span = BUILD_POWER[upper]! - BUILD_POWER[lower]!
    const mix = span > 0 ? Math.min(1, Math.max(0, (power - BUILD_POWER[lower]!) / span)) : 1
    const a = BUILDS[lower]!.cells[difficulty]
    const b = BUILDS[upper]!.cells[difficulty]
    const reach = (k: number) => {
        const scaled = k / skill.survival
        return reachAt(a.reach, scaled) * (1 - mix) + reachAt(b.reach, scaled) * mix
    }
    const quality = Math.min(1, (a.quality * (1 - mix) + b.quality * mix) * skill.loot)
    return { reach, quality }
}

/** The offer after `rounds` checkpoints' worth of time at this loot quality. */
function offerAt(rounds: number, quality: number, difficulty: ShapezzDifficultyId) {
    const elapsedMs = rounds * SHAPEZZ_CHECKPOINT_MS
    return shapezzRunOffer(quality * quality * shapezzLootCeiling(elapsedMs, difficulty), elapsedMs, difficulty)
}

interface Plan {
    difficulty: ShapezzDifficultyId
    checkpoint: number
    shards: number
    minutes: number
}

/** The difficulty and cash-out checkpoint with the best expected shards per minute. */
function bestPlan(power: number, skill: Skill): Plan {
    let best: Plan | null = null
    for (const difficulty of SHAPEZZ_DIFFICULTY_IDS) {
        const { reach, quality } = cellFor(power, difficulty, skill)
        for (let checkpoint = 1; checkpoint <= 16; checkpoint++) {
            let shards = reach(checkpoint) * offerAt(checkpoint, quality, difficulty)
            let minutes = reach(checkpoint) * (checkpoint * (SHAPEZZ_CHECKPOINT_MS / 60_000 + PICK_SECONDS / 60))
            // Dying in segment j (between checkpoint j and j + 1) salvages a share of the offer then.
            for (let j = 0; j < checkpoint; j++) {
                const died = reach(j) - reach(j + 1)
                if (died <= 0) continue
                shards += died * shapezzDefeatSalvage(offerAt(j + 0.5, quality, difficulty))
                minutes += died * ((j + 0.5) * SHAPEZZ_CHECKPOINT_MS / 60_000 + j * PICK_SECONDS / 60)
            }
            minutes += skill.overhead
            if (!best || shards / minutes > best.shards / best.minutes) best = { difficulty, checkpoint, shards, minutes }
        }
    }
    return best!
}

// ─── Progression ────────────────────────────────────────────────────────────

interface Item {
    label: string
    track: string
    level: number
    cost: number
    gain: number
    buy: () => void
}

interface Purchase {
    label: string
    track: string
    level: number
    cost: number
    run: number
    minutes: number
}

/** Buy something affordable when it is at least this good (power per shard) as the best item. */
const SAVE_THRESHOLD = 0.6

const POWER_PER_LEVEL: Record<ShapezzPermanentUpgradeId, number> = { core: 5, overclock: 5, armor: 4, thrusters: 3, magnet: 2, killHeal: 8 }

function simulate(skill: Skill) {
    const levels: ShapezzPermanentLevels = { core: 0, overclock: 0, armor: 0, thrusters: 0, magnet: 0, killHeal: 0 }
    let rarityIndex = 0
    let paid = 0
    let shards = 0
    let minutes = 0
    let run = 0
    const purchases: Purchase[] = []
    const runLog: { run: number, minutes: number, plan: Plan, power: number }[] = []

    const nextItems = (): Item[] => {
        const items: Item[] = []
        for (const id of SHAPEZZ_PERMANENT_UPGRADE_IDS) {
            const cost = shapezzPermanentUpgradeCost(id, levels[id])
            if (cost === null) continue
            items.push({
                label: SHAPEZZ_PERMANENT_UPGRADES[id].name, track: id, level: levels[id] + 1, cost, gain: POWER_PER_LEVEL[id],
                buy: () => { levels[id]++ }
            })
        }
        const next = SHAPEZZ_WEAPON_RARITIES[rarityIndex + 1]
        if (next) {
            const { netCost } = shapezzWeaponReplacement(paid, shapezzWeaponPrice('blaster', next))
            items.push({
                label: `${next} carbine`, track: 'carbine', level: rarityIndex + 1, cost: netCost, gain: 18,
                buy: () => { rarityIndex++; paid = shapezzWeaponPrice('blaster', next) }
            })
        }
        return items
    }

    while (run < 20_000) {
        const items = nextItems()
        if (!items.length) break
        // Buy the best power per shard that is affordable, unless something far
        // better is worth saving for.
        items.sort((a, b) => b.gain / b.cost - a.gain / a.cost)
        const bestRatio = items[0]!.gain / items[0]!.cost
        const target = items.find(item => item.cost <= shards && item.gain / item.cost >= bestRatio * SAVE_THRESHOLD)
        if (target) {
            shards -= target.cost
            target.buy()
            purchases.push({ label: target.label, track: target.track, level: target.level, cost: target.cost, run, minutes })
            continue
        }
        const power = powerOf(levels, SHAPEZZ_WEAPON_RARITIES[rarityIndex]!)
        const plan = bestPlan(power, skill)
        run++
        minutes += plan.minutes
        shards += plan.shards
        runLog.push({ run, minutes, plan, power })
    }
    return { purchases, runLog, runs: run, minutes }
}

// ─── Report ─────────────────────────────────────────────────────────────────

const pad = (value: string | number, width: number) => String(value).padStart(width)
const padRight = (value: string | number, width: number) => String(value).padEnd(width)
const hours = (minutes: number) => minutes < 60 ? `${Math.round(minutes)}m` : `${(minutes / 60).toFixed(1)}h`

function heading(title: string) {
    console.log(`\n═══ ${title} ═══\n`)
}

heading('Best run by build (expected, bot survival)')
console.log(padRight('build', 8) + pad('power', 7) + SKILLS.map(skill => pad(skill.id, 34)).join(''))
console.log(padRight('', 15) + SKILLS.map(() => pad('difficulty cp  shards  min  /hour', 34)).join(''))
console.log('─'.repeat(15 + 34 * SKILLS.length))
for (const [index, build] of BUILDS.entries()) {
    const power = BUILD_POWER[index]!
    console.log(padRight(build.id, 8) + pad(power, 7) + SKILLS.map((skill) => {
        const plan = bestPlan(power, skill)
        return pad(`${plan.difficulty} ${pad(plan.checkpoint, 2)} ${pad(plan.shards.toFixed(0), 6)} ${pad(plan.minutes.toFixed(1), 4)} ${pad((plan.shards / plan.minutes * 60).toFixed(0), 5)}`, 34)
    }).join(''))
}

heading('Prices')
console.log(padRight('track', 20) + [1, 2, 3, 5, 8, 10, 12, 15, 18, 20].map(level => pad(`L${level}`, 7)).join('') + pad('total', 9))
console.log('─'.repeat(99))
for (const id of SHAPEZZ_PERMANENT_UPGRADE_IDS) {
    const max = SHAPEZZ_PERMANENT_UPGRADES[id].maxLevel
    let total = 0
    for (let level = 0; level < max; level++) total += shapezzPermanentUpgradeCost(id, level) ?? 0
    console.log(padRight(SHAPEZZ_PERMANENT_UPGRADES[id].name, 20)
        + [1, 2, 3, 5, 8, 10, 12, 15, 18, 20].map(level => pad(level <= max ? shapezzPermanentUpgradeCost(id, level - 1) ?? '' : '', 7)).join('')
        + pad(total, 9))
}
let weaponsTotal = 0
for (const type of SHAPEZZ_WEAPON_TYPES) {
    const prices = SHAPEZZ_WEAPON_RARITIES.map(rarity => shapezzWeaponPrice(type, rarity))
    let line = 0
    for (let i = 0; i < prices.length; i++) line += shapezzWeaponReplacement(i ? prices[i - 1]! : 0, prices[i]!).netCost
    weaponsTotal += line
    console.log(padRight(shapezzWeapon(type, 'common').name.replace('Common ', ''), 20) + prices.map(price => pad(price, 7)).join('') + pad('', 35) + pad(line, 9))
}

const chassisTotal = SHAPEZZ_PERMANENT_UPGRADE_IDS.reduce((sum, id) => {
    let total = 0
    for (let level = 0; level < SHAPEZZ_PERMANENT_UPGRADES[id].maxLevel; level++) total += shapezzPermanentUpgradeCost(id, level) ?? 0
    return sum + total
}, 0)
console.log(`\nchassis ${chassisTotal}, every weapon line to mythic ${weaponsTotal}`)

const MILESTONES: { label: string, match: (purchase: Purchase) => boolean }[] = [
    { label: 'first upgrade', match: () => true },
    ...SHAPEZZ_PERMANENT_UPGRADE_IDS.flatMap(id => (id === 'killHeal' ? [1, 2, 3, 4] : [1, 5, 10, 15, 20]).map(level => ({
        label: `${SHAPEZZ_PERMANENT_UPGRADES[id].name} L${level}`,
        match: (purchase: Purchase) => purchase.track === id && purchase.level === level
    }))),
    ...SHAPEZZ_WEAPON_RARITIES.slice(1).map((rarity, index) => ({
        label: `${rarity} carbine`,
        match: (purchase: Purchase) => purchase.track === 'carbine' && purchase.level === index + 1
    }))
]

const sims = SKILLS.map(skill => ({ skill, ...simulate(skill) }))

heading('When each tier is bought (runs / play time)')
console.log(padRight('milestone', 24) + pad('price', 7) + sims.map(sim => pad(sim.skill.id, 18)).join(''))
console.log('─'.repeat(31 + 18 * sims.length))
for (const milestone of MILESTONES) {
    const first = sims[0]!.purchases.find(milestone.match)
    console.log(padRight(milestone.label, 24) + pad(first?.cost ?? '', 7) + sims.map((sim) => {
        const purchase = sim.purchases.find(milestone.match)
        return pad(purchase ? `${purchase.run} / ${hours(purchase.minutes)}` : '-', 18)
    }).join(''))
}
console.log(padRight('workshop maxed', 31) + sims.map(sim => pad(`${sim.runs} / ${hours(sim.minutes)}`, 18)).join(''))

heading('Runs between purchases (median / 90th percentile), by stage of the workshop')
const STAGES = [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]] as const
console.log(padRight('spent', 12) + sims.map(sim => pad(sim.skill.id, 18)).join(''))
for (const [from, to] of STAGES) {
    console.log(padRight(`${from * 100}-${to * 100}%`, 12) + sims.map((sim) => {
        const total = sim.purchases.reduce((sum, purchase) => sum + purchase.cost, 0)
        let spent = 0
        const gaps: number[] = []
        let previousRun = 0
        for (const purchase of sim.purchases) {
            spent += purchase.cost
            const share = spent / total
            if (share > from && share <= to) gaps.push(purchase.run - previousRun)
            previousRun = purchase.run
        }
        const sorted = gaps.filter(gap => gap > 0).sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0
        const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0
        return pad(`${median} / ${p90}`, 18)
    }).join(''))
}

heading('Income over a playthrough (decent)')
{
    const sim = sims[1]!
    console.log(padRight('run', 8) + pad('time', 8) + pad('power', 7) + padRight('  plan', 22) + pad('shards', 8))
    for (const entry of sim.runLog.filter((_, index) => [1, 2, 3, 5, 10, 20, 40, 80, 150, 250, 400].includes(index + 1) || index === sim.runLog.length - 1)) {
        console.log(padRight(entry.run, 8) + pad(hours(entry.minutes), 8) + pad(entry.power, 7)
            + padRight(`  ${entry.plan.difficulty} cp${entry.plan.checkpoint}`, 22) + pad(entry.plan.shards.toFixed(0), 8))
    }
    const best = bestPlan(BUILD_POWER.at(-1)!, SKILLS[1]!)
    console.log(`\nevery other weapon line to mythic after that: ~${Math.ceil((weaponsTotal - SHAPEZZ_WEAPON_RARITIES.slice(1).reduce((sum, rarity, i) => sum + shapezzWeaponReplacement(i ? shapezzWeaponPrice('blaster', SHAPEZZ_WEAPON_RARITIES[i]!) : 0, shapezzWeaponPrice('blaster', rarity)).netCost, 0)) / best.shards)} more maxed runs`)
}
