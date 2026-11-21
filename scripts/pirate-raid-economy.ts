/**
 * Pirate Raid economy sim: how many voyages each purchase takes, for three
 * captains, using the real PirateSim driven by the bot (scripts/lib/pirate-raid-bot.ts).
 *
 *   bun scripts/pirate-raid-economy.ts                 full report (simulates what is not cached yet)
 *   bun scripts/pirate-raid-economy.ts --seeds 6       more voyages per calibration cell (default 4)
 *   bun scripts/pirate-raid-economy.ts --fresh         ignore the cache
 *   bun scripts/pirate-raid-economy.ts --jobs 6        worker processes (default cores - 1)
 *
 * How it works:
 * 1. The ship's progression is a ladder: the cheapest next combat purchase
 *    first (stat levels, gun ports, the next cannon tier for the weakest port,
 *    powder keg levels), priced from shared/pirate-raid/economy.ts.
 * 2. Calibration: at checkpoints along that ladder the bot sails real voyages
 *    across the difficulty selector, once per skill. A skill is a damage-taken
 *    handicap on the bot plus a slower reaction: a careful captain (the bot),
 *    an average one and a novice.
 * 3. Progression: each captain starts with nothing, picks the difficulty that
 *    pays best for the ship they have, banks the expected pay, buys whatever
 *    the ladder offers next, and signs Letters of Marque when they pay back
 *    within a dozen voyages. Once the combat ladder is done they buy the
 *    other abilities, the marque and the skins.
 * The calibration is cached by build, difficulty, skill and seed in the OS
 * temp dir, so retuning pay only re-runs the cheap part.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    PIRATE_ABILITIES, PIRATE_ABILITY_MAX_LEVEL, PIRATE_CANNON_TIERS, PIRATE_DIFFICULTY_STEP,
    PIRATE_MAX_DIFFICULTY, PIRATE_RUN_DURATION_MS, PIRATE_SHIP_SKINS, PIRATE_SHIP_STAT_IDS, pirateMaxSelectableDifficulty,
    type PirateShipStatId
} from '../shared/pirate-raid/rules'
import {
    PIRATE_MARQUE_MAX_LEVEL, PIRATE_MARQUE_STEP, pirateAbilityCost, pirateAbilityUpgradeCost, pirateCannonCost,
    pirateCannonTradeIn, pirateFullTreeCost, pirateMarqueMultiplier, pirateMarqueUpgradeCost, pirateSkinCost,
    pirateSlotUnlockCost, pirateStatUpgradeCost, pirateVoyagePay
} from '../shared/pirate-raid/economy'
import { buildStats, sailVoyage, type PirateBuild } from './lib/pirate-raid-bot'

// ─── Flags ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string) => {
    const index = argv.indexOf(`--${name}`)
    return index < 0 ? undefined : (argv[index + 1] && !argv[index + 1]!.startsWith('--') ? argv[index + 1] : 'true')
}
const SEEDS = Number(flag('seeds') ?? 4)
/** Time in harbour between voyages: reading the debrief, the armory, setting sail. */
const HARBOUR_SECONDS = 45

// ─── Skills ─────────────────────────────────────────────────────────────────

interface Skill {
    id: 'careful' | 'average' | 'novice'
    damageTaken: number
    reactionMs: number
}

const SKILLS: Skill[] = [
    { id: 'careful', damageTaken: 1, reactionMs: 100 },
    { id: 'average', damageTaken: 1.3, reactionMs: 250 },
    { id: 'novice', damageTaken: 1.7, reactionMs: 500 }
]

// ─── The combat ladder ──────────────────────────────────────────────────────

interface Step {
    label: string
    group: string
    cost: number
    apply: (build: PirateBuild) => void
}

function starterBuild(): PirateBuild {
    return {
        levels: Object.fromEntries(PIRATE_SHIP_STAT_IDS.map(id => [id, 1])) as Record<PirateShipStatId, number>,
        cannons: ['swivel'],
        slots: 1,
        abilityId: 'bomb',
        abilityLevel: 1
    }
}

function cloneBuild(build: PirateBuild): PirateBuild {
    return { ...build, levels: { ...build.levels }, cannons: [...build.cannons] }
}

const STAT_LABEL: Record<PirateShipStatId, string> = { hull: 'Hull', speed: 'Speed', defense: 'Armour', ammoCapacity: 'Powder hold', regen: 'Repairs' }

/** Cheapest-first through every purchase that changes how the ship fights. */
function combatLadder(): Step[] {
    const build = starterBuild()
    let paid: number[] = [0]
    const steps: Step[] = []
    for (;;) {
        const offers: Step[] = []
        for (const id of PIRATE_SHIP_STAT_IDS) {
            const cost = pirateStatUpgradeCost(id, build.levels[id])
            const level = build.levels[id] + 1
            if (cost !== null) offers.push({ label: `${STAT_LABEL[id]} ${level}`, group: 'stats', cost, apply: b => { b.levels[id] = level } })
        }
        const slotCost = pirateSlotUnlockCost(build.slots)
        if (slotCost !== null) {
            const port = build.slots + 1
            offers.push({ label: `Gun port ${port}`, group: 'ports', cost: slotCost, apply: (b) => { b.slots = port; b.cannons.push('swivel') } })
        }
        // Refit the weakest port to the next tier, trading its gun in.
        let weakest = -1
        for (let port = 0; port < build.cannons.length; port++) {
            const rank = PIRATE_CANNON_TIERS.findIndex(t => t.id === build.cannons[port])
            if (rank < PIRATE_CANNON_TIERS.length - 1 && (weakest < 0 || rank < PIRATE_CANNON_TIERS.findIndex(t => t.id === build.cannons[weakest]))) weakest = port
        }
        if (weakest >= 0) {
            const next = PIRATE_CANNON_TIERS[PIRATE_CANNON_TIERS.findIndex(t => t.id === build.cannons[weakest]) + 1]!
            const port = weakest
            offers.push({
                label: `${next.name} (port ${port + 1})`,
                group: 'cannons',
                // Refitting trades the old gun in for part of what it cost.
                cost: pirateCannonCost(next.id) - pirateCannonTradeIn(paid[port] ?? 0),
                apply: (b) => { b.cannons[port] = next.id }
            })
        }
        const keg = pirateAbilityUpgradeCost(build.abilityLevel)
        if (keg !== null) {
            const level = build.abilityLevel + 1
            offers.push({ label: `Powder keg ${level}`, group: 'ability', cost: keg, apply: b => { b.abilityLevel = level } })
        }
        if (!offers.length) break
        const best = offers.reduce((a, b) => (b.cost < a.cost ? b : a))
        best.apply(build)
        // What each port's gun cost, for the next trade-in.
        paid = build.cannons.map(id => pirateCannonCost(id))
        steps.push(best)
    }
    return steps
}

const LADDER = combatLadder()
const LADDER_TOTAL = LADDER.reduce((sum, step) => sum + step.cost, 0)

function buildAt(position: number): PirateBuild {
    const build = starterBuild()
    for (let i = 0; i < position; i++) LADDER[i]!.apply(build)
    return build
}

/** Ladder positions where the bot calibrates: spaced by share of the ladder's cost. */
function checkpoints(): number[] {
    const shares = [0, 0.003, 0.008, 0.015, 0.03, 0.05, 0.08, 0.12, 0.17, 0.24, 0.32, 0.42, 0.53, 0.65, 0.78, 0.9, 1]
    const positions = new Set<number>()
    for (const share of shares) {
        let spent = 0
        let position = 0
        while (position < LADDER.length && spent + LADDER[position]!.cost <= share * LADDER_TOTAL) spent += LADDER[position++]!.cost
        positions.add(position)
    }
    return [...positions].sort((a, b) => a - b)
}

// ─── Calibration (real voyages) ─────────────────────────────────────────────

interface Job {
    key: string
    build: PirateBuild
    difficulty: number
    skill: Skill
    seed: number
}

interface Outcome {
    elapsedMs: number
    completed: boolean
}

const CACHE_PATH = join(tmpdir(), 'pirate-raid-economy-cache.json')
const cache: Record<string, Outcome> = !flag('fresh') && existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}

function signature(build: PirateBuild) {
    return `${PIRATE_SHIP_STAT_IDS.map(id => build.levels[id]).join('.')}|${build.cannons.join(',')}|${build.abilityId}${build.abilityLevel}`
}

const DIFFICULTIES = Array.from({ length: PIRATE_MAX_DIFFICULTY / 100 + 1 }, (_, i) => i * 100)

function calibrationJobs(): Job[] {
    const jobs: Job[] = []
    for (const position of checkpoints()) {
        const build = buildAt(position)
        const { power } = buildStats(build)
        for (const difficulty of DIFFICULTIES) {
            // A sea far above the ship sinks it in a minute; far below is a stroll.
            if (difficulty > power + 350 && difficulty > 0) continue
            if (difficulty < power - 700) continue
            for (const skill of SKILLS) {
                for (let seed = 1; seed <= SEEDS; seed++) {
                    const key = `${signature(build)}|${difficulty}|${skill.id}|${seed}`
                    jobs.push({ key, build, difficulty, skill, seed: seed * 7919 + difficulty })
                }
            }
        }
    }
    return jobs
}

function runJob(job: Job): Outcome {
    const result = sailVoyage(job.build, job.difficulty, { seed: job.seed, reactionMs: job.skill.reactionMs, damageTaken: job.skill.damageTaken })
    return { elapsedMs: result.elapsedMs, completed: result.reason === 'timeout' }
}

async function worker() {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of Bun.stdin.stream()) {
        buffer += decoder.decode(chunk)
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')
            if (line === 'exit') process.exit(0)
            const job = JSON.parse(line) as Job
            process.stdout.write(`${JSON.stringify({ key: job.key, outcome: runJob(job) })}\n`)
        }
    }
}

async function calibrate() {
    const pending = calibrationJobs().filter(job => !cache[job.key])
    if (!pending.length) return
    const workers = Math.max(1, Math.min(pending.length, Number(flag('jobs') ?? Math.max(1, navigator.hardwareConcurrency - 1))))
    const started = performance.now()
    let done = 0
    const script = new URL(import.meta.url).pathname
    await Promise.all(Array.from({ length: workers }, async () => {
        const child = Bun.spawn([process.execPath, script, '--worker'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
        const sendNext = () => {
            const next = pending.shift()
            child.stdin.write(next ? `${JSON.stringify(next)}\n` : 'exit\n')
            child.stdin.flush()
            return !!next
        }
        if (!sendNext()) return
        const decoder = new TextDecoder()
        let buffer = ''
        for await (const chunk of child.stdout) {
            buffer += decoder.decode(chunk)
            let newline = buffer.indexOf('\n')
            while (newline >= 0) {
                const { key, outcome } = JSON.parse(buffer.slice(0, newline)) as { key: string, outcome: Outcome }
                buffer = buffer.slice(newline + 1)
                newline = buffer.indexOf('\n')
                cache[key] = outcome
                done++
                if (process.stderr.isTTY) process.stderr.write(`\rcalibrating: ${done} voyages, ${((performance.now() - started) / 1000).toFixed(0)}s`)
                if (!sendNext()) child.stdin.end()
            }
        }
        await child.exited
    }))
    if (process.stderr.isTTY) process.stderr.write('\n')
    writeFileSync(CACHE_PATH, JSON.stringify(cache))
    console.log(`calibrated ${done} voyages in ${((performance.now() - started) / 1000).toFixed(0)}s (cache: ${CACHE_PATH})\n`)
}

// ─── Progression ────────────────────────────────────────────────────────────

interface Expectation {
    difficulty: number
    pay: number
    seconds: number
    clearRate: number
}

/** What a voyage at `difficulty` is worth to this captain at this checkpoint. */
function expectation(position: number, difficulty: number, skill: Skill, marque: number, highestCleared: number): Expectation | null {
    const build = buildAt(position)
    const outcomes: Outcome[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
        const hit = cache[`${signature(build)}|${difficulty}|${skill.id}|${seed}`]
        if (hit) outcomes.push(hit)
    }
    if (!outcomes.length) return null
    const clearRate = outcomes.filter(o => o.completed).length / outcomes.length
    let pay = 0
    let seconds = 0
    for (const o of outcomes) {
        // The first-clear bounty is real money once; count it at the clear rate.
        const voyage = pirateVoyagePay(o.elapsedMs, difficulty, o.completed, marque, highestCleared)
        pay += voyage.total
        seconds += o.elapsedMs / 1000 + HARBOUR_SECONDS
    }
    return { difficulty, pay: pay / outcomes.length, seconds: seconds / outcomes.length, clearRate }
}

interface Purchase {
    label: string
    group: string
    cost: number
    run: number
    hours: number
}

interface Career {
    skill: Skill
    purchases: Purchase[]
    runs: number
    hours: number
    payByRun: { run: number, pay: number, difficulty: number }[]
}

const MAX_RUNS = 5_000

function career(skill: Skill): Career {
    const points = checkpoints()
    let doubloons = 0
    let position = 0
    let marque = 0
    let highestCleared = -1
    let runs = 0
    let seconds = 0
    const purchases: Purchase[] = []
    const payByRun: Career['payByRun'] = []
    const extras: { label: string, group: string, cost: () => number | null, buy: () => void }[] = []
    for (const ability of PIRATE_ABILITIES.filter(a => pirateAbilityCost(a.id) > 0)) {
        extras.push({ label: ability.name, group: 'abilities', cost: () => pirateAbilityCost(ability.id), buy: () => {} })
        for (let level = 1; level < PIRATE_ABILITY_MAX_LEVEL; level++) {
            extras.push({ label: `${ability.name} ${level + 1}`, group: 'abilities', cost: () => pirateAbilityUpgradeCost(level), buy: () => {} })
        }
    }
    for (const skin of PIRATE_SHIP_SKINS.filter(s => pirateSkinCost(s.id) > 0)) {
        extras.push({ label: skin.name, group: 'skins', cost: () => pirateSkinCost(skin.id), buy: () => {} })
    }
    const record = (label: string, group: string, cost: number) => purchases.push({ label, group, cost, run: runs, hours: seconds / 3600 })

    while (runs < MAX_RUNS && (position < LADDER.length || marque < PIRATE_MARQUE_MAX_LEVEL || extras.length)) {
        // The calibrated checkpoint at or below where the ship is.
        const checkpoint = points.filter(p => p <= position).pop() ?? 0
        let best: Expectation | null = null
        const ceiling = pirateMaxSelectableDifficulty(buildStats(buildAt(position)).power, highestCleared)
        for (let difficulty = 0; difficulty <= ceiling; difficulty += PIRATE_DIFFICULTY_STEP * 2) {
            const e = expectation(checkpoint, difficulty, skill, marque, highestCleared)
            if (e && (!best || e.pay / e.seconds > best.pay / best.seconds)) best = e
        }
        if (!best) throw new Error(`no calibration for checkpoint ${checkpoint}`)
        runs++
        seconds += best.seconds
        doubloons += best.pay
        payByRun.push({ run: runs, pay: best.pay, difficulty: best.difficulty })
        if (best.clearRate >= 0.5) highestCleared = Math.max(highestCleared, best.difficulty)

        for (;;) {
            const next = LADDER[position]
            const marqueCost = pirateMarqueUpgradeCost(marque)
            // A marque level is worth it when it pays back within a dozen voyages.
            const marqueWorth = marqueCost !== null && marqueCost <= best.pay * PIRATE_MARQUE_STEP / pirateMarqueMultiplier(marque) * 12
            if (marqueCost !== null && (marqueWorth || !next) && doubloons >= marqueCost) {
                doubloons -= marqueCost
                marque++
                record(`Letters of Marque ${marque}`, 'marque', marqueCost)
                continue
            }
            if (next && doubloons >= next.cost) {
                doubloons -= next.cost
                position++
                record(next.label, next.group, next.cost)
                continue
            }
            if (!next && marque >= PIRATE_MARQUE_MAX_LEVEL && extras.length) {
                const cost = extras[0]!.cost() ?? 0
                if (doubloons < cost) break
                doubloons -= cost
                const extra = extras.shift()!
                record(extra.label, extra.group, cost)
                continue
            }
            break
        }
    }
    return { skill, purchases, runs, hours: seconds / 3600, payByRun }
}

// ─── Report ─────────────────────────────────────────────────────────────────

const pad = (value: string | number, width: number) => String(value).padStart(width)
const padRight = (value: string | number, width: number) => String(value).padEnd(width)
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`)

function report() {
    console.log(`Pirate Raid economy · voyages of ${PIRATE_RUN_DURATION_MS / 60_000} min + ${HARBOUR_SECONDS}s in harbour · ${SEEDS} seeds per cell`)
    console.log(`Everything costs ${pirateFullTreeCost()} doubloons (combat ladder ${LADDER_TOTAL} incl. trade-in losses).\n`)

    console.log('Voyage pay (full clear, no marque → max marque; first clear on top):')
    for (const d of [0, 200, 400, 600, 800, 1000]) {
        const plain = pirateVoyagePay(PIRATE_RUN_DURATION_MS, d, true, 0, d)
        const maxed = pirateVoyagePay(PIRATE_RUN_DURATION_MS, d, true, PIRATE_MARQUE_MAX_LEVEL, d)
        const bounty = pirateVoyagePay(PIRATE_RUN_DURATION_MS, d, true, 0, d - 1).firstClear
        console.log(`  difficulty ${pad(d, 4)}: ${pad(plain.total, 4)} → ${pad(maxed.total, 4)}   first clear +${bounty}`)
    }
    console.log()

    const careers = SKILLS.map(career)

    console.log('Calibration: bot survival by ladder checkpoint (careful / average / novice), best difficulty cleared')
    for (const position of checkpoints()) {
        const build = buildAt(position)
        const { power } = buildStats(build)
        const spent = LADDER.slice(0, position).reduce((sum, step) => sum + step.cost, 0)
        // Best difficulty cleared at least half the time, and how long the ship lasts one step above it.
        const cells = SKILLS.map((skill) => {
            let bestClear = -1
            for (const d of DIFFICULTIES) {
                const e = expectation(position, d, skill, 0, d)
                if (e && e.clearRate >= 0.5) bestClear = d
            }
            const above = expectation(position, bestClear + (bestClear < 0 ? 1 : 100), skill, 0, 0)
            const s = above ? above.seconds - HARBOUR_SECONDS : 0
            return `${pad(bestClear < 0 ? '—' : bestClear, 4)} (${above ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : ' — '} above)`
        })
        console.log(`  ${pad(spent, 6)} spent · power ${pad(power, 4)} · ${cells.join('  ')}`)
    }
    console.log()

    // Runs to afford: milestones of the combat ladder plus the side purchases.
    const milestone = (purchase: Purchase) => {
        if (purchase.group === 'marque' || purchase.group === 'abilities' || purchase.group === 'skins') return true
        return /Hull (2|4|6|8|10)$|Armour (2|5|10)$|Speed (2|5|10)$|Powder hold (2|5|10)$|Repairs \d$|Gun port \d$|Powder keg \d$/.test(purchase.label)
            || /^(Bronze Carronade|Iron Culverin|Steel Long Gun|Reinforced Basilisk|Mythril Broadside|Adamantite Bombard|Leviathan's Wrath) \(port (1|8)\)$/.test(purchase.label)
    }
    const labels = careers[0]!.purchases.filter(milestone).map(p => p.label)
    console.log(`${padRight('purchase', 30)}${pad('cost', 6)}   ${SKILLS.map(s => padRight(`${s.id} run (time)`, 20)).join('')}`)
    console.log('─'.repeat(36 + SKILLS.length * 20))
    for (const label of labels) {
        const cells = careers.map((c) => {
            const p = c.purchases.find(x => x.label === label)
            return padRight(p ? `${pad(p.run, 5)} (${hours(p.hours)})` : '   never', 20)
        })
        const cost = careers[0]!.purchases.find(x => x.label === label)!.cost
        console.log(`${padRight(label, 30)}${pad(cost, 6)}   ${cells.join('')}`)
    }
    console.log()

    console.log('Gaps between purchases (voyages), and what a voyage pays along the way:')
    for (const c of careers) {
        const runs = c.purchases.map(p => p.run)
        const gaps = runs.slice(1).map((run, i) => run - runs[i]!)
        const longest = Math.max(...gaps)
        const firstFive = c.purchases.slice(0, 5).map(p => p.run).join(', ')
        const at = (n: number) => {
            const r = c.payByRun[Math.min(c.payByRun.length - 1, n - 1)]
            return r ? `${Math.round(r.pay)}@${r.difficulty}` : '—'
        }
        console.log(`  ${padRight(c.skill.id, 8)} first five buys on voyages ${firstFive} · longest gap ${longest} · median gap ${gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]}`)
        console.log(`           pay per voyage (pay@difficulty): run 1 ${at(1)}, 10 ${at(10)}, 50 ${at(50)}, 100 ${at(100)}, 200 ${at(200)}, last ${at(c.payByRun.length)}`)
        console.log(`           everything bought after ${c.runs} voyages, ${hours(c.hours)} at sea and in harbour`)
    }
}

if (argv.includes('--worker')) {
    await worker()
} else {
    await calibrate()
    report()
}
