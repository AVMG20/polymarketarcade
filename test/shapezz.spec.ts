import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../server/database'
import { shapezzState } from '../server/database/schema'
import {
    buyShapezzUpgrade,
    buyShapezzWeapon,
    equipShapezzWeapon,
    finishShapezzRun,
    getShapezzState,
    parseShapezzReport,
    settleShapezzRun,
    startShapezzRun,
    type ShapezzRunRecords,
    type ShapezzRunReport
} from '../server/utils/shapezz'
import {
    shapezzDefeatSalvage,
    shapezzLootCeiling,
    shapezzPermanentUpgradeCost,
    shapezzRunOffer,
    shapezzWeaponPrice,
    shapezzWeaponReplacement
} from '../shared/shapezz/economy'
import { SHAPEZZ_CHECKPOINT_MS, SHAPEZZ_DIFFICULTY_IDS, shapezzRollPlatforms } from '../shared/shapezz/rules'
import { seedPlayer } from './setup/players'

const STARTED_AT = new Date('2026-01-01T00:00:00.000Z')

function records(overrides: Partial<ShapezzRunRecords> = {}): ShapezzRunRecords {
    return {
        runStartedAt: STARTED_AT,
        runDifficulty: 'surge',
        runsPlayed: 2,
        totalShardsEarned: 40,
        bestSurvivalMs: 40_000,
        bestKills: 80,
        bestCheckpoint: 0,
        ...overrides
    }
}

function report(overrides: Partial<ShapezzRunReport> = {}): ShapezzRunReport {
    return { reason: 'cashout', elapsedMs: SHAPEZZ_CHECKPOINT_MS, loot: 2_000, kills: 60, ...overrides }
}

/** Test fixtures only: give a save a balance directly. */
function setShards(playerId: string, shards: number) {
    getShapezzState(playerId)
    db.update(shapezzState).set({ shards }).where(eq(shapezzState.playerId, playerId)).run()
}

describe('SHAPEZZ settlement', () => {
    it('only banks a cash-out at a completed checkpoint', () => {
        const early = settleShapezzRun(records(), report({ elapsedMs: SHAPEZZ_CHECKPOINT_MS - 2000 }), STARTED_AT.getTime() + SHAPEZZ_CHECKPOINT_MS)
        expect(early.cashout).toBe(false)
        expect(early.awarded).toBe(shapezzDefeatSalvage(early.offer))
    })

    it('banks the offer at a checkpoint and updates the records', () => {
        const result = settleShapezzRun(records(), report(), STARTED_AT.getTime() + SHAPEZZ_CHECKPOINT_MS)
        expect(result.cashout).toBe(true)
        expect(result.awarded).toBe(shapezzRunOffer(2_000, SHAPEZZ_CHECKPOINT_MS, 'surge'))
        expect(result.awarded).toBeGreaterThan(0)
        expect(result.runsPlayed).toBe(3)
        expect(result.totalShardsEarned).toBe(40 + result.awarded)
        expect(result.bestCheckpoint).toBe(1)
    })

    it('believes reported loot only up to the ceiling for the run\'s length and difficulty', () => {
        const elapsedMs = 2 * SHAPEZZ_CHECKPOINT_MS
        const honest = settleShapezzRun(records(), report({ elapsedMs, loot: shapezzLootCeiling(elapsedMs, 'surge') }), STARTED_AT.getTime() + elapsedMs)
        const forged = settleShapezzRun(records(), report({ elapsedMs, loot: 999_999_999 }), STARTED_AT.getTime() + elapsedMs)
        expect(forged.awarded).toBe(honest.awarded)
    })

    it('salvages a share on defeat and records nothing for an abandoned run', () => {
        const elapsedMs = 3 * SHAPEZZ_CHECKPOINT_MS
        const defeat = settleShapezzRun(records(), report({ reason: 'defeat', elapsedMs, loot: 50_000 }), STARTED_AT.getTime() + elapsedMs)
        expect(defeat.cashout).toBe(false)
        expect(defeat.awarded).toBe(shapezzDefeatSalvage(defeat.offer))
        expect(defeat.awarded).toBeLessThan(defeat.offer)
        expect(defeat.runsPlayed).toBe(3)

        const abandoned = settleShapezzRun(records(), report({ reason: 'abandoned', elapsedMs, loot: 50_000 }), STARTED_AT.getTime() + elapsedMs)
        expect(abandoned).toMatchObject({ awarded: 0, elapsedMs: 0, runsPlayed: 2, bestSurvivalMs: 40_000 })
    })

    it('never counts more play time than the server clock saw', () => {
        const result = settleShapezzRun(records(), report({ elapsedMs: 600_000 }), STARTED_AT.getTime() + 50_000)
        expect(result.elapsedMs).toBe(53_000)
    })

    it('refuses malformed reports', () => {
        expect(() => parseShapezzReport({ runId: 'x', reason: 'win' })).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(() => parseShapezzReport({ reason: 'cashout' })).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(parseShapezzReport({ runId: 'x', reason: 'cashout', loot: '9999', elapsedMs: -5 })).toMatchObject({ loot: 0, elapsedMs: 0 })
    })
})

describe('SHAPEZZ economy rules', () => {
    it('pays more per minute for every checkpoint pushed, at any difficulty', () => {
        for (const difficulty of SHAPEZZ_DIFFICULTY_IDS) {
            let previous = 0
            for (let checkpoint = 1; checkpoint <= 12; checkpoint++) {
                const elapsedMs = checkpoint * SHAPEZZ_CHECKPOINT_MS
                const perMinute = shapezzRunOffer(shapezzLootCeiling(elapsedMs, difficulty), elapsedMs, difficulty) / checkpoint
                expect(perMinute).toBeGreaterThanOrEqual(previous)
                previous = perMinute
            }
        }
    })

    it('prices every chassis level above the one before and stops at the cap', () => {
        for (const id of ['core', 'overclock', 'armor', 'thrusters', 'magnet', 'killHeal'] as const) {
            let previous = 0
            for (let level = 0; ; level++) {
                const cost = shapezzPermanentUpgradeCost(id, level)
                if (cost === null) break
                expect(cost).toBeGreaterThan(previous)
                previous = cost
            }
            expect(previous).toBeGreaterThan(0)
        }
    })

    it('trades in a quarter of the previous rarity\'s price', () => {
        expect(shapezzWeaponReplacement(400, 1_100)).toEqual({ refund: 100, netCost: 1_000 })
        expect(shapezzWeaponReplacement(0, 100)).toEqual({ refund: 0, netCost: 100 })
    })

    it('keeps every ledge inside the arena and reachable from the floor', () => {
        const FLOOR_Y = 662
        const WIDTH = 1280
        const JUMP_APEX = 930 * 930 / (2 * 1900)
        for (let roll = 0; roll < 200; roll++) {
            const platforms = shapezzRollPlatforms()
            expect(platforms.length).toBeGreaterThanOrEqual(2)
            for (const platform of platforms) {
                expect(platform.x).toBeGreaterThanOrEqual(0)
                expect(platform.x + platform.width).toBeLessThanOrEqual(WIDTH)
                const supports = [{ x: 0, y: FLOOR_Y, width: WIDTH }, ...platforms.filter(other => other.y > platform.y)]
                expect(supports.some(support => support.y - platform.y < JUMP_APEX - 30
                    && platform.x < support.x + support.width && support.x < platform.x + platform.width)).toBe(true)
            }
        }
    })
})

describe('SHAPEZZ saves', () => {
    it('creates a save on first visit and keeps it', () => {
        const id = seedPlayer()
        const first = getShapezzState(id)
        expect(first).toMatchObject({ shards: 0, coreLevel: 0, weaponType: 'blaster', blasterRarity: 'common', runId: null })
        expect(getShapezzState(id)).toEqual(first)
    })

    it('opens one run at a time and settles it exactly once', async () => {
        const id = seedPlayer()
        const starts = await Promise.allSettled([0, 1].map(async () => startShapezzRun(id, 'surge')))
        expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        const run = (starts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<ReturnType<typeof startShapezzRun>>).value

        // Settle as if a checkpoint was reached a minute later.
        const settledAt = run.startedAt.getTime() + 60_000
        const body = { runId: run.runId, reason: 'cashout' as const, elapsedMs: SHAPEZZ_CHECKPOINT_MS, loot: 5_000, kills: 40 }
        const finished = finishShapezzRun(id, body, settledAt)
        expect(finished.awarded).toBeGreaterThan(0)
        expect(finished.shards).toBe(finished.awarded)
        expect(() => finishShapezzRun(id, body, settledAt)).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(getShapezzState(id)).toMatchObject({ shards: finished.awarded, runsPlayed: 1, runId: null })
    })

    it('refuses a finish for a run id it never issued', () => {
        const id = seedPlayer()
        startShapezzRun(id, 'spark')
        expect(() => finishShapezzRun(id, { runId: 'forged', reason: 'cashout', elapsedMs: 0, loot: 0, kills: 0 }))
            .toThrowError(expect.objectContaining({ statusCode: 400 }))
    })

    it('sells one upgrade when two parallel buys can only afford one', async () => {
        const id = seedPlayer()
        const cost = shapezzPermanentUpgradeCost('core', 0)!
        setShards(id, cost + 1)
        const buys = await Promise.allSettled([0, 1].map(async () => buyShapezzUpgrade(id, 'core')))
        expect(buys.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(getShapezzState(id)).toMatchObject({ coreLevel: 1, shards: 1 })
    })

    it('refuses purchases without the shards or during a run', () => {
        const id = seedPlayer()
        expect(() => buyShapezzUpgrade(id, 'armor')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        setShards(id, 10_000)
        startShapezzRun(id, 'surge')
        expect(() => buyShapezzUpgrade(id, 'armor')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(() => buyShapezzWeapon(id, 'launcher', 'common')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(getShapezzState(id)).toMatchObject({ shards: 10_000, armorLevel: 0, launcherRarity: null })
    })

    it('buys a weapon once, trades in the previous rarity and equips', async () => {
        const id = seedPlayer()
        const rare = shapezzWeaponPrice('blaster', 'rare')
        setShards(id, rare + 5)
        const buys = await Promise.allSettled([0, 1].map(async () => buyShapezzWeapon(id, 'blaster', 'rare')))
        expect(buys.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        expect(getShapezzState(id)).toMatchObject({ blasterRarity: 'rare', blasterPrice: rare, shards: 5 })
        expect(() => buyShapezzWeapon(id, 'blaster', 'common')).toThrowError(expect.objectContaining({ statusCode: 400 }))

        const epic = shapezzWeaponPrice('blaster', 'epic')
        setShards(id, epic)
        const upgraded = buyShapezzWeapon(id, 'blaster', 'epic')
        expect(upgraded.refund).toBe(Math.floor(rare / 4))
        expect(upgraded.shards).toBe(Math.floor(rare / 4))

        expect(() => equipShapezzWeapon(id, 'railgun')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        setShards(id, shapezzWeaponPrice('railgun', 'common'))
        buyShapezzWeapon(id, 'railgun', 'common')
        expect(getShapezzState(id).weaponType).toBe('railgun')
        equipShapezzWeapon(id, 'blaster')
        expect(getShapezzState(id).weaponType).toBe('blaster')
    })
})
