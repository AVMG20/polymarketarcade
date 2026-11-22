import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '#server/database'
import { polytownState, polytownStreak } from '#server/database/schema'
import { townBoosterCount } from '#shared/polytown/town-boosts'
import {
    deleteTownForPlayer
} from '#server/utils/polytown/town'
import { claimTownStreakStep, getTownStreak, resetTownStreak } from '#server/utils/polytown/streak'
import { TOWN_STREAK_CHESTS, TOWN_STREAK_DAYS, getTownStreakStep, townStreakBit, townStreakDayBoosters, townStreakDayKey, townStreakYesterday } from '#shared/polytown/town-streak'
import { SKIP, burst, caught, cleanupUser, foundTown, lockTownRealm, seedUser } from './db-helpers'

const OWNER = 'test-town-streak-owner'

/** Boosters a day pays for certain (the old site's gem days and the boost days). */
function boostersOn(step: number) {
    const def = getTownStreakStep(step)
    return def ? townBoosterCount(townStreakDayBoosters(def)) : 0
}
const DAY4_BOOSTERS = boostersOn(4)

/** Claimed mask with every step from `step` to 30 set, so only the ones before it are left. */
function claimedFrom(step: number) {
    let mask = 0
    for (let s = step; s <= TOWN_STREAK_DAYS; s++) mask |= townStreakBit(s)
    return mask
}

async function cleanup() {
    await db.delete(polytownStreak).where(eq(polytownStreak.playerId, OWNER))
    await deleteTownForPlayer(OWNER)
    await cleanupUser(OWNER)
}

async function streakRow() {
    const [row] = await db.select().from(polytownStreak).where(eq(polytownStreak.playerId, OWNER))
    return row!
}

/** The town's coins and how many boosters it holds (the old site's balance and gems). */
async function wallet() {
    const row = db.select({ cents: polytownState.coinsCents, boosters: polytownState.boosters }).from(polytownState).where(eq(polytownState.playerId, OWNER)).get()
    return { balance: row!.cents / 100, boosters: townBoosterCount(row!.boosters) }
}

describe.skipIf(SKIP)('Polytown mayor streak (database)', () => {
    let releaseRealm: () => Promise<void>
    beforeAll(async () => {
        releaseRealm = await lockTownRealm()
        await cleanup()
    }, 120_000)

    beforeEach(async () => {
        await seedUser(OWNER, { balance: '100000000', gems: 0 })
        await foundTown(OWNER)
    })
    afterEach(cleanup)
    afterAll(async () => { await releaseRealm() })

    it('unlocks day 1 once, then advances once a day and once after missed days, however many requests race', async () => {
        const first = await Promise.all(Array.from({ length: 8 }, async () => getTownStreak(OWNER)))
        expect(first.filter(r => r.initialized && r.advancedToday)).toHaveLength(1)
        expect((await streakRow()).step).toBe(1)

        const today = townStreakDayKey(Date.now())
        await db.update(polytownStreak).set({ step: 4, lastDay: townStreakYesterday(today) }).where(eq(polytownStreak.playerId, OWNER))
        const results = await Promise.all(Array.from({ length: 8 }, async () => getTownStreak(OWNER)))
        expect(results.filter(r => r.initialized && r.advancedToday)).toHaveLength(1)
        const advanced = await streakRow()
        expect(advanced.step).toBe(5)
        // Day 1 from the first visit, day 5 from the advance: the burst locked exactly the step it unlocked.
        expect(Object.keys(advanced.locked).sort()).toEqual(['1', '5'])
        expect(advanced.locked['5']?.reward).toBeDefined()

        await db.update(polytownStreak).set({ lastDay: townStreakYesterday(townStreakYesterday(today)) }).where(eq(polytownStreak.playerId, OWNER))
        const late = await Promise.all(Array.from({ length: 8 }, async () => getTownStreak(OWNER)))
        expect(late.filter(r => r.initialized && r.advancedToday)).toHaveLength(1)
        expect(late[0]!.initialized && late[0]!.status).toBe('active')
        expect((await streakRow()).step).toBe(6)
    })

    it('pays a claimed step once under a burst, at the reward locked when it unlocked', async () => {
        await getTownStreak(OWNER)
        const locked = (await streakRow()).locked['1']
        expect(locked?.reward?.coins).toBeGreaterThan(0)
        // Pretend the town got much richer since: the lock, not the town, decides the payout.
        await db.update(polytownStreak).set({ step: 4, locked: { 1: { ...locked!, reward: { ...locked!.reward!, coins: 12_345 } } } }).where(eq(polytownStreak.playerId, OWNER))
        const before = await wallet()
        await claimTownStreakStep(OWNER, 1)
        expect((await wallet()).balance - before.balance).toBeCloseTo(12_345, 0)

        const { ok } = await burst(10, () => claimTownStreakStep(OWNER, 4))
        expect(ok).toBe(1)
        expect((await wallet()).boosters - before.boosters).toBe(DAY4_BOOSTERS)
        expect((await streakRow()).claimed).toBe(townStreakBit(1) | townStreakBit(4))
    })

    it('refuses a locked step, and refuses to reset an active track', async () => {
        await getTownStreak(OWNER)
        expect(caught(() => claimTownStreakStep(OWNER, 2))).toMatchObject({ statusCode: 400 })
        expect(caught(() => claimTownStreakStep(OWNER, 0))).toMatchObject({ statusCode: 400 })
        expect(caught(() => resetTownStreak(OWNER))).toMatchObject({ statusCode: 400 })
    })

    it('resets a finished track once, paying every unclaimed step', async () => {
        await getTownStreak(OWNER)
        const today = townStreakDayKey(Date.now())
        await db.update(polytownStreak)
            .set({ step: 30, lastDay: townStreakYesterday(townStreakYesterday(today)), claimed: claimedFrom(1) })
            .where(eq(polytownStreak.playerId, OWNER))
        resetTownStreak(OWNER)
        const row = await streakRow()
        expect(row).toMatchObject({ step: 1, lastDay: today, claimed: 0, cycle: 1 })
        expect(Object.keys(row.locked)).toEqual(['1'])

        await db.update(polytownStreak)
            .set({ step: 30, lastDay: townStreakYesterday(townStreakYesterday(today)), claimed: claimedFrom(11) })
            .where(eq(polytownStreak.playerId, OWNER))
        const before = await wallet()
        const { ok } = await burst(6, () => resetTownStreak(OWNER))
        expect(ok).toBe(1)
        const after = await wallet()
        // Days 4, 9 and 10 pay boosters among the first ten, plus whatever the day 7 chest holds.
        let fixed = 0
        for (let day = 1; day <= 10; day++) fixed += boostersOn(day)
        const chest = TOWN_STREAK_CHESTS.wooden
        expect(after.boosters - before.boosters).toBeGreaterThanOrEqual(fixed + chest.boosters[0])
        expect(after.boosters - before.boosters).toBeLessThanOrEqual(fixed + chest.boosters[1] + chest.extras.slots)
        expect((await streakRow()).cycle).toBe(2)
    })

    it('never pays a step to both a claim and a reset racing it', async () => {
        await getTownStreak(OWNER)
        const today = townStreakDayKey(Date.now())
        // Days 1 to 6 are left unclaimed: they hold boosters only on day 4, and no chest.
        await db.update(polytownStreak)
            .set({ step: 30, lastDay: townStreakYesterday(townStreakYesterday(today)), claimed: claimedFrom(7) })
            .where(eq(polytownStreak.playerId, OWNER))
        const before = await wallet()
        await Promise.allSettled([
            ...Array.from({ length: 5 }, async () => claimTownStreakStep(OWNER, 4)),
            ...Array.from({ length: 3 }, async () => resetTownStreak(OWNER))
        ])
        expect((await wallet()).boosters - before.boosters).toBe(DAY4_BOOSTERS)
        expect((await streakRow()).cycle).toBe(1)
    })

    it('does not unlock day 1 on the day that unlocked day 30', async () => {
        await getTownStreak(OWNER)
        const today = townStreakDayKey(Date.now())
        await db.update(polytownStreak).set({ step: 30, lastDay: today, claimed: 0 }).where(eq(polytownStreak.playerId, OWNER))
        await resetTownStreak(OWNER)
        expect(await streakRow()).toMatchObject({ step: 0, lastDay: today, claimed: 0, cycle: 1 })
        expect((await streakRow()).locked).toEqual({})
        expect(caught(() => claimTownStreakStep(OWNER, 1))).toMatchObject({ statusCode: 400 })

        // The next day's visit unlocks day 1 and locks it.
        await db.update(polytownStreak).set({ lastDay: townStreakYesterday(today) }).where(eq(polytownStreak.playerId, OWNER))
        await getTownStreak(OWNER)
        const restarted = await streakRow()
        expect(restarted.step).toBe(1)
        expect(Object.keys(restarted.locked)).toEqual(['1'])

        // Finished on an earlier day: today's visit counts as day 1.
        await db.update(polytownStreak).set({ step: 30, lastDay: townStreakYesterday(today) }).where(eq(polytownStreak.playerId, OWNER))
        await resetTownStreak(OWNER)
        expect(await streakRow()).toMatchObject({ step: 1, lastDay: today, cycle: 2 })
        expect(Object.keys((await streakRow()).locked)).toEqual(['1'])
    })
})
