import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import { db, writeTx, type DbExecutor, type Tx } from '#server/database'
import { polytownBuildings, polytownStreak } from '#server/database/schema'
import type { TownResourceId } from '#shared/polytown/town'
import {
    TOWN_STREAK_DAYS,
    TOWN_STREAK_TRACK,
    claimTownStreakReward,
    getTownStreakStep,
    townStreakOpensChest,
    isValidTownStreakStep,
    lockTownStreakStep,
    sumTownStreakRewards,
    townStreakBit,
    townStreakCanReset,
    townStreakClaimable,
    townStreakClaimedSteps,
    townStreakDayKey,
    townStreakDue,
    townStreakIsClaimed,
    townStreakNextDayAt,
    townStreakPreview,
    townStreakScale,
    townStreakStatus,
    type TownStreakLock,
    type TownStreakReward,
    type TownStreakStepDef,
    type TownStreakScale
} from '#shared/polytown/town-streak'
import { addInventory, addTownBoosters, creditTownCoins, finishLongestTownJobs, getPlotMap, getTownCoins, getTownState, settleTownState, toSim, townInstantJobs } from './town'

type StreakRow = typeof polytownStreak.$inferSelect

function fail(statusMessage: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage })
}

function readStreak(playerId: string, ex: DbExecutor = db) {
    return ex.select().from(polytownStreak).where(eq(polytownStreak.playerId, playerId)).get()
}

/**
 * Unlock today's step if it is due. Both writes are their own guard: the
 * insert only lands for the first visit ever, and the update only matches a
 * row whose last unlock was before today, so two tabs opening at once advance
 * it once and only the request that wrote it reports `advanced`.
 */
function advanceStreak(playerId: string, now: number, scale: TownStreakScale): { row: StreakRow, advanced: boolean } {
    const today = townStreakDayKey(now)
    const existing = readStreak(playerId)
    if (!existing) {
        const inserted = db.insert(polytownStreak)
            .values({ playerId, step: 1, lastDay: today, claimed: 0, cycle: 0, locked: lockedFor(1, scale), updatedAt: new Date(now) })
            .onConflictDoNothing()
            .returning()
            .get()
        if (inserted) return { row: inserted, advanced: true }
        return { row: readStreak(playerId)!, advanced: false }
    }
    if (!townStreakDue(existing, today)) return { row: existing, advanced: false }

    // Pinned to the step read above, so the step whose worth is locked is the one unlocked.
    const next = existing.step + 1
    const entry = lockedFor(next, scale)[next]
    const updated = db.update(polytownStreak)
        .set({
            step: next,
            lastDay: today,
            locked: entry ? sql`json_set(${polytownStreak.locked}, ${`$."${next}"`}, json(${JSON.stringify(entry)}))` : sql`${polytownStreak.locked}`,
            updatedAt: new Date(now)
        })
        .where(and(
            eq(polytownStreak.playerId, playerId),
            eq(polytownStreak.step, existing.step),
            lt(polytownStreak.step, TOWN_STREAK_DAYS),
            or(lt(polytownStreak.lastDay, today), isNull(polytownStreak.lastDay))
        ))
        .returning()
        .get()
    if (updated) return { row: updated, advanced: true }
    return { row: readStreak(playerId)!, advanced: false }
}

/** The lock entry for a step that just unlocked: its worth, fixed from today's town. */
function lockedFor(step: number, scale: TownStreakScale): Record<string, TownStreakLock> {
    const def = getTownStreakStep(step)
    return def ? { [step]: lockTownStreakStep(def, scale) } : {}
}

/** Read-only scale for the preview and for locking a step: no settle. */
function previewScale(playerId: string, happiness: number, now: number) {
    const rows = db.select().from(polytownBuildings).where(eq(polytownBuildings.playerId, playerId)).all()
    const { byId } = getPlotMap(playerId)
    return townStreakScale(rows.map(row => toSim(row, byId.get(row.plotId))), happiness, now)
}

export function getTownStreak(playerId: string) {
    const now = Date.now()
    const state = getTownState(playerId)
    if (!state) return { initialized: false as const }

    const scale = previewScale(playerId, state.happiness, now)
    const { row, advanced } = advanceStreak(playerId, now, scale)
    const today = townStreakDayKey(now)

    return {
        initialized: true as const,
        day: today,
        step: row.step,
        status: townStreakStatus(row),
        cycle: row.cycle,
        claimedSteps: townStreakClaimedSteps(row.claimed),
        claimableSteps: townStreakClaimable(row.step, row.claimed),
        canReset: townStreakCanReset(row),
        advancedToday: advanced,
        /** Lucky charges waiting: the next chest opened is one tier better. */
        lucky: row.lucky,
        serverNow: now,
        nextDayAt: townStreakNextDayAt(now),
        // Unlocked steps show what they were locked at; the rest follow the town as it is now.
        track: TOWN_STREAK_TRACK.map(def => townStreakPreview(def, scale, def.step <= row.step ? row.locked[def.step] : undefined))
    }
}

function payReward(tx: Tx, playerId: string, reward: Pick<TownStreakReward, 'coins' | 'resources' | 'boosters'>) {
    if (reward.coins > 0) creditTownCoins(tx, playerId, reward.coins)
    addTownBoosters(tx, playerId, reward.boosters)
    for (const [id, qty] of Object.entries(reward.resources) as [TownResourceId, number][]) {
        if (qty > 0) addInventory(tx, playerId, id, qty)
    }
}

/**
 * Open (or pay) one step inside the claim transaction. A chest spends a lucky
 * charge with a conditional decrement, so two chests can never both use the
 * same one. An instant finish completes the longest job at once; boosters go
 * into the store; a lucky extra adds a charge for the next chest.
 */
function openStep(tx: Tx, playerId: string, def: TownStreakStepDef, lock: TownStreakLock | undefined, scale: TownStreakScale, now: number): TownStreakReward {
    let lucky = false
    let instantJobs = 0
    if (townStreakOpensChest(def, lock)) {
        const spent = tx.update(polytownStreak)
            .set({ lucky: sql`${polytownStreak.lucky} - 1` })
            .where(and(eq(polytownStreak.playerId, playerId), gt(polytownStreak.lucky, 0)))
            .returning({ lucky: polytownStreak.lucky })
            .get()
        lucky = !!spent
        instantJobs = townInstantJobs(tx, playerId, now).length
    }
    const reward = claimTownStreakReward(def, lock, scale, undefined, { lucky, instantJobs })
    payReward(tx, playerId, reward)

    const extras = reward.extras ?? []
    const count = (kind: string) => extras.filter(e => e.kind === kind).length
    const finished = finishLongestTownJobs(tx, playerId, count('instant'), now)
    let next = 0
    for (const extra of extras) {
        if (extra.kind === 'instant') {
            const done = finished[next++]
            if (done) Object.assign(extra, done)
        }
    }
    const charges = count('lucky')
    if (charges > 0) {
        tx.update(polytownStreak).set({ lucky: sql`${polytownStreak.lucky} + ${charges}` }).where(eq(polytownStreak.playerId, playerId)).run()
    }
    return reward
}

function wallet(tx: DbExecutor, playerId: string) {
    return { balance: getTownCoins(playerId, tx) }
}

/**
 * Claim-then-reward. The conditional OR on the claimed mask is the mutex: a
 * second claim of the same step matches no row and pays nothing.
 */
export function claimTownStreakStep(playerId: string, step: unknown) {
    if (!isValidTownStreakStep(step)) fail('Unknown day')
    const def = getTownStreakStep(step)!
    const bit = townStreakBit(step)

    return writeTx((tx) => {
        const now = Date.now()
        const settled = settleTownState(tx, playerId, now)
        const claimed = tx.update(polytownStreak)
            .set({ claimed: sql`${polytownStreak.claimed} | ${bit}`, updatedAt: new Date(now) })
            .where(and(
                eq(polytownStreak.playerId, playerId),
                sql`(${polytownStreak.claimed} & ${bit}) = 0`,
                sql`${polytownStreak.step} >= ${step}`
            ))
            .returning({ step: polytownStreak.step, locked: polytownStreak.locked })
            .get()
        if (!claimed) {
            const row = readStreak(playerId, tx)
            const already = row && townStreakIsClaimed(row.claimed, step)
            fail(already ? 'Already claimed' : 'That day is still locked')
        }

        const scale = townStreakScale(settled.sim, settled.state.happiness, now)
        const reward = openStep(tx, playerId, def, claimed.locked[step], scale, now)
        return { step, reward, ...wallet(tx, playerId) }
    })
}

/**
 * Only a finished track resets: re-checked inside the writeTx, every
 * unclaimed step is paid, and the run starts again with today as day 1
 * (tomorrow, if today unlocked day 30). A second reset finds an active track
 * and throws, so nothing is paid twice.
 */
export function resetTownStreak(playerId: string) {
    return writeTx((tx) => {
        const now = Date.now()
        const today = townStreakDayKey(now)
        const settled = settleTownState(tx, playerId, now)
        const row = readStreak(playerId, tx)
        if (!row) fail('No streak to reset')
        if (!townStreakCanReset(row)) fail('The streak is still running')

        const scale = townStreakScale(settled.sim, settled.state.happiness, now)
        // One step at a time, so a lucky charge or instant finish from one chest is there for the next.
        const paid: TownStreakReward[] = []
        for (const s of townStreakClaimable(row.step, row.claimed)) {
            paid.push(openStep(tx, playerId, getTownStreakStep(s)!, row.locked[s], scale, now))
        }
        const total = sumTownStreakRewards(paid)

        // A track that finished today already unlocked today's step, so day 1 waits for tomorrow.
        const step = row.lastDay === today ? 0 : 1
        tx.update(polytownStreak)
            .set({ step, lastDay: today, claimed: 0, cycle: row.cycle + 1, locked: step ? lockedFor(step, scale) : {}, updatedAt: new Date(now) })
            .where(eq(polytownStreak.playerId, playerId))
            .run()
        return { paid, total, ...wallet(tx, playerId) }
    })
}
