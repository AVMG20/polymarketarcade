import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db, writeTx } from '#server/database'
import { polytownBuildings, polytownInventory, polytownState, polytownStreak } from '#server/database/schema'
import {
    activateTownBoosts,
    addTownBoosters,
    deleteTownForPlayer,
    finishLongestTownJobs,
    placeBuilding,
    sellToFloor,
    startTownBooster
} from '#server/utils/polytown/town'
import { claimTownStreakStep, getTownStreak } from '#server/utils/polytown/streak'
import { TOWN_BOOST_MS, TOWN_MARKET_DAY_MS, TOWN_TEMP_BUILDER_MS } from '#shared/polytown/town-boosts'
import { TOWN_STREAK_MIN_INCOME_PER_DAY } from '#shared/polytown/town-streak'
import { TOWN_FREE_BUILDERS, getTownBuilding, townFloorPrice } from '#shared/polytown/town'
import { SKIP, burst, cleanupUser, foundTown, lockTownRealm, moveTownToFlatGround, seedUser } from './db-helpers'

// Lets a test pin the chest rolls; every other test draws real numbers.
const rolls = vi.hoisted(() => ({ forced: null as number | null }))
vi.mock('#shared/utils/random', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#shared/utils/random')>()
    return { ...actual, randomFloat: () => rolls.forced ?? actual.randomFloat() }
})

const OWNER = 'test-town-boosts-owner'
const MIN = 60_000

async function cleanup() {
    await db.delete(polytownStreak).where(eq(polytownStreak.playerId, OWNER))
    await deleteTownForPlayer(OWNER)
    await cleanupUser(OWNER)
}

async function stateRow() {
    const [row] = await db.select().from(polytownState).where(eq(polytownState.playerId, OWNER))
    return row!
}

async function building(id: string) {
    const [row] = await db.select().from(polytownBuildings).where(eq(polytownBuildings.id, id))
    return row!
}

/** A house under construction, finishing `ms` from now. */
async function job(plotId: string, tileX: number, ms: number, type = 'house') {
    const [row] = await db.insert(polytownBuildings)
        .values({ playerId: OWNER, plotId, type, tileX, tileY: 3, rotation: 0, level: 0, completesAt: new Date(Date.now() + ms) })
        .returning()
    return row!
}

describe.skipIf(SKIP)('Polytown boosts (database)', () => {
    let releaseRealm: () => Promise<void>
    let plotId: string
    beforeAll(async () => {
        releaseRealm = await lockTownRealm()
        await cleanup()
    }, 120_000)

    beforeEach(async () => {
        await seedUser(OWNER, { balance: '100000000000', gems: 0 })
        plotId = (await foundTown(OWNER)).plotId
    })
    afterEach(async () => {
        rolls.forced = null
        await cleanup()
    })
    afterAll(async () => { await releaseRealm() })

    it('stores a Builder\'s rush day as one booster, and halves a running 30-minute job when it starts, once under a burst', async () => {
        const pending = await job(plotId, 0, 30 * MIN)
        await getTownStreak(OWNER)
        // Day 9 is the first Builder's rush; lock it as if it unlocked today.
        await db.update(polytownStreak).set({ step: 9 }).where(eq(polytownStreak.playerId, OWNER))
        await db.update(polytownStreak).set({ locked: { 9: { scale: { incomePerDay: 60_000, outputPerHour: {} }, reward: { coins: 0, resources: {}, boosters: { build: 1 } } } } }).where(eq(polytownStreak.playerId, OWNER))

        const claims = await Promise.allSettled(Array.from({ length: 10 }, async () => claimTownStreakStep(OWNER, 9)))
        const claimed = claims.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
        expect(claimed).toHaveLength(1)
        expect(claimed[0]!.reward.boosters).toEqual({ build: 1 })
        // Claiming only stores it: the job runs at its own pace until the mayor starts it.
        expect((await building(pending.id)).completesAt.getTime()).toBe(pending.completesAt.getTime())
        expect((await stateRow()).boosters).toEqual({ build: 1 })

        const before = Date.now()
        const results = await Promise.allSettled(Array.from({ length: 10 }, async () => startTownBooster(OWNER, 'build')))
        const after = Date.now()
        const won = results.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
        expect(won).toHaveLength(1)
        expect((await stateRow()).boosters).toEqual({})

        const ends = (await building(pending.id)).completesAt.getTime()
        const originalEnd = pending.completesAt.getTime()
        // Rushed at some instant `a` in [before, after]: it ends at a + (end - a) / 2.
        expect(ends).toBeGreaterThanOrEqual(before + (originalEnd - after) / 2 - 5)
        expect(ends).toBeLessThanOrEqual(after + (originalEnd - before) / 2 + 5)
        expect(originalEnd - ends).toBeGreaterThan(14 * MIN)

        const until = (await stateRow()).buildBoostUntil!.getTime()
        expect(until).toBeGreaterThanOrEqual(before + TOWN_BOOST_MS)
        expect(until).toBeLessThanOrEqual(after + TOWN_BOOST_MS)
    })

    it('shortens jobs started while the rush runs, and lengthens the rush on a second one', async () => {
        await moveTownToFlatGround(plotId)
        const now = Date.now()
        await writeTx(tx => activateTownBoosts(tx, OWNER, { build: TOWN_BOOST_MS }, now))
        const placed = await placeBuilding(OWNER, plotId, 0, 1, 'house', 2)
        const plain = getTownBuilding('house')!.buildMs
        // Shorter than the plain build, by the half that ran in the rush.
        expect(placed.completesAt - Date.now()).toBeLessThan(plain)

        await writeTx(tx => activateTownBoosts(tx, OWNER, { build: TOWN_BOOST_MS }, now))
        expect((await stateRow()).buildBoostUntil!.getTime()).toBe(now + 2 * TOWN_BOOST_MS)
    })

    it('finishes the longest running jobs, never a monument stage', async () => {
        const short = await job(plotId, 0, 10 * MIN)
        const long = await job(plotId, 1, 5 * 60 * MIN)
        const monument = await job(plotId, 2, 50 * 60 * MIN, 'pyramid')
        const now = Date.now()
        const done = await writeTx(tx => finishLongestTownJobs(tx, OWNER, 1, now))
        expect(done).toHaveLength(1)
        expect(done[0]).toMatchObject({ buildingId: long.id, type: 'house', level: 1 })
        expect(done[0]!.savedMs).toBeGreaterThan(4 * 60 * MIN)
        expect(await building(long.id)).toMatchObject({ level: 1, upgradingTo: null })
        expect((await building(short.id)).level).toBe(0)
        expect((await building(monument.id)).level).toBe(0)

        // Two asked for, one left that qualifies.
        const rest = await writeTx(tx => finishLongestTownJobs(tx, OWNER, 2, Date.now()))
        expect(rest.map(r => r.buildingId)).toEqual([short.id])
    })

    it('lends one crew for a day, starts one job per crew under a burst, and stops new jobs past the owned crews once it leaves', async () => {
        await moveTownToFlatGround(plotId)
        const now = Date.now()
        await writeTx(tx => activateTownBoosts(tx, OWNER, { builder: TOWN_TEMP_BUILDER_MS }, now))
        await writeTx(tx => activateTownBoosts(tx, OWNER, { builder: TOWN_TEMP_BUILDER_MS }, now))
        expect((await stateRow()).tempBuilderUntil!.getTime()).toBe(now + 2 * TOWN_TEMP_BUILDER_MS)

        const { ok } = await burst(8, i => placeBuilding(OWNER, plotId, i, 1, 'house', 2))
        expect(ok).toBe(TOWN_FREE_BUILDERS + 1)

        // The crew leaves: the jobs keep running, but nothing new starts.
        await db.update(polytownState).set({ tempBuilderUntil: new Date(now - 1) }).where(eq(polytownState.playerId, OWNER))
        const running = await db.select().from(polytownBuildings).where(and(eq(polytownBuildings.playerId, OWNER), eq(polytownBuildings.type, 'house')))
        expect(running.filter(b => b.level === 0)).toHaveLength(TOWN_FREE_BUILDERS + 1)
        expect(() => placeBuilding(OWNER, plotId, 0, 5, 'house', 2)).toThrow(/builder/i)
    })

    it('pays market-day coins out of the budget only, however many sells race for it', async () => {
        const budget = 100
        await writeTx(tx => activateTownBoosts(tx, OWNER, { market: 60 * MIN, marketBudget: budget }, Date.now()))
        expect((await stateRow()).marketBoostBonusLeft).toBe(budget)
        const qty = Math.ceil(budget / townFloorPrice('wheat'))
        await db.insert(polytownInventory).values({ playerId: OWNER, resource: 'wheat', amount: qty * 10 })
        const bonuses: number[] = []

        const { ok } = await burst(10, async () => bonuses.push((await sellToFloor(OWNER, 'wheat', qty)).marketBonus))
        expect(ok).toBe(10)
        const paid = bonuses.reduce((sum, b) => sum + b, 0)
        expect(paid).toBeCloseTo(budget, 4)
        expect((await stateRow()).marketBoostBonusLeft).toBe(0)
        // Some sale ran out of budget and got none.
        expect(bonuses.some(b => b === 0)).toBe(true)
    })

    it('drops a lapsed market day\'s budget when a new one starts', async () => {
        await db.update(polytownState).set({ marketBoostUntil: new Date(Date.now() - 1), marketBoostBonusLeft: 5000 }).where(eq(polytownState.playerId, OWNER))
        await writeTx(tx => activateTownBoosts(tx, OWNER, { market: 60 * MIN, marketBudget: 100 }, Date.now()))
        expect((await stateRow()).marketBoostBonusLeft).toBe(100)
        await writeTx(tx => activateTownBoosts(tx, OWNER, { market: 60 * MIN, marketBudget: 100 }, Date.now()))
        expect((await stateRow()).marketBoostBonusLeft).toBe(200)
    })

    it('spends a lucky charge on exactly one chest under parallel opens', async () => {
        await getTownStreak(OWNER)
        // Days 7, 14 and 21 are chests, unlocked and unclaimed; one charge waiting.
        await db.update(polytownStreak).set({ step: 21, lucky: 1 }).where(eq(polytownStreak.playerId, OWNER))
        const claims = [7, 7, 7, 14, 14, 21, 21].map(async step => claimTownStreakStep(OWNER, step))
        const settled = await Promise.allSettled(claims)
        const rewards = settled.flatMap(r => r.status === 'fulfilled' ? [r.value.reward] : [])
        expect(rewards.map(r => r.step).sort()).toEqual([14, 21, 7])

        const used = rewards.filter(r => r.upgradedFrom).length
        const won = rewards.reduce((sum, r) => sum + (r.extras ?? []).filter(e => e.kind === 'lucky').length, 0)
        const [row] = await db.select().from(polytownStreak).where(eq(polytownStreak.playerId, OWNER))
        expect(used).toBeGreaterThanOrEqual(1)
        expect(row!.lucky).toBe(1 + won - used)
        expect(row!.lucky).toBeGreaterThanOrEqual(0)
    })

    it('finishes two different jobs when two instant finishes race', async () => {
        const a = await job(plotId, 0, 60 * MIN)
        const b = await job(plotId, 1, 30 * MIN)
        const done: string[] = []
        const { ok } = await burst(3, async () => {
            const rows = await writeTx(tx => finishLongestTownJobs(tx, OWNER, 1, Date.now()))
            done.push(...rows.map(r => r.buildingId))
        })
        expect(ok).toBe(3)
        expect(done.sort()).toEqual([a.id, b.id].sort())
    })

    it('never shortens a job twice when rushes are granted in parallel', async () => {
        const pending = await job(plotId, 0, 30 * MIN)
        const now = Date.now()
        const { ok } = await burst(5, () => writeTx(tx => activateTownBoosts(tx, OWNER, { build: TOWN_BOOST_MS }, now)))
        expect(ok).toBe(5)
        // The first window halves it; the later ones start after it has finished.
        const remaining = (await building(pending.id)).completesAt.getTime() - now
        expect(remaining).toBeGreaterThan(14 * MIN)
        expect(remaining).toBeLessThanOrEqual(15 * MIN + 1_000)
        expect((await stateRow()).buildBoostUntil!.getTime()).toBe(now + 5 * TOWN_BOOST_MS)
    })

    it('stores every booster a golden chest holds, its extras and its booster roll', async () => {
        await getTownStreak(OWNER)
        await db.update(polytownStreak)
            .set({ step: 30, lastDay: null, locked: { 30: { scale: { incomePerDay: 5_000_000, outputPerHour: {} } } } })
            .where(eq(polytownStreak.playerId, OWNER))
        // Every slot misses but the guaranteed one, which lands on a market day; the booster roll draws three borrowed crews.
        rolls.forced = 0.7
        const { reward } = await claimTownStreakStep(OWNER, 30)
        expect(reward.extras!.map(e => e.kind)).toEqual(['market', 'builder', 'builder', 'builder'])
        expect(reward.boosters).toEqual({ market: 1, builder: 3 })
        expect((await stateRow()).boosters).toEqual({ market: 1, builder: 3 })
        // Nothing started yet.
        expect((await stateRow()).marketBoostUntil).toBeNull()
    })

    it('starts a stored market day for 12 hours with a day of the town\'s floor income as its budget, and refuses an empty store', async () => {
        writeTx(tx => addTownBoosters(tx, OWNER, { market: 1 }))
        const before = Date.now()
        startTownBooster(OWNER, 'market')
        const row = await stateRow()
        expect(row.marketBoostUntil!.getTime()).toBeGreaterThanOrEqual(before + TOWN_MARKET_DAY_MS)
        expect(row.marketBoostUntil!.getTime()).toBeLessThanOrEqual(Date.now() + TOWN_MARKET_DAY_MS)
        // A town that sells nothing yet still gets the streak's income floor.
        expect(row.marketBoostBonusLeft).toBe(TOWN_STREAK_MIN_INCOME_PER_DAY)
        expect(row.boosters).toEqual({})
        expect(() => startTownBooster(OWNER, 'market')).toThrow(/No booster/)
        expect(() => startTownBooster(OWNER, 'production')).toThrow(/No booster/)
    })

    it('starts a stored production surge for 12 hours, and lengthens a running one', async () => {
        writeTx(tx => addTownBoosters(tx, OWNER, { production: 2 }))
        const before = Date.now()
        startTownBooster(OWNER, 'production')
        startTownBooster(OWNER, 'production')
        const until = (await stateRow()).productionBoostUntil!.getTime()
        expect(until).toBeGreaterThanOrEqual(before + 2 * TOWN_BOOST_MS)
        expect(until).toBeLessThanOrEqual(Date.now() + 2 * TOWN_BOOST_MS)
    })
})
