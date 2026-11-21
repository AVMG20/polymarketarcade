import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { db, writeTx } from '#server/database'
import { shapezzState } from '#server/database/schema'
import {
    shapezzDefeatSalvage,
    shapezzPermanentUpgradeCost,
    shapezzRunOffer,
    shapezzWeaponPrice,
    shapezzWeaponReplacement
} from '#shared/shapezz/economy'
import {
    SHAPEZZ_CHECKPOINT_MS,
    SHAPEZZ_DIFFICULTY_IDS,
    SHAPEZZ_PERMANENT_UPGRADE_IDS,
    SHAPEZZ_WEAPON_RARITIES,
    SHAPEZZ_WEAPON_TYPES,
    shapezzCheckpointCount,
    shapezzDifficulty,
    shapezzPlayerStats,
    shapezzPower,
    shapezzWeapon,
    type ShapezzDifficultyId,
    type ShapezzPermanentLevels,
    type ShapezzPermanentUpgradeId,
    type ShapezzWeaponRarity,
    type ShapezzWeaponType
} from '#shared/shapezz/rules'

export type ShapezzStateRow = typeof shapezzState.$inferSelect

/** The player's save, created on first visit (a parallel first visit reads the winner's row). */
export function getShapezzState(playerId: string): ShapezzStateRow {
    const existing = db.select().from(shapezzState).where(eq(shapezzState.playerId, playerId)).get()
    if (existing) return existing
    db.insert(shapezzState).values({ playerId }).onConflictDoNothing().run()
    return db.select().from(shapezzState).where(eq(shapezzState.playerId, playerId)).get()!
}

export function shapezzLevels(state: ShapezzStateRow): ShapezzPermanentLevels {
    return {
        core: state.coreLevel,
        overclock: state.overclockLevel,
        armor: state.armorLevel,
        thrusters: state.thrustersLevel,
        magnet: state.magnetLevel,
        killHeal: state.killHealLevel
    }
}

const LEVEL_COLUMN = {
    core: 'coreLevel',
    overclock: 'overclockLevel',
    armor: 'armorLevel',
    thrusters: 'thrustersLevel',
    magnet: 'magnetLevel',
    killHeal: 'killHealLevel'
} as const satisfies Record<ShapezzPermanentUpgradeId, keyof ShapezzStateRow>

const WEAPON_COLUMNS = {
    blaster: { rarity: 'blasterRarity', price: 'blasterPrice' },
    launcher: { rarity: 'launcherRarity', price: 'launcherPrice' },
    shotgun: { rarity: 'shotgunRarity', price: 'shotgunPrice' },
    arcCoil: { rarity: 'arcCoilRarity', price: 'arcCoilPrice' },
    railgun: { rarity: 'railgunRarity', price: 'railgunPrice' }
} as const satisfies Record<ShapezzWeaponType, { rarity: keyof ShapezzStateRow, price: keyof ShapezzStateRow }>

/** Owned rarity (null: not owned) and what was paid, per weapon type. */
export function shapezzArsenal(state: ShapezzStateRow): Record<ShapezzWeaponType, { rarity: ShapezzWeaponRarity | null, price: number }> {
    return Object.fromEntries(SHAPEZZ_WEAPON_TYPES.map((type) => {
        const columns = WEAPON_COLUMNS[type]
        return [type, { rarity: state[columns.rarity] as ShapezzWeaponRarity | null, price: state[columns.price] }]
    })) as Record<ShapezzWeaponType, { rarity: ShapezzWeaponRarity | null, price: number }>
}

export function shapezzEquippedWeapon(state: ShapezzStateRow) {
    const type = state.weaponType as ShapezzWeaponType
    return shapezzWeapon(type, shapezzArsenal(state)[type]?.rarity ?? 'common')
}

function fail(statusMessage: string): never {
    throw createError({ statusCode: 400, statusMessage })
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export function startShapezzRun(playerId: string, difficultyId: unknown) {
    if (!SHAPEZZ_DIFFICULTY_IDS.includes(difficultyId as ShapezzDifficultyId)) fail('Invalid difficulty')
    const state = getShapezzState(playerId)
    const levels = shapezzLevels(state)
    const weapon = shapezzEquippedWeapon(state)
    const power = shapezzPower(levels, weapon)
    const runId = crypto.randomUUID()
    const startedAt = new Date()
    // Only one run at a time: the null check on run_id is the guard.
    const started = db.update(shapezzState)
        .set({ runId, runStartedAt: startedAt, runDifficulty: difficultyId as string, runPower: power, updatedAt: startedAt })
        .where(and(eq(shapezzState.playerId, playerId), isNull(shapezzState.runId)))
        .returning({ runId: shapezzState.runId })
        .get()
    if (!started) fail('A run is already active')
    return {
        runId,
        startedAt,
        difficulty: shapezzDifficulty(difficultyId),
        checkpointMs: SHAPEZZ_CHECKPOINT_MS,
        power,
        stats: shapezzPlayerStats(levels),
        weapon
    }
}

export type ShapezzFinishReason = 'cashout' | 'defeat' | 'abandoned'

export interface ShapezzRunReport {
    reason: ShapezzFinishReason
    elapsedMs: number
    loot: number
    kills: number
}

export interface ShapezzRunRecords {
    runStartedAt: Date
    runDifficulty: string | null
    runsPlayed: number
    totalShardsEarned: number
    bestSurvivalMs: number
    bestKills: number
    bestCheckpoint: number
}

/** Most kills a run can plausibly report per second of play (stat sanity, not pay). */
const MAX_KILLS_PER_SECOND = 40

/**
 * What a finished run earns and records. Pure: the server's clock and what it
 * stored at start decide; the client's report is only believed up to what the
 * clock and the difficulty allow. A cash-out counts only at a completed
 * checkpoint; a defeat salvages a share; an abandoned run (the page closed)
 * clears the lock and records nothing.
 */
export function settleShapezzRun(state: ShapezzRunRecords, report: ShapezzRunReport, now: number) {
    const wallMs = Math.max(0, now - state.runStartedAt.getTime())
    const abandoned = report.reason === 'abandoned'
    const elapsedMs = abandoned ? 0 : Math.max(0, Math.min(report.elapsedMs, wallMs + 3000, 60 * 60_000))
    const difficulty = shapezzDifficulty(state.runDifficulty).id
    const checkpoint = shapezzCheckpointCount(elapsedMs + 1000)
    const kills = Math.min(Math.max(0, report.kills), Math.ceil(elapsedMs / 1000 * MAX_KILLS_PER_SECOND))
    const offer = abandoned ? 0 : shapezzRunOffer(report.loot, elapsedMs, difficulty)
    const cashout = report.reason === 'cashout' && checkpoint >= 1
    const awarded = cashout ? offer : abandoned ? 0 : shapezzDefeatSalvage(offer)
    return {
        runsPlayed: abandoned ? state.runsPlayed : state.runsPlayed + 1,
        totalShardsEarned: state.totalShardsEarned + awarded,
        bestSurvivalMs: abandoned ? state.bestSurvivalMs : Math.max(state.bestSurvivalMs, elapsedMs),
        bestKills: abandoned ? state.bestKills : Math.max(state.bestKills, kills),
        bestCheckpoint: abandoned ? state.bestCheckpoint : Math.max(state.bestCheckpoint, checkpoint),
        difficulty: difficulty as ShapezzDifficultyId,
        elapsedMs,
        checkpoint,
        kills,
        offer,
        awarded,
        cashout
    }
}

function reportNumber(value: unknown, max: number) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0
}

export function parseShapezzReport(body: Record<string, unknown> | null | undefined): ShapezzRunReport & { runId: string } {
    const reason = body?.reason
    if (reason !== 'cashout' && reason !== 'defeat' && reason !== 'abandoned') fail('Invalid reason')
    if (typeof body?.runId !== 'string' || body.runId.length > 64) fail('Missing runId')
    return {
        runId: body.runId,
        reason,
        elapsedMs: reportNumber(body.elapsedMs, 60 * 60_000),
        loot: reportNumber(body.loot, 1_000_000_000),
        kills: reportNumber(body.kills, 1_000_000)
    }
}

/**
 * Settle the run `runId` once. Clearing run_id where it still equals `runId`
 * is the guard: a replay, a second tab or a stale page gets no row and a 400.
 */
export function finishShapezzRun(playerId: string, report: ShapezzRunReport & { runId: string }, now = Date.now()) {
    return writeTx((tx) => {
        const state = tx.select().from(shapezzState)
            .where(and(eq(shapezzState.playerId, playerId), eq(shapezzState.runId, report.runId))).get()
        if (!state?.runStartedAt) fail('No active run')
        const result = settleShapezzRun({ ...state, runStartedAt: state.runStartedAt }, report, now)
        const claimed = tx.update(shapezzState).set({
            runId: null,
            runStartedAt: null,
            runDifficulty: null,
            runPower: null,
            shards: sql`${shapezzState.shards} + ${result.awarded}`,
            runsPlayed: result.runsPlayed,
            totalShardsEarned: result.totalShardsEarned,
            bestSurvivalMs: result.bestSurvivalMs,
            bestKills: result.bestKills,
            bestCheckpoint: result.bestCheckpoint,
            updatedAt: new Date(now)
        }).where(and(eq(shapezzState.playerId, playerId), eq(shapezzState.runId, report.runId)))
            .returning({ shards: shapezzState.shards })
            .get()
        if (!claimed) fail('No active run')
        return { ...result, shards: claimed.shards }
    })
}

// ─── Workshop ───────────────────────────────────────────────────────────────

/**
 * Buy the next level of a chassis track. One guarded update: the level must
 * still be the one priced, the balance must cover it and no run may be active.
 */
export function buyShapezzUpgrade(playerId: string, upgradeId: unknown) {
    if (!SHAPEZZ_PERMANENT_UPGRADE_IDS.includes(upgradeId as ShapezzPermanentUpgradeId)) fail('Invalid upgrade')
    const id = upgradeId as ShapezzPermanentUpgradeId
    const column = LEVEL_COLUMN[id]
    const state = getShapezzState(playerId)
    if (state.runId) fail('Finish your run first')
    const level = state[column]
    const cost = shapezzPermanentUpgradeCost(id, level)
    if (cost === null) fail('Already maxed')
    const bought = db.update(shapezzState)
        .set({ shards: sql`${shapezzState.shards} - ${cost}`, [column]: level + 1, updatedAt: new Date() })
        .where(and(
            eq(shapezzState.playerId, playerId),
            eq(shapezzState[column], level),
            gte(shapezzState.shards, cost),
            isNull(shapezzState.runId)
        ))
        .returning({ shards: shapezzState.shards })
        .get()
    if (!bought) fail(state.shards < cost ? 'Not enough shards' : 'Upgrade changed, try again')
    return { upgradeId: id, level: level + 1, cost, shards: bought.shards }
}

/**
 * Buy a higher rarity of a weapon type (and equip it). The previous rarity of
 * that type is traded in for a share of what it cost. The update is guarded on the owned
 * rarity and price it was priced against, and on the balance.
 */
export function buyShapezzWeapon(playerId: string, weaponType: unknown, weaponRarity: unknown) {
    if (!SHAPEZZ_WEAPON_TYPES.includes(weaponType as ShapezzWeaponType) || !SHAPEZZ_WEAPON_RARITIES.includes(weaponRarity as ShapezzWeaponRarity)) {
        fail('Invalid weapon')
    }
    const type = weaponType as ShapezzWeaponType
    const rarity = weaponRarity as ShapezzWeaponRarity
    return writeTx((tx) => {
        const state = tx.select().from(shapezzState).where(eq(shapezzState.playerId, playerId)).get() ?? fail('No save yet')
        if (state.runId) fail('Finish your run first')
        const owned = shapezzArsenal(state)[type]
        if (owned.rarity !== null && SHAPEZZ_WEAPON_RARITIES.indexOf(rarity) <= SHAPEZZ_WEAPON_RARITIES.indexOf(owned.rarity)) {
            fail('Already owned')
        }
        const price = shapezzWeaponPrice(type, rarity)
        const { refund, netCost } = shapezzWeaponReplacement(owned.rarity === null ? 0 : owned.price, price)
        const columns = WEAPON_COLUMNS[type]
        const bought = tx.update(shapezzState).set({
            shards: sql`${shapezzState.shards} - ${netCost}`,
            weaponType: type,
            [columns.rarity]: rarity,
            [columns.price]: price,
            updatedAt: new Date()
        }).where(and(
            eq(shapezzState.playerId, playerId),
            owned.rarity === null ? isNull(shapezzState[columns.rarity]) : eq(shapezzState[columns.rarity], owned.rarity),
            eq(shapezzState[columns.price], owned.price),
            gte(shapezzState.shards, Math.max(0, netCost)),
            isNull(shapezzState.runId)
        )).returning({ shards: shapezzState.shards }).get()
        if (!bought) fail('Not enough shards')
        return { weapon: shapezzWeapon(type, rarity), refund, netCost, shards: bought.shards }
    })
}

export function equipShapezzWeapon(playerId: string, weaponType: unknown) {
    if (!SHAPEZZ_WEAPON_TYPES.includes(weaponType as ShapezzWeaponType)) fail('Invalid weapon')
    const type = weaponType as ShapezzWeaponType
    const state = getShapezzState(playerId)
    if (state.runId) fail('Finish your run first')
    const owned = shapezzArsenal(state)[type]
    if (owned.rarity === null) fail('Not owned')
    db.update(shapezzState).set({ weaponType: type, updatedAt: new Date() })
        .where(and(eq(shapezzState.playerId, playerId), isNull(shapezzState.runId))).run()
    return { weapon: shapezzWeapon(type, owned.rarity) }
}
