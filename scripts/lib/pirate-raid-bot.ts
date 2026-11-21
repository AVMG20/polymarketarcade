/**
 * The Pirate Raid bot: plays the real PirateSim headless like a careful human.
 * Every `reactionMs` it scores a ring of candidate waypoints against every
 * telegraph, contact projectile, mine, hostile zone, fire ship and enemy gun
 * range, keeps the fleet near the edge of its own cannon reach, and grabs
 * crates and repair kits when the water is safe. It casts its ability where a
 * human would. A slower reaction plays like a less skilled captain.
 * Used by scripts/pirate-raid-playtest.ts and scripts/pirate-raid-economy.ts.
 */

import {
    PIRATE_HELLFIRE_ZONE_RADIUS, PIRATE_MAELSTROM_RADIUS, PIRATE_ROGUE_WAVE_LENGTH, PIRATE_ROGUE_WAVE_WIDTH,
    PIRATE_RUN_DURATION_MS, pirateCannonTier, pirateDefenseRating, pirateMaxHp, piratePowerLevel, pirateRegenRate,
    pirateShipSpeed, pirateAmmoCapacity, type PirateAbilityId, type PirateShipStatId
} from '../../shared/pirate-raid/rules'
import { PirateSim } from '../../app/utils/pirate-raid/engine/sim'
import type { PirateGameOverResult, PirateShipStats } from '../../app/utils/pirate-raid/engine/types'
import { WORLD_H, WORLD_W } from '../../app/utils/pirate-raid/engine/constants'

// ─── Seeded randomness ──────────────────────────────────────────────────────

export function installSeed(seed: number) {
    let a = seed >>> 0 || 1
    let b = 0x9E3779B9
    let c = 0x243F6A88
    let d = 0xB7E15162
    const next = () => {
        // sfc32
        const t = (((a + b) >>> 0) + d) >>> 0
        d = (d + 1) >>> 0
        a = b ^ (b >>> 9)
        b = (c + (c << 3)) >>> 0
        c = ((c << 21) | (c >>> 11)) >>> 0
        c = (c + t) >>> 0
        return t
    }
    for (let i = 0; i < 12; i++) next()
    Math.random = () => next() / 4294967296
    const values = crypto as unknown as { getRandomValues: <T extends ArrayBufferView>(array: T) => T }
    values.getRandomValues = <T extends ArrayBufferView>(array: T) => {
        const view = new Uint32Array(array.buffer, array.byteOffset, Math.floor(array.byteLength / 4))
        for (let i = 0; i < view.length; i++) view[i] = next()
        return array
    }
}

// ─── Bot ────────────────────────────────────────────────────────────────────

/** A careful human's reaction time; slower bots play like less skilled captains. */
export const DEFAULT_REACTION_MS = 100
const HIT_R = 34
const CANDIDATE_RADII = [70, 150]
const CANDIDATE_DIRECTIONS = 12

interface Pt { x: number, y: number }

const d2 = (ax: number, ay: number, bx: number, by: number) => (ax - bx) ** 2 + (ay - by) ** 2
const dst = (ax: number, ay: number, bx: number, by: number) => Math.sqrt(d2(ax, ay, bx, by))

function segDist(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len))
    return dst(ax + dx * t, ay + dy * t, px, py)
}

/** Danger of sitting at `c` over the next second or so. Lower is better. */
function danger(sim: PirateSim, c: Pt, range: number) {
    let score = 0
    for (const t of sim.telegraphs) {
        if (!t.hostile) continue
        const urgency = 1 + Math.min(1, t.ageMs / Math.max(1, t.durationMs)) * 2
        if (t.kind === 'line') {
            if (segDist(t.x, t.y, t.x2, t.y2, c.x, c.y) < t.width + HIT_R + 16) score += 60 * urgency
        } else if (d2(t.x, t.y, c.x, c.y) < (t.r + HIT_R) ** 2) {
            score += 80 * urgency
        }
    }
    for (const p of sim.projectiles) {
        if (p.owner !== 'enemy') continue
        if (p.kind === 'spiral' || p.kind === 'skiff' || p.kind === 'mine' || p.kind === 'harpoon' || p.kind === 'sniper') {
            // Where it will be in ~0.3s.
            const ax = p.x + Math.cos(p.angle) * 90
            const ay = p.y + Math.sin(p.angle) * 90
            if (segDist(p.x, p.y, ax, ay, c.x, c.y) < HIT_R + 22) score += 25
        }
    }
    for (const mine of sim.mines) {
        if (d2(mine.x, mine.y, c.x, c.y) < 85 * 85) score += 120
    }
    for (const z of sim.zones) {
        if ((z.kind === 'whirlpool' || z.kind === 'ink') && d2(z.x, z.y, c.x, c.y) < z.r * z.r) score += z.kind === 'whirlpool' ? 40 : 15
    }
    let nearest = Infinity
    for (const e of sim.enemies) {
        if (e.state === 'submerged' || e.state === 'diving') continue
        const d = dst(e.x, e.y, c.x, c.y)
        if (e.tier.id === 'fireship') {
            const reach = e.state === 'burning' ? 190 : 130
            if (d < reach) score += (reach - d) * (e.state === 'burning' ? 1.2 : 0.4)
            continue
        }
        nearest = Math.min(nearest, d)
        // Gun reach: being inside several ranges at once is what sinks ships.
        if (d < e.tier.range) score += (1 - d / Math.max(1, e.tier.range)) * (e.tier.boss ? 8 : 3)
        if (d < 110) score += (110 - d) * 0.3
    }
    // Keep the fleet near the edge of our own reach so the guns keep working.
    if (nearest < Infinity) {
        const ideal = range * 0.85
        score += Math.abs(nearest - ideal) / 60
    }
    // Stay off the edges and corners, where a ship gets pinned.
    const edge = Math.min(c.x, c.y, WORLD_W - c.x, WORLD_H - c.y)
    if (edge < 140) score += (140 - edge) * 0.08
    return score
}

function densest(sim: PirateSim, radius: number): { x: number, y: number, n: number, boss: boolean } | null {
    let best: { x: number, y: number, n: number, boss: boolean } | null = null
    const live = sim.enemies.filter(e => e.state === 'sailing' || e.state === 'burning')
    for (const centre of live) {
        let n = 0
        let sx = 0
        let sy = 0
        let boss = false
        for (const e of live) {
            if (d2(e.x, e.y, centre.x, centre.y) > radius * radius) continue
            n += e.tier.boss ? 3 : 1
            sx += e.x
            sy += e.y
            boss = boss || !!e.tier.boss
        }
        const count = live.filter(e => d2(e.x, e.y, centre.x, centre.y) <= radius * radius).length
        if (!best || n > best.n) best = { x: sx / count, y: sy / count, n, boss }
    }
    return best
}

export interface BotState {
    decideMs: number
    readySinceMs: number
    /** How often the bot looks at the sea and decides. */
    reactionMs: number
}

export function botTick(sim: PirateSim, bot: BotState, crates: boolean) {
    const p = sim.player
    const range = sim.cannonRange
    const hurt = p.hp / p.maxHp

    // ─── Helm ───
    let best: Pt | null = null
    let bestScore = danger(sim, p, range) - 0.5 // small bias toward holding still
    for (const r of CANDIDATE_RADII) {
        for (let i = 0; i < CANDIDATE_DIRECTIONS; i++) {
            const a = i / CANDIDATE_DIRECTIONS * Math.PI * 2
            const c = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r }
            if (c.x < 50 || c.y < 50 || c.x > WORLD_W - 50 || c.y > WORLD_H - 50 || sim.blocked(c.x, c.y)) continue
            // Halfway point too: the ship has to sail through it.
            const mid = { x: (p.x + c.x) / 2, y: (p.y + c.y) / 2 }
            const score = danger(sim, c, range) * 0.7 + danger(sim, mid, range) * 0.3 + r / 400
            if (score < bestScore) {
                bestScore = score
                best = c
            }
        }
    }
    // Pickups when the water is calm enough.
    let pickupGoal: Pt | null = null
    let pickupD = Infinity
    for (const pickup of sim.pickups) {
        if (pickup.kind === 'crate' && !crates) continue
        if (pickup.kind === 'repair' && hurt > 0.8) continue
        const d = dst(p.x, p.y, pickup.x, pickup.y)
        const want = pickup.kind === 'repair' ? (hurt < 0.45 ? 900 : 500) : 600
        if (d > want || d >= pickupD) continue
        if (danger(sim, pickup, range) > 30) continue
        pickupGoal = pickup
        pickupD = d
    }
    if (pickupGoal && bestScore < 20) {
        sim.sailTo(pickupGoal.x, pickupGoal.y, false)
    } else if (best) {
        sim.sailTo(best.x, best.y, false)
    } else {
        sim.heaveTo()
    }

    // ─── Ability ───
    if (!sim.abilityReady) {
        bot.readySinceMs = -1
        return
    }
    if (bot.readySinceMs < 0) bot.readySinceMs = sim.elapsedMs
    const waited = sim.elapsedMs - bot.readySinceMs
    const live = sim.enemies.filter(e => e.state === 'sailing' || e.state === 'burning')
    if (!live.length) return
    switch (sim.abilityId) {
        case 'seekers':
        case 'consort':
            sim.castAbility(p.x, p.y)
            return
        case 'bomb':
        case 'maelstrom': {
            const target = densest(sim, sim.abilityId === 'bomb' ? 120 : PIRATE_MAELSTROM_RADIUS * 0.8)
            if (target && (target.n >= 3 || target.boss || waited > 4000 || hurt < 0.4)) sim.castAbility(target.x, target.y)
            return
        }
        case 'firestorm': {
            const target = densest(sim, PIRATE_HELLFIRE_ZONE_RADIUS * 0.8)
            if (target && (target.n >= 4 || target.boss || waited > 5000 || hurt < 0.4)) sim.castAbility(target.x, target.y)
            return
        }
        case 'tidal': {
            // The lane from the ship with the most hulls and incoming shot.
            let bestAngle = 0
            let bestValue = 0
            for (let i = 0; i < 16; i++) {
                const a = i / 16 * Math.PI * 2
                const cos = Math.cos(a)
                const sin = Math.sin(a)
                let value = 0
                const inLane = (x: number, y: number) => {
                    const along = (x - p.x) * cos + (y - p.y) * sin
                    const across = Math.abs(-(x - p.x) * sin + (y - p.y) * cos)
                    return along > 0 && along < PIRATE_ROGUE_WAVE_LENGTH && across < PIRATE_ROGUE_WAVE_WIDTH / 2
                }
                for (const e of live) if (inLane(e.x, e.y)) value += e.tier.boss ? 3 : 1
                for (const proj of sim.projectiles) if (proj.owner === 'enemy' && inLane(proj.x, proj.y)) value += 0.4
                if (value > bestValue) {
                    bestValue = value
                    bestAngle = a
                }
            }
            if (bestValue >= 3 || (bestValue >= 1 && (waited > 4000 || hurt < 0.4))) {
                sim.castAbility(p.x + Math.cos(bestAngle) * 300, p.y + Math.sin(bestAngle) * 300)
            }
        }
    }
}

// ─── Loadouts and whole voyages ─────────────────────────────────────────────

export interface PirateBuild {
    levels: Record<PirateShipStatId, number>
    cannons: string[]
    slots: number
    abilityId: PirateAbilityId
    abilityLevel: number
}

/** The stats a voyage starts with for a build (charged shot fills the hold). */
export function buildStats(build: PirateBuild): { stats: PirateShipStats, power: number } {
    const power = piratePowerLevel({ levels: build.levels, cannonTierIds: build.cannons, cannonSlots: build.slots })
    return {
        power,
        stats: {
            maxHp: pirateMaxHp(build.levels.hull),
            speed: pirateShipSpeed(build.levels.speed),
            defenseRating: pirateDefenseRating(build.levels.defense),
            regenRate: pirateRegenRate(build.levels.regen),
            ammo: pirateAmmoCapacity(build.levels.ammoCapacity),
            skinId: 'starter',
            abilityId: build.abilityId,
            abilityLevel: build.abilityLevel,
            cannons: build.cannons.map((id, slotIndex) => {
                const t = pirateCannonTier(id)
                return { slotIndex, tierId: t.id, attackRating: t.attackRating, maxDamage: t.maxDamage, reloadMs: t.reloadMs, range: t.range, shotColor: t.shotColor, shotTrail: !!t.shotTrail }
            })
        }
    }
}

export interface VoyageOptions {
    seed: number
    reactionMs?: number
    crates?: boolean
    /**
     * Multiplies the damage the ship takes: 1 is the bot, a careful captain.
     * A less skilled captain eats more shot (1.3, 1.7).
     */
    damageTaken?: number
}

/** Sail one whole voyage with the bot and return the engine's report. */
export function sailVoyage(build: PirateBuild, difficulty: number, options: VoyageOptions): PirateGameOverResult {
    installSeed(options.seed)
    const { stats, power } = buildStats(build)
    let over: PirateGameOverResult | null = null
    const sim = new PirateSim({ onGameOver: (result) => { over = result } })
    const handicap = options.damageTaken ?? 1
    if (handicap !== 1) {
        const raw = sim as unknown as { damagePlayer: (amount: number, heavy?: boolean) => void }
        const damagePlayer = raw.damagePlayer.bind(sim)
        raw.damagePlayer = (amount, heavy) => damagePlayer(amount * handicap, heavy)
    }
    sim.prepare(stats)
    sim.start(stats, power, difficulty)
    const bot: BotState = { decideMs: 0, readySinceMs: -1, reactionMs: options.reactionMs ?? DEFAULT_REACTION_MS }
    const step = 1000 / 60
    let guard = 0
    while (!over && guard++ < (PIRATE_RUN_DURATION_MS + 5000) / step) {
        sim.step(step)
        sim.drainEvents()
        bot.decideMs -= step
        if (bot.decideMs <= 0) {
            bot.decideMs = bot.reactionMs
            botTick(sim, bot, options.crates ?? true)
        }
    }
    const result = over as PirateGameOverResult | null
    if (!result) throw new Error('voyage did not end')
    return result
}
