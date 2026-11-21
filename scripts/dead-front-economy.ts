// Dead Front medal economy: how many matches (and hours) it takes players of
// a few skill levels to afford each research tier and to research everything.
// A sim, not a test: tune DF_RESEARCH_COSTS and the medal pay in
// shared/dead-front/progression.ts until this reads right.
//
//   bun --tsconfig-override scripts/tsconfig.bun.json scripts/dead-front-economy.ts [players=2000] [seed=7]
//
// What to look for: the first level after a match or two, a new level every
// few matches, the full max-out taking dozens of hours, and medals per hour
// rising with the round you reach (dying early on purpose must not pay best).
import { dfRoundZombieCount } from '#shared/dead-front/enemies'
import { DF_PERK_IDS } from '#shared/dead-front/perks'
import { DF_PERK_MAX_LEVEL, DF_RESEARCH_COSTS, dfMedalsFromMatch, dfResearchTotal } from '#shared/dead-front/progression'
import { createSeededRandom } from '#shared/utils/random'

const PLAYERS = Number(process.argv[2] ?? 2000)
const rng = createSeededRandom(Number(process.argv[3] ?? 7))

/** Seconds between rounds. */
const INTERMISSION = 15

/**
 * Solo round length: every zombie of the round has to die. Seconds per zombie
 * come from scripts/dead-front-balance.ts (bots: 3.5 early, ~6 by round 10).
 */
function roundSeconds(round: number, perZombie: number): number {
    return INTERMISSION + dfRoundZombieCount(round, 1) * perZombie * (1 + Math.min(round, 20) * 0.02)
}

interface Skill {
    name: string
    /** Mean and spread of the round the player falls on. */
    fall: number
    spread: number
    perZombie: number
    eggChance: number
}

const SKILLS: Skill[] = [
    { name: 'casual', fall: 7, spread: 2, perZombie: 5, eggChance: 0 },
    { name: 'average', fall: 11, spread: 3, perZombie: 4.5, eggChance: 0.05 },
    { name: 'good', fall: 15, spread: 3, perZombie: 4, eggChance: 0.25 },
    { name: 'expert', fall: 21, spread: 4, perZombie: 3.6, eggChance: 0.6 }
]

function gauss(): number {
    const u = Math.max(1e-9, rng.randomFloat())
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.randomFloat())
}

/** One match: medals and minutes. Research makes you a little sturdier: +1 round per six levels. */
function playMatch(skill: Skill, levels: number) {
    const fall = Math.max(1, Math.round(skill.fall + levels / 6 + gauss() * skill.spread))
    const completed = fall - 1
    let seconds = 0
    let kills = 0
    for (let r = 1; r <= completed; r++) {
        seconds += roundSeconds(r, skill.perZombie)
        kills += dfRoundZombieCount(r, 1)
    }
    seconds += roundSeconds(fall, skill.perZombie) / 2
    kills += Math.floor(dfRoundZombieCount(fall, 1) / 2)
    const egg = completed >= 12 && rng.randomChance(skill.eggChance)
    return { medals: dfMedalsFromMatch({ roundsSurvived: completed, kills, completedEasterEgg: egg }), minutes: seconds / 60 }
}

const TOTAL = dfResearchTotal(DF_PERK_IDS.length)
const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)] ?? 0
}

console.log(`research costs per level: ${DF_RESEARCH_COSTS.join(', ')} · ${DF_PERK_IDS.length} perks · all research: ${TOTAL} medals\n`)

for (const skill of SKILLS) {
    // runs (and hours) until the first time the player could buy a level of each tier
    const tierRuns: number[][] = Array.from({ length: DF_PERK_MAX_LEVEL }, () => [])
    const tierHours: number[][] = Array.from({ length: DF_PERK_MAX_LEVEL }, () => [])
    const maxRuns: number[] = []
    const maxHours: number[] = []
    const perRun: number[] = []
    for (let n = 0; n < PLAYERS; n++) {
        const levels = DF_PERK_IDS.map(() => 0)
        let medals = 0
        let runs = 0
        let minutes = 0
        let bought = 0
        while (bought < levels.length * DF_PERK_MAX_LEVEL && runs < 5000) {
            const m = playMatch(skill, bought)
            runs++
            minutes += m.minutes
            medals += m.medals
            if (n < 200) perRun.push(m.medals)
            // buy the cheapest next level while affordable
            for (;;) {
                let pick = -1
                for (let i = 0; i < levels.length; i++) {
                    if (levels[i]! < DF_PERK_MAX_LEVEL && (pick < 0 || levels[i]! < levels[pick]!)) pick = i
                }
                if (pick < 0) break
                const cost = DF_RESEARCH_COSTS[levels[pick]!]!
                if (medals < cost) break
                medals -= cost
                if (!tierRuns[levels[pick]!]![n]) {
                    tierRuns[levels[pick]!]![n] = runs
                    tierHours[levels[pick]!]![n] = minutes / 60
                }
                levels[pick]!++
                bought++
            }
        }
        maxRuns.push(runs)
        maxHours.push(minutes / 60)
    }
    console.log(`${skill.name.padEnd(8)} falls ~round ${skill.fall}: ${median(perRun)} medals a match over a career (median)`)
    for (let t = 0; t < DF_PERK_MAX_LEVEL; t++) {
        const runs = tierRuns[t]!.filter(Boolean)
        console.log(`  level ${t + 1} (${String(DF_RESEARCH_COSTS[t]).padStart(3)}): first after ${String(median(runs)).padStart(3)} matches, ${median(tierHours[t]!.filter(Boolean)).toFixed(1).padStart(5)} h`)
    }
    console.log(`  everything: ${median(maxRuns)} matches, ${median(maxHours).toFixed(0)} h\n`)
}

// The degenerate loop check: medals per hour when every match ends on round R.
console.log('medals per hour if every match ends on round R (average skill, no egg):')
const avg = SKILLS[1]!
const rows: string[] = []
for (const fall of [3, 5, 7, 10, 12, 15, 18, 20, 22, 25, 30]) {
    let seconds = 0
    let kills = 0
    for (let r = 1; r < fall; r++) {
        seconds += roundSeconds(r, avg.perZombie)
        kills += dfRoundZombieCount(r, 1)
    }
    const medals = dfMedalsFromMatch({ roundsSurvived: fall - 1, kills, completedEasterEgg: false })
    rows.push(`  round ${String(fall).padStart(2)}: ${String(medals).padStart(3)} medals in ${(seconds / 60).toFixed(0).padStart(3)} min → ${(medals / (seconds / 3600)).toFixed(0).padStart(3)}/h`)
}
console.log(rows.join('\n'))
