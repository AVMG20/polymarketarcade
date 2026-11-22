import { and, asc, desc, eq, gte, inArray, lte, ne, notInArray, or, sql, isNull } from 'drizzle-orm'
import { db, writeTx, type DbExecutor, type Tx } from '#server/database'
import {
    players,
    polytownBuildings,
    polytownContractDays,
    polytownContracts,
    polytownEvents,
    polytownInventory,
    polytownOrders,
    polytownPlots,
    polytownProduction,
    polytownRedesignDrafts,
    polytownState,
    polytownStorage,
    polytownTrades
} from '#server/database/schema'
import { pruneTownEvents, recordTownEvent } from './events'
import { matchTownOrder } from '#shared/polytown/order-book'
import {
    TOWN_PLOT_SIZE,
    TOWN_MAX_OFFLINE_MS,
    TOWN_MAX_PLOTS,
    TOWN_STARTER_COINS,
    townBuildingMaxLevel,
    TOWN_MARKET_MAX_OPEN_ORDERS,
    TOWN_MARKET_HISTORY_LIMIT,
    TOWN_MARKET_BOOK_DEPTH,
    TOWN_MARKET_MIN_PRICE,
    TOWN_RESOURCES,
    getTownBuilding,
    getTownResource,
    isTownResourceId,
    townLevelCost,
    townLevelBuildMs,
    townPlotCooldownMs,
    townPlotPrice,
    townPlotRefundFor,
    isValidTownListPrice,
    TOWN_FOUNDING_GAP,
    townSpiralCoords,
    townPlotIsFlat,
    townFloorPrice,
    type TownBonus,
    townMonumentBonus,
    townMonumentJob,
    townCeilingPrice,
    TOWN_MAX_ORDER_PRICE,
    townOrderTotal,
    isValidTownPrice,
    isValidTownQuantity,
    settleTown,
    deriveTown,
    townTierRequirement,
    townPlaceCost,
    townPlacementIssue,
    townGroupMoveIssue,
    TOWN_MAX_DRAG_TILES,
    type TownGroupMove,
    townMilestoneSnapshot,
    townMilestoneComplete,
    townMilestoneChainSize,
    townMilestoneBoosters,
    townAllNeedsSatisfied,
    townFloorIncomePerDay,
    getTownMilestone,
    TOWN_MILESTONES,
    townBuildersFree,
    townBuildingCountIssue,
    type TownResourceId,
    type TownResourceBag,
    type TownSimBuilding,
    type TownSatisfied
} from '#shared/polytown/town'
import { TOWN_MONUMENT_IDS, isTownMonumentId } from '#shared/polytown/town-monuments'
import { townStoredIsJob, type TownRedesignDraft, type TownStoredBuilding } from '#shared/polytown/town-storage'
import {
    TOWN_BOOSTER_KINDS,
    TOWN_BOOSTER_MS,
    isTownBoostActive,
    townAddBoosters,
    townBoostExtend,
    townBoostMultiplier,
    townBoostUntil,
    townBuildBoostedCompletesAt,
    townBuildRushedCompletesAt,
    townCrewCount,
    townMarketBonus,
    townMarketMultiplier,
    type TownBoostBag,
    type TownBoosterKind,
    type TownBoosters
} from '#shared/polytown/town-boosts'
import { TOWN_STREAK_MIN_INCOME_PER_DAY } from '#shared/polytown/town-streak'

/**
 * Polytown on the server, ported from the old site's server/utils/town.ts.
 *
 * Every mutation is one synchronous `writeTx` (BEGIN IMMEDIATE): the write
 * lock is taken up front and held until commit, and nothing else in the
 * process can run while the body does. That replaces the old site's
 * `FOR UPDATE` row locks and advisory locks (plot claims, per-resource books),
 * so the lock-order rules there have no counterpart here. The guards that
 * decide an outcome are still the mutations themselves: conditional debits,
 * `ON CONFLICT DO NOTHING` claims, flag flips and `DELETE … RETURNING`.
 *
 * The old site's balance ledger is replaced by the town's own coins,
 * `polytown_state.coins_cents`; gem perks are bought with platform gems
 * (server/utils/polytown/gems.ts).
 */

type StateRow = typeof polytownState.$inferSelect
type BuildingRow = typeof polytownBuildings.$inferSelect
type PlotRow = typeof polytownPlots.$inferSelect
type StoredRow = typeof polytownStorage.$inferSelect

function fail(statusMessage: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage })
}

// ─── Town coins ──────────────────────────────────────────────────────────────

/** Coins to whole cents, the unit the balance is kept in. */
export function townCents(coins: number): number {
    return Math.round(coins * 100)
}

/**
 * Take coins off the town's balance. The `coins_cents >= ?` guard is the
 * check, so a burst of spends can never take it below zero; throws 400 when
 * the town can't afford it, rolling the transaction back.
 */
export function debitTownCoins(tx: DbExecutor, playerId: string, coins: number) {
    const cents = townCents(coins)
    if (cents <= 0) return
    const row = tx.update(polytownState)
        .set({ coinsCents: sql`${polytownState.coinsCents} - ${cents}` })
        .where(and(eq(polytownState.playerId, playerId), gte(polytownState.coinsCents, cents)))
        .returning({ cents: polytownState.coinsCents })
        .get()
    if (!row) fail('Insufficient balance')
}

/** Put coins on a town's balance. A town that does not exist is a no-op. */
export function creditTownCoins(tx: DbExecutor, playerId: string, coins: number) {
    const cents = townCents(coins)
    if (cents <= 0) return
    tx.update(polytownState)
        .set({ coinsCents: sql`${polytownState.coinsCents} + ${cents}` })
        .where(eq(polytownState.playerId, playerId))
        .run()
}

/** The town's coins, as a number of coins (two decimals). 0 without a town. */
export function getTownCoins(playerId: string, ex: DbExecutor = db): number {
    const row = ex.select({ cents: polytownState.coinsCents }).from(polytownState).where(eq(polytownState.playerId, playerId)).get()
    return (row?.cents ?? 0) / 100
}

// ─── State ───────────────────────────────────────────────────────────────────

export function getTownState(playerId: string, ex: DbExecutor = db): StateRow | undefined {
    return ex.select().from(polytownState).where(eq(polytownState.playerId, playerId)).get()
}

/** Every town mutation starts here, inside its writeTx: the town has to exist. */
function readTownState(tx: DbExecutor, playerId: string): StateRow {
    const row = getTownState(playerId, tx)
    if (!row) fail('Found a town first')
    return row
}

export function getInventory(playerId: string, ex: DbExecutor = db): TownResourceBag {
    const rows = ex.select().from(polytownInventory).where(eq(polytownInventory.playerId, playerId)).all()
    const bag: TownResourceBag = {}
    for (const row of rows) {
        if (isTownResourceId(row.resource)) bag[row.resource] = row.amount
    }
    return bag
}

/**
 * Upsert-increment. Never writes an absolute value, so concurrent fills and
 * settles commute. Both halves floor at zero: a town cannot hold negative
 * stock, and consuming from an empty larder is a no-op, not a debt.
 */
export function addInventory(tx: DbExecutor, playerId: string, resource: TownResourceId, delta: number) {
    if (delta === 0) return
    tx.insert(polytownInventory)
        .values({ playerId, resource, amount: Math.max(0, delta) })
        .onConflictDoUpdate({
            target: [polytownInventory.playerId, polytownInventory.resource],
            set: { amount: sql`max(0, ${polytownInventory.amount} + ${delta})` }
        })
        .run()
}

/** Conditional decrement: the `amount >= qty` guard is the check. Throws 400 if short. */
export function takeInventory(tx: DbExecutor, playerId: string, resource: TownResourceId, qty: number) {
    if (qty <= 0) return
    const row = tx.update(polytownInventory)
        .set({ amount: sql`${polytownInventory.amount} - ${qty}` })
        .where(and(
            eq(polytownInventory.playerId, playerId),
            eq(polytownInventory.resource, resource),
            gte(polytownInventory.amount, qty)
        ))
        .returning({ amount: polytownInventory.amount })
        .get()
    if (!row) {
        const def = getTownResource(resource)
        fail(`Not enough ${def?.name ?? resource}`)
    }
}

export function spendBag(tx: DbExecutor, playerId: string, bag: TownResourceBag) {
    for (const [id, qty] of Object.entries(bag) as [TownResourceId, number][]) {
        takeInventory(tx, playerId, id, qty)
    }
}

export function toSim(row: BuildingRow, plot?: { x: number, y: number }): TownSimBuilding {
    return {
        id: row.id,
        type: row.type as TownSimBuilding['type'],
        level: row.level,
        completesAt: row.completesAt.getTime(),
        upgradingTo: row.upgradingTo,
        createdAt: row.createdAt.getTime(),
        wx: plot ? plot.x * TOWN_PLOT_SIZE + row.tileX : undefined,
        wy: plot ? plot.y * TOWN_PLOT_SIZE + row.tileY : undefined,
        rotation: row.rotation
    }
}

export function getPlotMap(playerId: string, ex: DbExecutor = db) {
    const plots = ex.select().from(polytownPlots).where(eq(polytownPlots.playerId, playerId)).orderBy(asc(polytownPlots.createdAt), asc(polytownPlots.id)).all()
    return { plots, byId: new Map(plots.map(p => [p.id, p])) }
}

export interface SettledTown {
    state: StateRow
    buildings: BuildingRow[]
    plots: PlotRow[]
    sim: TownSimBuilding[]
    inventory: TownResourceBag
    completed: { id: string, level: number }[]
    /** What the settle window produced/consumed, and how long it was: for the welcome-back summary. */
    delta: TownResourceBag
    elapsedMs: number
    /** Which needs the last tick could supply. */
    satisfied: TownSatisfied
    /** What this town's monuments are worth right now, so every timer quoted after the settle uses the same bonus. */
    bonus: TownBonus
    /** The buildings in storage, oldest first. */
    stored: StoredRow[]
}

export function toStored(row: StoredRow): TownStoredBuilding {
    return { id: row.id, type: row.type, level: row.level, upgradingTo: row.upgradingTo, remainingMs: row.remainingMs, storedAt: row.storedAt.getTime() }
}

/**
 * The town hall's price. It is the floor and nothing else: a per-player bonus
 * on top of it was arbitrage against the order book's minimum ask. Kept as a
 * function so every sale path goes through one place.
 */
export function townPriceFor(resource: TownResourceId): number {
    return townFloorPrice(resource)
}

/**
 * Advance the simulation to `now` and persist the result as increments. Must
 * run inside a writeTx; callers then continue their own mutation with the
 * returned (fresh) rows.
 */
export function settleTownState(tx: Tx, playerId: string, now = Date.now()): SettledTown {
    const state = readTownState(tx, playerId)
    const rows = tx.select().from(polytownBuildings).where(eq(polytownBuildings.playerId, playerId)).all()
    const inventory = getInventory(playerId, tx)
    const { plots, byId } = getPlotMap(playerId, tx)
    const simBefore = rows.map(row => toSim(row, byId.get(row.plotId)))

    const result = settleTown({
        happiness: state.happiness,
        tickProgressMs: state.tickProgressMs,
        lastSettledAt: state.lastSettledAt.getTime(),
        inventory,
        buildings: simBefore,
        carry: state.carry,
        productionBoostUntil: state.productionBoostUntil?.getTime() ?? null
    }, now)

    for (const [id, delta] of Object.entries(result.delta) as [TownResourceId, number][]) {
        addInventory(tx, playerId, id, delta)
        inventory[id] = Math.max(0, (inventory[id] ?? 0) + delta)
    }
    // Chart data: what this window made, net per resource.
    const produced = (Object.entries(result.delta) as [TownResourceId, number][]).filter(([, d]) => d > 0)
    const producedTotals: Record<string, number> = { ...state.produced }
    if (produced.length) {
        tx.insert(polytownProduction).values(produced.map(([resource, amount]) => ({
            playerId,
            resource,
            amount,
            fromAt: state.lastSettledAt,
            toAt: new Date(now)
        }))).run()
        for (const [resource, amount] of produced) producedTotals[resource] = (producedTotals[resource] ?? 0) + amount
        // The chart only looks back a week; keep the log from growing forever.
        tx.delete(polytownProduction).where(and(eq(polytownProduction.playerId, playerId), lte(polytownProduction.toAt, new Date(now - 8 * 24 * 3_600_000)))).run()
    }

    const rowById = new Map(rows.map(row => [row.id, row]))
    for (const done of result.completed) {
        tx.update(polytownBuildings)
            .set({ level: done.level, upgradingTo: null })
            .where(eq(polytownBuildings.id, done.id))
            .run()
        // Tell the mayor, dated to when it finished, not when we noticed.
        const row = rowById.get(done.id)
        if (row) {
            recordTownEvent(tx, playerId, {
                kind: row.level === 0 ? 'built' : 'upgraded',
                type: row.type,
                level: done.level
            }, Math.min(row.completesAt.getTime(), now))
        }
    }
    if (result.completed.length) pruneTownEvents(tx, playerId, now)

    const stored = tx.select().from(polytownStorage).where(eq(polytownStorage.playerId, playerId)).orderBy(asc(polytownStorage.storedAt), asc(polytownStorage.id)).all()

    const updated = tx.update(polytownState)
        .set({
            happiness: result.happiness,
            tickProgressMs: result.tickProgressMs,
            lastSettledAt: new Date(now),
            produced: producedTotals,
            carry: result.carry
        })
        .where(eq(polytownState.playerId, playerId))
        .returning()
        .get()!

    const doneMap = new Map(result.completed.map(c => [c.id, c.level]))
    const buildings = rows.map((row) => {
        const level = doneMap.get(row.id)
        return level === undefined ? row : { ...row, level, upgradingTo: null }
    })
    const sim = buildings.map(row => toSim(row, byId.get(row.plotId)))

    return {
        state: updated,
        buildings,
        plots,
        sim,
        inventory,
        completed: result.completed,
        delta: result.delta,
        elapsedMs: Math.min(now - state.lastSettledAt.getTime(), TOWN_MAX_OFFLINE_MS),
        satisfied: result.satisfied,
        bonus: townMonumentBonus(sim, now),
        stored
    }
}

// ─── Boosts ──────────────────────────────────────────────────────────────────

type TownBoostState = Pick<StateRow, 'buildBoostUntil' | 'productionBoostUntil' | 'tempBuilderUntil' | 'marketBoostUntil' | 'marketBoostBonusLeft'>

/** The boosts running at `now`: when each ends (null when off) and what it multiplies by. */
export function townBoostsView(state: TownBoostState, now: number) {
    const build = state.buildBoostUntil?.getTime() ?? null
    const production = state.productionBoostUntil?.getTime() ?? null
    const market = state.marketBoostUntil?.getTime() ?? null
    const marketOn = townBoostUntil(market, now) !== null
    return {
        boosts: { build: townBoostUntil(build, now), production: townBoostUntil(production, now), market: townBoostUntil(market, now) },
        boostMultiplier: { build: townBoostMultiplier(build, now), production: townBoostMultiplier(production, now), market: townMarketMultiplier(market, now) },
        /** Extra coins market day can still pay out; 0 when it is off. */
        marketBonusLeft: marketOn ? state.marketBoostBonusLeft : 0
    }
}

/** Crews this town can put to work at `now`, the borrowed one included. */
export function townCrews(state: Pick<StateRow, 'builders' | 'tempBuilderUntil'>, now: number): number {
    return townCrewCount(state.builders, state.tempBuilderUntil?.getTime(), now)
}

export interface TownBoostGrant extends TownBoostBag {
    /** Borrowed-crew time to add. */
    builder?: number
    /** Market-day time to add, and the bonus budget that comes with it. */
    market?: number
    marketBudget?: number
}

/**
 * Start (or lengthen) boosts, inside the caller's writeTx. The until read here
 * is the one the write extends, so two activations queue up rather than
 * overwrite each other.
 *
 * Production needs only the new end: the caller has settled up to `now`, so
 * the next settle starts inside the surge. A rush also shortens every job
 * still running, by the part of it inside the new window. Jobs started during
 * an earlier window were already shortened for that window, and the new one
 * begins where the old one ends, so nothing is counted twice.
 */
export function activateTownBoosts(tx: Tx, playerId: string, grant: TownBoostGrant | undefined, now: number) {
    const build = Math.max(0, grant?.build ?? 0)
    const production = Math.max(0, grant?.production ?? 0)
    const builder = Math.max(0, grant?.builder ?? 0)
    const market = Math.max(0, grant?.market ?? 0)
    if (build <= 0 && production <= 0 && builder <= 0 && market <= 0) return
    const state = readTownState(tx, playerId)
    const patch: Partial<typeof polytownState.$inferInsert> = {}

    if (production > 0) {
        patch.productionBoostUntil = new Date(townBoostExtend(state.productionBoostUntil?.getTime(), now, production))
    }
    if (builder > 0) {
        patch.tempBuilderUntil = new Date(townBoostExtend(state.tempBuilderUntil?.getTime(), now, builder))
    }
    if (market > 0) {
        // A lapsed market day's unspent budget lapses with it.
        const running = isTownBoostActive(state.marketBoostUntil?.getTime(), now)
        const left = running ? state.marketBoostBonusLeft : 0
        patch.marketBoostUntil = new Date(townBoostExtend(state.marketBoostUntil?.getTime(), now, market))
        patch.marketBoostBonusLeft = Math.round((left + Math.max(0, grant?.marketBudget ?? 0)) * 10_000) / 10_000
    }
    if (build > 0) {
        const windowStart = Math.max(now, state.buildBoostUntil?.getTime() ?? 0)
        patch.buildBoostUntil = new Date(townBoostExtend(state.buildBoostUntil?.getTime(), now, build))
        const running = tx.select({ id: polytownBuildings.id, completesAt: polytownBuildings.completesAt })
            .from(polytownBuildings)
            .where(and(
                eq(polytownBuildings.playerId, playerId),
                gte(polytownBuildings.completesAt, new Date(windowStart)),
                sql`(${polytownBuildings.level} = 0 or ${polytownBuildings.upgradingTo} is not null)`
            ))
            .all()
        for (const job of running) {
            const completesAt = townBuildRushedCompletesAt(job.completesAt.getTime(), windowStart, build)
            if (completesAt === job.completesAt.getTime()) continue
            tx.update(polytownBuildings).set({ completesAt: new Date(completesAt) }).where(eq(polytownBuildings.id, job.id)).run()
        }
    }
    tx.update(polytownState).set(patch).where(eq(polytownState.playerId, playerId)).run()
}

/** Put boosters into the town's store, inside the caller's writeTx. */
export function addTownBoosters(tx: Tx, playerId: string, boosters: TownBoosters | null | undefined) {
    if (!boosters || !TOWN_BOOSTER_KINDS.some(kind => (boosters[kind] ?? 0) > 0)) return
    const state = readTownState(tx, playerId)
    tx.update(polytownState).set({ boosters: townAddBoosters(state.boosters, boosters) }).where(eq(polytownState.playerId, playerId)).run()
}

/** The market-day budget one booster brings: a day of the town's floor income, as the old streak's market days did. */
export function townMarketDayBudget(settled: Pick<SettledTown, 'sim' | 'state'>, now: number): number {
    return Math.round(Math.max(TOWN_STREAK_MIN_INCOME_PER_DAY, townFloorIncomePerDay(settled.sim, settled.state.happiness, now)))
}

/**
 * Start one stored booster. The settle and the store both run inside one
 * writeTx, so a burst of starts takes one booster each and the last one that
 * finds the store empty fails.
 */
export function startTownBooster(playerId: string, kind: TownBoosterKind) {
    return writeTx((tx) => {
        const now = Date.now()
        const settled = settleTownState(tx, playerId, now)
        const held = Math.max(0, Math.floor(settled.state.boosters[kind] ?? 0))
        if (held < 1) fail('No booster of that kind left')
        const next = { ...settled.state.boosters, [kind]: held - 1 }
        if (next[kind] === 0) delete next[kind]
        tx.update(polytownState).set({ boosters: next }).where(eq(polytownState.playerId, playerId)).run()
        startBooster(tx, playerId, kind, settled, now)
        return { kind, boosters: next }
    })
}

/** Run one booster's boost from `now`, inside the caller's writeTx (its town already settled). */
export function startBooster(tx: Tx, playerId: string, kind: TownBoosterKind, settled: Pick<SettledTown, 'sim' | 'state'>, now: number) {
    const ms = TOWN_BOOSTER_MS[kind]
    if (kind === 'market') activateTownBoosts(tx, playerId, { market: ms, marketBudget: townMarketDayBudget(settled, now) }, now)
    else activateTownBoosts(tx, playerId, { [kind]: ms }, now)
}

/**
 * Running jobs an instant finish may complete, longest left first: builds and
 * upgrades, never a monument stage. Call inside the caller's writeTx.
 */
export function townInstantJobs(tx: DbExecutor, playerId: string, now: number) {
    return tx.select().from(polytownBuildings).where(and(
        eq(polytownBuildings.playerId, playerId),
        gte(polytownBuildings.completesAt, new Date(now + 1)),
        sql`(${polytownBuildings.level} = 0 or ${polytownBuildings.upgradingTo} is not null)`,
        NOT_A_MONUMENT
    )).orderBy(desc(polytownBuildings.completesAt)).all()
}

/** Finish the `count` running jobs with the most time left, as a free rush would. */
export function finishLongestTownJobs(tx: Tx, playerId: string, count: number, now: number) {
    if (count <= 0) return []
    readTownState(tx, playerId)
    const jobs = townInstantJobs(tx, playerId, now).slice(0, count)
    const done: { buildingId: string, type: string, level: number, savedMs: number }[] = []
    for (const job of jobs) {
        const level = job.upgradingTo ?? 1
        tx.update(polytownBuildings)
            .set({ level, upgradingTo: null, completesAt: new Date(now) })
            .where(eq(polytownBuildings.id, job.id))
            .run()
        recordTownEvent(tx, playerId, { kind: job.level === 0 ? 'built' : 'upgraded', type: job.type, level }, now)
        done.push({ buildingId: job.id, type: job.type, level, savedMs: job.completesAt.getTime() - now })
    }
    return done
}

/** Convenience for read paths: settle in its own transaction. */
export function settleTownForRead(playerId: string) {
    return writeTx(tx => settleTownState(tx, playerId))
}

// ─── Founding & plots ────────────────────────────────────────────────────────

/**
 * Every town lives in one realm. A new one is planted on the first square of
 * the spiral out from the origin that is TOWN_FOUNDING_GAP plots clear of
 * everybody else's land, so new mayors get room to grow before they meet a
 * neighbour. The writeTx is the old site's plot advisory lock.
 */
function claimFoundingPlot(tx: Tx, playerId: string) {
    // Walk the spiral from the centre every time, so a new town lands next to
    // the others, in the first gap there is, including land a town that closed
    // gave back. The realm is read once and checked in memory.
    const taken = new Set(tx.select({ x: polytownPlots.x, y: polytownPlots.y }).from(polytownPlots).all().map(p => `${p.x},${p.y}`))
    const crowded = (x: number, y: number) => {
        for (let dx = -TOWN_FOUNDING_GAP; dx <= TOWN_FOUNDING_GAP; dx++) {
            for (let dy = -TOWN_FOUNDING_GAP; dy <= TOWN_FOUNDING_GAP; dy++) {
                if (taken.has(`${x + dx},${y + dy}`)) return true
            }
        }
        return false
    }

    for (let index = 0; index < 200_000; index++) {
        const spot = townSpiralCoords(index)

        // Flat grassland is perfectly buildable but has no soil, no timber and
        // no stone worth the name. A first plot should have some of each so a
        // new mayor can see what terrain is for.
        if (townPlotIsFlat(spot.x, spot.y) || crowded(spot.x, spot.y)) continue

        const plot = tx.insert(polytownPlots)
            .values({ playerId, x: spot.x, y: spot.y, paidPrice: 0, createdAt: new Date() })
            .onConflictDoNothing()
            .returning()
            .get()
        if (plot) return plot
        taken.add(`${spot.x},${spot.y}`)
    }
    fail('No free land left', 500)
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const

/**
 * The squares a player could expand into: every free orthogonal neighbour of
 * a plot they own. Squares owned by someone else are reported too so the map
 * can show the neighbour instead of a for-sale sign.
 */
export function getExpansions(playerId: string, ownPlots: { x: number, y: number }[], ex: DbExecutor = db) {
    const own = new Set(ownPlots.map(p => `${p.x},${p.y}`))
    const candidates = new Map<string, { x: number, y: number }>()
    for (const p of ownPlots) {
        for (const [dx, dy] of NEIGHBOURS) {
            const key = `${p.x + dx},${p.y + dy}`
            if (!own.has(key)) candidates.set(key, { x: p.x + dx, y: p.y + dy })
        }
    }
    if (candidates.size === 0) return []
    const coords = [...candidates.values()]
    const rows = ex.select({ x: polytownPlots.x, y: polytownPlots.y, playerId: polytownPlots.playerId, name: players.name })
        .from(polytownPlots)
        .innerJoin(players, eq(players.id, polytownPlots.playerId))
        .where(or(...coords.map(c => and(eq(polytownPlots.x, c.x), eq(polytownPlots.y, c.y)))))
        .all()
    const takenBy = new Map(rows.map(r => [`${r.x},${r.y}`, r]))
    return coords.map((c) => {
        const t = takenBy.get(`${c.x},${c.y}`)
        return t ? { x: c.x, y: c.y, free: false as const, ownerName: t.name } : { x: c.x, y: c.y, free: true as const }
    })
}

/** Found the player's town with its first plot and the starter coins. The insert is the claim: a second founding finds the row and fails. */
export function foundTown(playerId: string) {
    return writeTx((tx) => {
        const now = new Date()
        const created = tx.insert(polytownState)
            .values({ playerId, coinsCents: townCents(TOWN_STARTER_COINS), lastSettledAt: now, lastPlotBoughtAt: now })
            .onConflictDoNothing()
            .returning()
            .get()
        if (!created) fail('You already have a town')
        const plot = claimFoundingPlot(tx, playerId)
        return { stateId: created.playerId, plotId: plot.id }
    })
}

export function plotPurchaseInfo(state: { plotsBought: number, lastPlotBoughtAt: Date }, now = Date.now(), owned = state.plotsBought) {
    const nextIndex = state.plotsBought + 1
    const cooldownMs = townPlotCooldownMs(nextIndex)
    const availableAt = state.lastPlotBoughtAt.getTime() + cooldownMs
    return {
        nextIndex,
        price: townPlotPrice(nextIndex),
        cooldownMs,
        availableAt,
        remainingMs: Math.max(0, availableAt - now),
        // The cap is on land held, not land bought: plots also arrive from other players.
        maxed: owned >= TOWN_MAX_PLOTS
    }
}

export function buyPlot(playerId: string, x: number, y: number) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) fail('Pick a square on the map')
    return writeTx((tx) => {
        const now = Date.now()
        const { state, plots } = settleTownState(tx, playerId, now)
        const info = plotPurchaseInfo(state, now, plots.length)
        if (info.maxed) fail('You own the maximum number of plots')
        if (info.remainingMs > 0) fail('The land office is not selling to you yet')
        if (!plots.some(p => Math.abs(p.x - x) + Math.abs(p.y - y) === 1)) fail('New land must touch a plot you own')

        debitTownCoins(tx, playerId, info.price)
        // The unique (x, y) index is the claim: lose the race, lose nothing (the tx rolls back).
        const plot = tx.insert(polytownPlots).values({ playerId, x, y, paidPrice: info.price, createdAt: new Date(now) }).onConflictDoNothing().returning().get()
        if (!plot) fail('Someone just bought that square')
        tx.update(polytownState)
            .set({ plotsBought: sql`${polytownState.plotsBought} + 1`, lastPlotBoughtAt: new Date(now) })
            .where(eq(polytownState.playerId, playerId))
            .run()
        return { plotId: plot.id, x: plot.x, y: plot.y, price: info.price }
    })
}

/** A plot can only change hands when nothing stands on it. */
function assertPlotEmpty(tx: DbExecutor, plotId: string) {
    const row = tx.select({ n: sql<number>`count(*)` }).from(polytownBuildings).where(eq(polytownBuildings.plotId, plotId)).get()
    if ((row?.n ?? 0) > 0) fail('Clear every building off the plot first')
}

/** Put an empty plot on the market at your own price, or pass null to take it off. */
export function listPlot(playerId: string, plotId: string, price: number | null) {
    if (price !== null && !isValidTownListPrice(price)) fail('Asking price must be at least 1 coin, with at most 2 decimals')
    return writeTx((tx) => {
        const { plots } = settleTownState(tx, playerId)
        const plot = plots.find(p => p.id === plotId)
        if (!plot) fail('That plot is not yours', 404)
        if (price !== null) {
            if (plots.length <= 1) fail('This is your last plot')
            assertPlotEmpty(tx, plotId)
        }
        tx.update(polytownPlots)
            .set({ listPrice: price })
            .where(and(eq(polytownPlots.id, plotId), eq(polytownPlots.playerId, playerId)))
            .run()
        return { plotId, listPrice: price }
    })
}

/** Hand an empty plot back to the land office for a quarter of what it cost. */
export function sellPlotToSystem(playerId: string, plotId: string) {
    return writeTx((tx) => {
        const { plots } = settleTownState(tx, playerId)
        const plot = plots.find(p => p.id === plotId)
        if (!plot) fail('That plot is not yours', 404)
        if (plots.length <= 1) fail('This is your last plot')
        assertPlotEmpty(tx, plotId)

        // The refund is a share of what this very plot cost its owner, so a
        // cheap plot bought off a neighbour cannot be flipped for a fortune.
        const refund = townPlotRefundFor(plot.paidPrice)
        const removed = tx.delete(polytownPlots)
            .where(and(eq(polytownPlots.id, plotId), eq(polytownPlots.playerId, playerId)))
            .returning({ id: polytownPlots.id })
            .get()
        if (!removed) fail('That plot just changed hands', 409)
        tx.update(polytownState)
            .set({ plotsBought: sql`max(1, ${polytownState.plotsBought} - 1)` })
            .where(eq(polytownState.playerId, playerId))
            .run()
        if (refund > 0) creditTownCoins(tx, playerId, refund)
        return { plotId, refund }
    })
}

/**
 * Buy a plot another mayor has listed. The land-office cooldown does not apply
 * (that is the point of the player market) but the plot still has to touch
 * land you already own, so towns stay contiguous.
 */
export function buyPlotFromPlayer(playerId: string, plotId: string, expectedPrice?: number) {
    if (expectedPrice !== undefined && !isValidTownListPrice(expectedPrice)) fail('That is not a price')
    return writeTx((tx) => {
        const listing = tx.select().from(polytownPlots).where(eq(polytownPlots.id, plotId)).get()
        if (!listing || listing.listPrice === null) fail('That plot is not for sale')
        if (listing.playerId === playerId) fail('That plot is already yours')
        readTownState(tx, playerId)
        const sellerId = listing.playerId
        const price = listing.listPrice
        // The buyer agreed to a price they saw, and what they saw can be half a
        // minute old. Without this a seller can re-list at any figure while the
        // click is in flight and the buyer pays it.
        if (expectedPrice !== undefined && price !== expectedPrice) fail('The asking price changed — take another look', 409)

        // Listing and selling are separate calls, so the seller may have shed
        // their other land since they listed this one.
        const sellerPlots = tx.select({ id: polytownPlots.id }).from(polytownPlots).where(eq(polytownPlots.playerId, sellerId)).all()
        if (sellerPlots.length <= 1) fail('That is the seller\'s last plot — it is no longer for sale')

        const mine = tx.select().from(polytownPlots).where(eq(polytownPlots.playerId, playerId)).all()
        if (mine.length >= TOWN_MAX_PLOTS) fail('You own the maximum number of plots')
        if (!mine.some(p => Math.abs(p.x - listing.x) + Math.abs(p.y - listing.y) === 1)) fail('That plot does not touch your land')
        assertPlotEmpty(tx, plotId)

        // The conditional update is the claim: whoever flips the listing owns it.
        // paidPrice is what the LAND OFFICE was paid, and it stays at zero
        // through a player sale, so two accounts passing a plot back and forth
        // can never mint a refund.
        const bought = tx.update(polytownPlots)
            .set({ playerId, listPrice: null, paidPrice: 0 })
            .where(and(eq(polytownPlots.id, plotId), eq(polytownPlots.playerId, sellerId), sql`${polytownPlots.listPrice} is not null`))
            .returning({ id: polytownPlots.id })
            .get()
        if (!bought) fail('Someone just bought that plot', 409)

        debitTownCoins(tx, playerId, price)
        creditTownCoins(tx, sellerId, price)
        // plotsBought counts plots taken from the LAND OFFICE; a sale between
        // players does not walk either price ladder back.
        return { plotId, price, sellerId }
    })
}

/** Most other plots one world view draws, nearest first. */
const TOWN_WORLD_PLOT_CAP = 240

/**
 * Everything the map should draw around the player: other mayors' plots (and
 * what stands on them), plus anything they have listed. The whole realm by
 * default; `radius` (in squares around the player's own land) narrows it.
 */
export function getWorldView(playerId: string, ownPlots: { x: number, y: number }[], radius?: number) {
    if (ownPlots.length === 0) return { towns: [], listings: [] }
    const minX = Math.min(...ownPlots.map(p => p.x))
    const maxX = Math.max(...ownPlots.map(p => p.x))
    const minY = Math.min(...ownPlots.map(p => p.y))
    const maxY = Math.max(...ownPlots.map(p => p.y))

    // When the cap bites, it is the farthest land that goes. Distance is
    // measured from the doubled centre so it stays an integer.
    const cx2 = minX + maxX
    const cy2 = minY + maxY
    const rows = db.select({
        id: polytownPlots.id,
        x: polytownPlots.x,
        y: polytownPlots.y,
        listPrice: polytownPlots.listPrice,
        ownerId: polytownPlots.playerId,
        ownerName: players.name
    })
        .from(polytownPlots)
        .innerJoin(players, eq(players.id, polytownPlots.playerId))
        .where(and(
            ne(polytownPlots.playerId, playerId),
            radius === undefined
                ? undefined
                : and(
                        gte(polytownPlots.x, minX - radius), lte(polytownPlots.x, maxX + radius),
                        gte(polytownPlots.y, minY - radius), lte(polytownPlots.y, maxY + radius)
                    )
        ))
        .orderBy(sql`max(abs(2 * ${polytownPlots.x} - ${cx2}), abs(2 * ${polytownPlots.y} - ${cy2}))`, polytownPlots.id)
        .limit(TOWN_WORLD_PLOT_CAP)
        .all()
    if (rows.length === 0) return { towns: [], listings: [] }

    // Level 0 rows are included: a neighbour's building site, with its scaffold
    // and its clock, is half of what makes the realm look inhabited. Every
    // building on those plots comes back; the plot cap already bounds it.
    const rows2 = db.select({
        plotId: polytownBuildings.plotId,
        type: polytownBuildings.type,
        tileX: polytownBuildings.tileX,
        tileY: polytownBuildings.tileY,
        rotation: polytownBuildings.rotation,
        level: polytownBuildings.level,
        upgradingTo: polytownBuildings.upgradingTo,
        completesAt: polytownBuildings.completesAt
    })
        .from(polytownBuildings)
        .where(inArray(polytownBuildings.plotId, rows.map(r => r.id)))
        .all()
    const buildings = rows2.map(b => ({
        plotId: b.plotId,
        type: b.type,
        tileX: b.tileX,
        tileY: b.tileY,
        rotation: b.rotation,
        level: b.level,
        upgradingTo: b.upgradingTo,
        completesAt: b.completesAt.getTime()
    }))

    const byPlot = new Map<string, typeof buildings>()
    for (const b of buildings) {
        const list = byPlot.get(b.plotId)
        if (list) list.push(b)
        else byPlot.set(b.plotId, [b])
    }

    return {
        towns: rows.map(r => ({
            id: r.id,
            x: r.x,
            y: r.y,
            ownerId: r.ownerId,
            ownerName: r.ownerName,
            listPrice: r.listPrice,
            buildings: byPlot.get(r.id) ?? []
        })),
        listings: rows.filter(r => r.listPrice !== null).map(r => ({
            plotId: r.id,
            x: r.x,
            y: r.y,
            ownerName: r.ownerName,
            price: r.listPrice!
        }))
    }
}

// ─── Buildings ───────────────────────────────────────────────────────────────

/**
 * A running purse for a bulk call: what the town had when the transaction
 * opened, less what this call has committed so far. It only decides where a
 * batch stops; the debit and the inventory guards still enforce the spend.
 */
function townPurse(state: StateRow, inventory: TownResourceBag) {
    let coins = state.coinsCents / 100
    const goods: TownResourceBag = { ...inventory }
    return {
        /** Why this cost is out of reach right now, or null. */
        shortOf(cost: { coins: number, resources: TownResourceBag }): string | null {
            if (cost.coins > coins) return 'Not enough coins'
            for (const [id, qty] of Object.entries(cost.resources) as [TownResourceId, number][]) {
                if ((goods[id] ?? 0) < qty) return `Not enough ${getTownResource(id)?.name ?? id}`
            }
            return null
        },
        spend(cost: { coins: number, resources: TownResourceBag }) {
            coins -= cost.coins
            for (const [id, qty] of Object.entries(cost.resources) as [TownResourceId, number][]) {
                goods[id] = (goods[id] ?? 0) - qty
            }
        }
    }
}

export interface TownPlacement { plotId: string, tileX: number, tileY: number, type: string, rotation?: number }

function validatePlacementShape(item: TownPlacement) {
    const rotation = item.rotation ?? 0
    if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) fail('Rotation must be 0, 1, 2 or 3 quarter turns')
    const def = getTownBuilding(item.type)
    if (!def) fail('Unknown building')
    if (!Number.isInteger(item.tileX) || !Number.isInteger(item.tileY) || item.tileX < 0 || item.tileY < 0 || item.tileX >= TOWN_PLOT_SIZE || item.tileY >= TOWN_PLOT_SIZE) {
        fail('That tile is off the plot')
    }
    return { def, rotation }
}

/**
 * Place one or more buildings in a single transaction: what a road drag sends.
 *
 * Every item is validated against the layout the previous items in the same
 * drag already created. A drag across a tile that is taken, or past what the
 * purse covers, skips that tile rather than failing the whole gesture, but a
 * request that places nothing at all reports the first reason.
 */
export function placeBuildings(playerId: string, items: TownPlacement[]) {
    if (items.length === 0) fail('Nothing to build')
    if (items.length > TOWN_MAX_DRAG_TILES) fail('Too many tiles in one go')
    const shapes = items.map(validatePlacementShape)

    return writeTx((tx) => {
        const now = Date.now()
        const { sim, state, bonus, inventory, stored, plots } = settleTownState(tx, playerId, now)
        const plotsById = new Map(plots.map(p => [p.id, p]))
        const purse = townPurse(state, inventory)
        const credits = { ...state.monumentCredit }

        // The layout as this call builds it up, so each item sees the last one.
        const layout = [...sim]
        // Stored buildings are still owned: they count toward caps and prices.
        const counts = new Map<string, number>()
        for (const b of [...sim, ...stored]) counts.set(b.type, (counts.get(b.type) ?? 0) + 1)
        let buildersLeft = townBuildersFree(sim, townCrews(state, now), now)

        const placed: { buildingId: string, type: string, plotId: string, tileX: number, tileY: number, completesAt: number, cost: ReturnType<typeof townPlaceCost> }[] = []
        const touchedPlots = new Set<string>()
        let firstIssue: string | null = null
        const note = (why: string) => { if (!firstIssue) firstIssue = why }

        for (let i = 0; i < items.length; i++) {
            const item = items[i]!
            const { def, rotation } = shapes[i]!
            const plot = plotsById.get(item.plotId)
            if (!plot) { note('That plot is not yours'); continue }

            // Monument stages carried over from research: the monument goes up
            // at that stage at once, free, and whatever tier the town is at.
            const credit = def.kind === 'monument' ? Math.max(0, Math.floor(credits[def.id] ?? 0)) : 0

            const lock = credit > 0 ? null : townTierRequirement(layout, def.tier, now, state.produced)
            if (lock) {
                note(lock.needsBuilding
                    ? `Finish a tier ${def.tier - 1} building first`
                    : lock.pop < lock.popRequired
                        ? `Tier ${def.tier} needs ${lock.popRequired} residents (you house ${lock.pop})`
                        : `Tier ${def.tier} opens after producing ${lock.producedRequired} tier-${lock.producedTier} goods (${lock.produced} so far)`)
                continue
            }

            // Counted against everything already standing plus what this same
            // call has put up, so one drag cannot lay three jewel mines at once.
            const capped = townBuildingCountIssue(def, counts.get(def.id) ?? 0)
            if (capped) { note(capped); continue }

            const wx = plot.x * TOWN_PLOT_SIZE + item.tileX
            const wy = plot.y * TOWN_PLOT_SIZE + item.tileY
            const issue = townPlacementIssue(layout, def, wx, wy, rotation)
            if (issue) { note(issue); continue }

            // Roads go up instantly and need nobody; monuments have their own
            // crew; everything else needs a builder.
            const instant = def.kind === 'road'
            const monument = def.kind === 'monument'
            if (monument && !credit && townMonumentJob(layout, now)) { note('The monument crew is busy'); continue }
            if (!instant && !monument && buildersLeft <= 0) { note('Every builder is busy'); continue }

            // The n-th copy costs more: count every existing one, finished or not.
            const cost = credit > 0 ? { coins: 0, resources: {} } : townPlaceCost(def, counts.get(def.id) ?? 0)
            const short = purse.shortOf(cost)
            if (short) { note(short); continue }

            const buildMs = instant ? 0 : townLevelBuildMs(def, 1, state.happiness, bonus)
            // The unique (plot, tile) index is the occupancy guard, and the
            // insert comes first: a tile lost to another build is never paid for.
            const building = tx.insert(polytownBuildings)
                .values({
                    playerId,
                    plotId: item.plotId,
                    type: def.id,
                    tileX: item.tileX,
                    tileY: item.tileY,
                    rotation,
                    level: instant ? 1 : credit,
                    completesAt: new Date(credit > 0 ? now : townBuildBoostedCompletesAt(now, buildMs, state.buildBoostUntil?.getTime())),
                    createdAt: new Date(now)
                })
                .onConflictDoNothing()
                .returning()
                .get()
            if (!building) { note('That tile is already taken'); continue }

            if (credit > 0) {
                // Spend the credit only once the tile is won. The key's
                // presence is the guard, so a credit can land one monument.
                const path = `$.${def.id}`
                const spent = tx.update(polytownState)
                    .set({ monumentCredit: sql`json_remove(${polytownState.monumentCredit}, ${path})` })
                    .where(and(eq(polytownState.playerId, playerId), sql`json_extract(${polytownState.monumentCredit}, ${path}) is not null`))
                    .returning({ id: polytownState.playerId })
                    .get()
                if (!spent) fail('That research credit was just used', 409)
                delete credits[def.id]
            }

            if (cost.coins > 0) debitTownCoins(tx, playerId, cost.coins)
            spendBag(tx, playerId, cost.resources)
            purse.spend(cost)

            counts.set(def.id, (counts.get(def.id) ?? 0) + 1)
            if (!instant && !monument) buildersLeft--
            layout.push(toSim(building, plot))
            touchedPlots.add(item.plotId)
            placed.push({
                buildingId: building.id,
                type: def.id,
                plotId: item.plotId,
                tileX: item.tileX,
                tileY: item.tileY,
                completesAt: building.completesAt.getTime(),
                cost
            })
        }

        if (placed.length === 0) fail(firstIssue ?? 'Nothing could be built there')
        // Building on a listed plot takes it off the market.
        tx.update(polytownPlots).set({ listPrice: null }).where(inArray(polytownPlots.id, [...touchedPlots])).run()
        return { placed, skipped: items.length - placed.length, reason: placed.length < items.length ? firstIssue : null }
    })
}

export function placeBuilding(playerId: string, plotId: string, tileX: number, tileY: number, type: string, rotation = 0) {
    const { placed } = placeBuildings(playerId, [{ plotId, tileX, tileY, type, rotation }])
    const one = placed[0]!
    return { buildingId: one.buildingId, completesAt: one.completesAt, cost: one.cost }
}

export interface TownRelocation { buildingId: string, plotId: string, tileX: number, tileY: number, rotation: number }

function validateRelocation(m: { rotation: number, tileX: number, tileY: number }) {
    if (!Number.isInteger(m.rotation) || m.rotation < 0 || m.rotation > 3) fail('Rotation must be 0, 1, 2 or 3 quarter turns')
    if (!Number.isInteger(m.tileX) || !Number.isInteger(m.tileY) || m.tileX < 0 || m.tileY < 0 || m.tileX >= TOWN_PLOT_SIZE || m.tileY >= TOWN_PLOT_SIZE) {
        fail('That tile is off the plot')
    }
}

/**
 * Park the moving buildings off the grid, then set their real tiles. SQLite
 * checks the unique (plot, tile) index per row, and two buildings may be
 * swapping tiles: parking every one on its own negative tile first means no
 * statement ever lands on a tile another moving building still holds.
 */
function shuffleBuildings(tx: Tx, playerId: string, moves: TownRelocation[], between?: () => void) {
    let park = -1
    for (const m of moves) {
        tx.update(polytownBuildings)
            .set({ tileX: park, tileY: park })
            .where(and(eq(polytownBuildings.id, m.buildingId), eq(polytownBuildings.playerId, playerId)))
            .run()
        park--
    }
    between?.()
    for (const m of moves) {
        let moved: { id: string } | undefined
        try {
            moved = tx.update(polytownBuildings)
                .set({ plotId: m.plotId, tileX: m.tileX, tileY: m.tileY, rotation: m.rotation })
                .where(and(eq(polytownBuildings.id, m.buildingId), eq(polytownBuildings.playerId, playerId)))
                .returning({ id: polytownBuildings.id })
                .get()
        } catch (error) {
            if (isUniqueViolation(error)) fail('That tile is already taken')
            throw error
        }
        if (!moved) fail('That tile is already taken')
    }
}

function isUniqueViolation(error: unknown): boolean {
    const e = error as { code?: string, message?: string, cause?: { code?: string, message?: string } }
    const text = `${e?.code ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`
    return text.includes('SQLITE_CONSTRAINT') || text.includes('UNIQUE constraint failed')
}

/**
 * Move a set of buildings to new tiles on owned plots, all or nothing.
 *
 * A move is free and never touches the clock, so a building still going up
 * travels with the rest of its block. Only the ground is checked (occupied,
 * water), so two buildings may swap tiles and a block may carry its own
 * street. A building left without a road simply stops working until one
 * reaches it.
 */
export function moveBuildings(playerId: string, moves: TownRelocation[]) {
    if (moves.length === 0) fail('Nothing to move')
    if (moves.length > TOWN_MAX_DRAG_TILES) fail('Too many buildings in one go')
    for (const m of moves) validateRelocation(m)
    if (new Set(moves.map(m => m.buildingId)).size !== moves.length) fail('A building can only be moved once')

    return writeTx((tx) => {
        const now = Date.now()
        const { sim, plots } = settleTownState(tx, playerId, now)
        const plotsById = new Map(plots.map(p => [p.id, p]))

        const wanted: TownGroupMove[] = []
        for (const m of moves) {
            if (!sim.some(b => b.id === m.buildingId)) fail('Building not found', 404)
            const plot = plotsById.get(m.plotId)
            if (!plot) fail('That plot is not yours')
            wanted.push({
                id: m.buildingId,
                wx: plot.x * TOWN_PLOT_SIZE + m.tileX,
                wy: plot.y * TOWN_PLOT_SIZE + m.tileY,
                rotation: m.rotation
            })
        }
        const issue = townGroupMoveIssue(sim, wanted)
        if (issue) fail(issue)

        shuffleBuildings(tx, playerId, moves)
        tx.update(polytownPlots).set({ listPrice: null }).where(inArray(polytownPlots.id, [...new Set(moves.map(m => m.plotId))])).run()
        return { moved: moves.map(m => m.buildingId) }
    })
}

export interface TownRedesign {
    /** Every building being kept, with the tile it ends up on. */
    moves: TownRelocation[]
    /** Brand-new roads to lay, paid for at the usual price. */
    roads: { plotId: string, tileX: number, tileY: number }[]
    /** Buildings on the map going into storage instead of back down. */
    store?: string[]
    /** Stored buildings coming back out, by their stored id, and where. */
    place?: TownRelocation[]
}

// ─── Storage ─────────────────────────────────────────────────────────────────

/** A stored building as the layout rules see it while it is being put back: no tile yet. */
function storedToSim(row: StoredRow, now: number): TownSimBuilding {
    const job = townStoredIsJob(row)
    return {
        id: row.id,
        type: row.type as TownSimBuilding['type'],
        level: row.level,
        upgradingTo: job ? row.upgradingTo : null,
        completesAt: job ? now + row.remainingMs : 0,
        createdAt: row.createdAt.getTime(),
        rotation: 0
    }
}

/**
 * Take buildings off the map into storage. The DELETE … RETURNING is the
 * claim: only a row this call removed is stored. A running job is frozen:
 * what was left of it is kept, and the crew it held is free from now on.
 */
function storeBuildingRows(tx: Tx, playerId: string, ids: string[], now: number) {
    if (ids.length === 0) return []
    const taken = tx.delete(polytownBuildings)
        .where(and(inArray(polytownBuildings.id, ids), eq(polytownBuildings.playerId, playerId)))
        .returning()
        .all()
    if (taken.length !== ids.length) fail('A building changed — try again', 409)
    tx.insert(polytownStorage).values(taken.map((b) => {
        const job = b.level === 0 || b.upgradingTo !== null
        return {
            id: b.id,
            playerId,
            type: b.type,
            level: b.level,
            upgradingTo: b.upgradingTo,
            remainingMs: job ? Math.max(0, b.completesAt.getTime() - now) : 0,
            createdAt: b.createdAt,
            storedAt: new Date(now)
        }
    })).run()
    return taken
}

/**
 * Put a stored building back on a tile. The storage DELETE claims it, and the
 * (plot, tile) unique index guards the tile; losing either rolls back the
 * whole transaction. A paused job picks up where it stopped.
 */
function placeStoredRow(tx: Tx, playerId: string, m: TownRelocation, now: number) {
    const row = tx.delete(polytownStorage)
        .where(and(eq(polytownStorage.id, m.buildingId), eq(polytownStorage.playerId, playerId)))
        .returning()
        .get()
    if (!row) fail('That building is not in storage', 404)
    const job = townStoredIsJob(row)
    const placed = tx.insert(polytownBuildings)
        .values({
            id: row.id,
            playerId,
            plotId: m.plotId,
            type: row.type,
            tileX: m.tileX,
            tileY: m.tileY,
            rotation: m.rotation,
            level: row.level,
            upgradingTo: job ? row.upgradingTo : null,
            completesAt: new Date(job ? now + row.remainingMs : now),
            createdAt: row.createdAt
        })
        .onConflictDoNothing()
        .returning({ id: polytownBuildings.id })
        .get()
    if (!placed) fail('That tile is already taken')
}

/**
 * Why the stored buildings in `placing` cannot come back onto `layout`, or
 * null. A paused job needs a crew standing idle to pick it up; a monument
 * stage needs the monument crew. Without this, storing a job to free its crew
 * and placing it back would run two jobs on one crew.
 */
function storagePlaceCrewIssue(layout: TownSimBuilding[], placing: StoredRow[], crews: number, now: number): string | null {
    let free = townBuildersFree(layout, crews, now)
    let monumentFree = townMonumentJob(layout, now) === null
    for (const row of placing) {
        if (!townStoredIsJob(row)) continue
        if (isTownMonumentId(row.type)) {
            if (!monumentFree) return 'The monument crew is busy: this monument\'s stage has to wait in storage'
            monumentFree = false
        } else {
            if (free <= 0) return 'Every builder is busy: a paused job needs a free crew to come back'
            free--
        }
    }
    return null
}

/** Send buildings on the map to storage, roads included. */
export function storeBuildings(playerId: string, buildingIds: string[]) {
    const ids = [...new Set(buildingIds.filter(Boolean))]
    if (ids.length === 0) fail('Nothing to store')
    if (ids.length > TOWN_MAX_DRAG_TILES) fail('Too many buildings in one go')
    return writeTx((tx) => {
        const now = Date.now()
        // Settled first, so a job's frozen time is measured from now.
        const { buildings } = settleTownState(tx, playerId, now)
        for (const id of ids) {
            if (!buildings.some(x => x.id === id)) fail('Building not found', 404)
        }
        storeBuildingRows(tx, playerId, ids, now)
        return { stored: ids }
    })
}

// ─── Redesign drafts ─────────────────────────────────────────────────────────

export function getRedesignDraft(playerId: string, ex: DbExecutor = db): { draft: TownRedesignDraft, updatedAt: number } | null {
    const row = ex.select().from(polytownRedesignDrafts).where(eq(polytownRedesignDrafts.playerId, playerId)).get()
    return row ? { draft: row.draft, updatedAt: row.updatedAt.getTime() } : null
}

/** Keep a half-done redesign for later. Only a plan: nothing about the town changes, so the last save wins. */
export function saveRedesignDraft(playerId: string, draft: TownRedesignDraft) {
    if (!getTownState(playerId)) fail('Found a town first')
    const now = new Date()
    db.insert(polytownRedesignDrafts)
        .values({ playerId, draft, updatedAt: now })
        .onConflictDoUpdate({ target: polytownRedesignDrafts.playerId, set: { draft, updatedAt: now } })
        .run()
    return { savedAt: now.getTime() }
}

export function discardRedesignDraft(playerId: string, ex: DbExecutor = db) {
    ex.delete(polytownRedesignDrafts).where(eq(polytownRedesignDrafts.playerId, playerId)).run()
    return { discarded: true }
}

/** Bring one stored building back onto a tile of your own land. */
export function placeStoredBuilding(playerId: string, m: TownRelocation) {
    validateRelocation(m)
    return writeTx((tx) => {
        const now = Date.now()
        const { state, sim, stored, plots } = settleTownState(tx, playerId, now)
        const row = stored.find(s => s.id === m.buildingId)
        if (!row) fail('That building is not in storage', 404)
        const plot = plots.find(p => p.id === m.plotId)
        if (!plot) fail('That plot is not yours')
        const wx = plot.x * TOWN_PLOT_SIZE + m.tileX
        const wy = plot.y * TOWN_PLOT_SIZE + m.tileY
        const issue = townGroupMoveIssue([...sim, storedToSim(row, now)], [{ id: row.id, wx, wy, rotation: m.rotation }])
        if (issue) fail(issue)
        const crew = storagePlaceCrewIssue(sim, [row], townCrews(state, now), now)
        if (crew) fail(crew)
        placeStoredRow(tx, playerId, m, now)
        tx.update(polytownPlots).set({ listPrice: null }).where(eq(polytownPlots.id, m.plotId)).run()
        return { buildingId: row.id }
    })
}

/** The most tiles a redesign can name: every tile of every plot a town can own. */
export const TOWN_REDESIGN_MAX_TILES = TOWN_MAX_PLOTS * TOWN_PLOT_SIZE * TOWN_PLOT_SIZE

/**
 * Lay the whole town out again in one go, all or nothing.
 *
 * Every building that is not a road must be in `moves` or `store`: a redesign
 * never demolishes a building. Roads may be stored too; a road named in
 * neither list is removed. New roads can be laid at the same time, charged
 * exactly as a fresh build. Stores happen first, so a crew freed by a stored
 * job can pick up a paused one coming back. Moves are free and keep the clock.
 */
export function redesignTown(playerId: string, plan: TownRedesign) {
    const { moves, roads } = plan
    const store = [...new Set(plan.store ?? [])]
    const place = plan.place ?? []
    if (moves.length + roads.length + store.length + place.length === 0) fail('Nothing to lay out')
    if (moves.length + roads.length + place.length > TOWN_REDESIGN_MAX_TILES || store.length > TOWN_REDESIGN_MAX_TILES) fail('Too many tiles in one go')
    const onPlot = (t: { tileX: number, tileY: number }) =>
        Number.isInteger(t.tileX) && Number.isInteger(t.tileY) && t.tileX >= 0 && t.tileY >= 0 && t.tileX < TOWN_PLOT_SIZE && t.tileY < TOWN_PLOT_SIZE
    for (const m of [...moves, ...place]) {
        if (!Number.isInteger(m.rotation) || m.rotation < 0 || m.rotation > 3) fail('Rotation must be 0, 1, 2 or 3 quarter turns')
        if (!onPlot(m)) fail('That tile is off the plot')
    }
    for (const r of roads) if (!onPlot(r)) fail('That tile is off the plot')
    const named = [...moves.map(m => m.buildingId), ...place.map(m => m.buildingId), ...store]
    if (new Set(named).size !== named.length) fail('A building can only be placed once')
    const roadDef = getTownBuilding('road')!

    return writeTx((tx) => {
        const now = Date.now()
        const { sim: settledSim, state, stored, plots } = settleTownState(tx, playerId, now)
        const plotsById = new Map(plots.map(p => [p.id, p]))

        const storing = new Set(store)
        for (const id of store) {
            if (!settledSim.some(x => x.id === id)) fail('Building not found', 404)
        }
        const placing: StoredRow[] = []
        for (const m of place) {
            const row = stored.find(s => s.id === m.buildingId)
            if (!row) fail('That building is no longer in storage', 404)
            placing.push(row)
        }

        // From here on the map is the map without what is going into storage.
        const sim = settledSim.filter(b => !storing.has(b.id))
        const moving = new Set(moves.map(m => m.buildingId))
        const removed: string[] = []
        for (const b of sim) {
            if (moving.has(b.id)) continue
            if (b.type !== 'road') fail('Every building has to be placed or stored before saving')
            removed.push(b.id)
        }

        const world = (plotId: string, tileX: number, tileY: number) => {
            const plot = plotsById.get(plotId)
            if (!plot) fail('That plot is not yours')
            return { plot, wx: plot.x * TOWN_PLOT_SIZE + tileX, wy: plot.y * TOWN_PLOT_SIZE + tileY }
        }
        const wanted: TownGroupMove[] = []
        for (const m of moves) {
            if (!sim.some(b => b.id === m.buildingId)) fail('Building not found', 404)
            const { wx, wy } = world(m.plotId, m.tileX, m.tileY)
            wanted.push({ id: m.buildingId, wx, wy, rotation: m.rotation })
        }
        for (const m of place) {
            const { wx, wy } = world(m.plotId, m.tileX, m.tileY)
            wanted.push({ id: m.buildingId, wx, wy, rotation: m.rotation })
        }
        // The roads being removed do not hold their tiles against the new
        // layout; buildings coming out of storage hold none until they land.
        const kept = [...sim.filter(b => !removed.includes(b.id)), ...placing.map(row => storedToSim(row, now))]
        const issue = wanted.length ? townGroupMoveIssue(kept, wanted) : null
        if (issue) fail(issue)

        // New roads are judged against the finished layout, and priced the way
        // a fresh build would be: the n-th road counts every road still standing.
        const layout: TownSimBuilding[] = kept.map((b) => {
            const w = wanted.find(m => m.id === b.id)
            return w ? { ...b, wx: w.wx, wy: w.wy, rotation: w.rotation } : b
        })
        const placingIds = new Set(placing.map(p => p.id))
        const crew = storagePlaceCrewIssue(layout.filter(b => !placingIds.has(b.id)), placing, townCrews(state, now), now)
        if (crew) fail(crew)
        let roadCount = layout.filter(b => b.type === 'road').length
        let coins = 0
        const newRoads: { plotId: string, tileX: number, tileY: number, wx: number, wy: number }[] = []
        for (const r of roads) {
            const { wx, wy } = world(r.plotId, r.tileX, r.tileY)
            const why = townPlacementIssue(layout, roadDef, wx, wy, 0)
            if (why) fail(why)
            coins += townPlaceCost(roadDef, roadCount).coins
            roadCount++
            layout.push({ id: `new:${wx},${wy}`, type: 'road', level: 1, completesAt: 0, upgradingTo: null, createdAt: 0, wx, wy, rotation: 0 })
            newRoads.push({ ...r, wx, wy })
        }

        // Into storage first: their tiles come free for the moves below.
        storeBuildingRows(tx, playerId, store, now)
        // Park, clear, then set: see shuffleBuildings.
        shuffleBuildings(tx, playerId, moves, () => {
            if (removed.length) tx.delete(polytownBuildings).where(and(inArray(polytownBuildings.id, removed), eq(polytownBuildings.playerId, playerId))).run()
        })
        for (const m of place) placeStoredRow(tx, playerId, m, now)
        const built: string[] = []
        for (const r of newRoads) {
            const row = tx.insert(polytownBuildings)
                .values({ playerId, plotId: r.plotId, type: 'road', tileX: r.tileX, tileY: r.tileY, rotation: 0, level: 1, completesAt: new Date(now), createdAt: new Date(now) })
                .onConflictDoNothing()
                .returning({ id: polytownBuildings.id })
                .get()
            if (!row) fail('That tile is already taken')
            built.push(row.id)
        }
        // The debit throws when the purse is short, and the transaction rolls back.
        if (coins > 0) debitTownCoins(tx, playerId, coins)

        const touched = new Set([...moves.map(m => m.plotId), ...place.map(m => m.plotId), ...roads.map(r => r.plotId)])
        if (touched.size) tx.update(polytownPlots).set({ listPrice: null }).where(inArray(polytownPlots.id, [...touched])).run()
        // The plan is carried out: any half-way draft of it is spent.
        discardRedesignDraft(playerId, tx)
        return { moved: moves.map(m => m.buildingId), removed, built, coins, stored: store, placed: place.map(m => m.buildingId) }
    })
}

export function moveBuilding(playerId: string, buildingId: string, plotId: string, tileX: number, tileY: number, rotation: number) {
    moveBuildings(playerId, [{ buildingId, plotId, tileX, tileY, rotation }])
    return { buildingId, plotId, tileX, tileY, rotation }
}

/** Why nobody can start an upgrade on a building of `kind` right now, or null. */
function upgradeCrewIssue(kind: string, sim: TownSimBuilding[], builders: number, now: number): string | null {
    if (kind === 'monument') return townMonumentJob(sim, now) ? 'The monument crew is busy' : null
    return townBuildersFree(sim, builders, now) <= 0 ? 'Every builder is busy' : null
}

export function upgradeBuilding(playerId: string, buildingId: string) {
    return writeTx((tx) => {
        const now = Date.now()
        const { buildings, state, sim, bonus } = settleTownState(tx, playerId, now)
        const building = buildings.find(b => b.id === buildingId)
        if (!building) fail('Building not found', 404)
        if (building.level === 0) fail('Still under construction')
        if (building.upgradingTo !== null) fail('Already upgrading')

        const def = getTownBuilding(building.type)!
        if (def.kind === 'road') fail('Roads have no levels')
        if (building.level >= townBuildingMaxLevel(def)) fail('Already at max level')
        const crewIssue = upgradeCrewIssue(def.kind, sim, townCrews(state, now), now)
        if (crewIssue) fail(crewIssue)
        const nextLevel = building.level + 1
        const cost = townLevelCost(def, nextLevel)
        if (cost.coins > 0) debitTownCoins(tx, playerId, cost.coins)
        spendBag(tx, playerId, cost.resources)

        const completesAt = new Date(townBuildBoostedCompletesAt(now, townLevelBuildMs(def, nextLevel, state.happiness, bonus), state.buildBoostUntil?.getTime()))
        const updated = tx.update(polytownBuildings)
            .set({ upgradingTo: nextLevel, completesAt })
            .where(and(eq(polytownBuildings.id, buildingId), eq(polytownBuildings.level, building.level), isNull(polytownBuildings.upgradingTo)))
            .returning()
            .get()
        if (!updated) fail('Building changed — try again', 409)
        return { buildingId, level: nextLevel, completesAt: completesAt.getTime(), cost }
    })
}

/** Monuments stand for good: the billions sunk into one cannot be bulldozed by a slip of the mouse. */
const NOT_A_MONUMENT = notInArray(polytownBuildings.type, [...TOWN_MONUMENT_IDS])

/**
 * Finish a running job at once, inside the caller's writeTx: the gem-paid rush.
 * The writeTx serializes every mutation of this player's buildings, so no CAS
 * is needed. Throws 400 when there is nothing left to rush.
 */
export function rushTownJob(tx: Tx, playerId: string, buildingId: string, now: number) {
    const { buildings } = settleTownState(tx, playerId, now)
    const building = buildings.find(b => b.id === buildingId)
    if (!building) fail('Building not found', 404)
    if (building.completesAt.getTime() - now <= 0 || (building.level > 0 && building.upgradingTo === null)) fail('Nothing to rush')
    const level = building.upgradingTo ?? 1
    tx.update(polytownBuildings)
        .set({ level, upgradingTo: null, completesAt: new Date(now) })
        .where(eq(polytownBuildings.id, buildingId))
        .run()
    // The settle never sees this one finish, so the note is written here.
    recordTownEvent(tx, playerId, { kind: building.level === 0 ? 'built' : 'upgraded', type: building.type, level }, now)
    return { buildingId, level }
}

export function demolishBuilding(playerId: string, buildingId: string) {
    return writeTx((tx) => {
        const { buildings } = settleTownState(tx, playerId)
        const target = buildings.find(b => b.id === buildingId)
        if (target && isTownMonumentId(target.type)) fail('Monuments cannot be demolished')
        const deleted = tx.delete(polytownBuildings)
            .where(and(eq(polytownBuildings.id, buildingId), eq(polytownBuildings.playerId, playerId), NOT_A_MONUMENT))
            .returning({ id: polytownBuildings.id, type: polytownBuildings.type })
            .get()
        if (!deleted) fail('Building not found', 404)
        return { buildingId: deleted.id, type: deleted.type }
    })
}

/** Clear a whole selection (or a bulldozer drag) in one transaction. */
export function demolishBuildings(playerId: string, buildingIds: string[]) {
    const ids = [...new Set(buildingIds.filter(Boolean))]
    if (ids.length === 0) fail('Nothing to demolish')
    if (ids.length > TOWN_MAX_DRAG_TILES) fail('Too many buildings in one go')
    return writeTx((tx) => {
        settleTownState(tx, playerId)
        // The DELETE is the guard: whatever comes back is what this call removed.
        const deleted = tx.delete(polytownBuildings)
            .where(and(inArray(polytownBuildings.id, ids), eq(polytownBuildings.playerId, playerId), NOT_A_MONUMENT))
            .returning({ id: polytownBuildings.id, type: polytownBuildings.type })
            .all()
        if (deleted.length === 0) fail('Nothing left to demolish — monuments stay standing')
        return { demolished: deleted.map(d => d.id), types: deleted.map(d => d.type) }
    })
}

/**
 * Start an upgrade on every building in a selection that can take one.
 * Crews, coins and goods all run out partway through a big selection, so this
 * takes the ones it can afford in the order given and reports the rest.
 */
export function upgradeBuildings(playerId: string, buildingIds: string[]) {
    const ids = [...new Set(buildingIds.filter(Boolean))]
    if (ids.length === 0) fail('Nothing to upgrade')
    if (ids.length > TOWN_MAX_DRAG_TILES) fail('Too many buildings in one go')

    return writeTx((tx) => {
        const now = Date.now()
        const { buildings, state, sim, bonus, inventory } = settleTownState(tx, playerId, now)
        const purse = townPurse(state, inventory)
        let buildersLeft = townBuildersFree(sim, townCrews(state, now), now)
        let monumentCrewFree = townMonumentJob(sim, now) === null
        const started: { buildingId: string, level: number, completesAt: number }[] = []
        let firstIssue: string | null = null
        const note = (why: string) => { if (!firstIssue) firstIssue = why }

        for (const id of ids) {
            const building = buildings.find(b => b.id === id)
            if (!building) { note('Building not found'); continue }
            if (building.level === 0) { note('Still under construction'); continue }
            if (building.upgradingTo !== null) { note('Already upgrading'); continue }
            const def = getTownBuilding(building.type)!
            if (def.kind === 'road') { note('Roads have no levels'); continue }
            if (building.level >= townBuildingMaxLevel(def)) { note('Already at max level'); continue }
            const monument = def.kind === 'monument'
            if (monument && !monumentCrewFree) { note('The monument crew is busy'); continue }
            if (!monument && buildersLeft <= 0) { note('Every builder is busy'); continue }

            const nextLevel = building.level + 1
            const cost = townLevelCost(def, nextLevel)
            const short = purse.shortOf(cost)
            if (short) { note(short); continue }
            const completesAt = new Date(townBuildBoostedCompletesAt(now, townLevelBuildMs(def, nextLevel, state.happiness, bonus), state.buildBoostUntil?.getTime()))
            // The conditional UPDATE claims the upgrade; only then is anything charged.
            const updated = tx.update(polytownBuildings)
                .set({ upgradingTo: nextLevel, completesAt })
                .where(and(
                    eq(polytownBuildings.id, id),
                    eq(polytownBuildings.playerId, playerId),
                    eq(polytownBuildings.level, building.level),
                    isNull(polytownBuildings.upgradingTo)
                ))
                .returning({ id: polytownBuildings.id })
                .get()
            if (!updated) { note('Building changed — try again'); continue }
            if (cost.coins > 0) debitTownCoins(tx, playerId, cost.coins)
            spendBag(tx, playerId, cost.resources)
            purse.spend(cost)

            if (monument) monumentCrewFree = false
            else buildersLeft--
            started.push({ buildingId: id, level: nextLevel, completesAt: completesAt.getTime() })
        }

        if (started.length === 0) fail(firstIssue ?? 'Nothing could be upgraded')
        return { started, skipped: ids.length - started.length, reason: started.length < ids.length ? firstIssue : null }
    })
}

/**
 * Lifetime sales counter behind the merchant milestones. Plain increment, no
 * read. Only town-hall sales count: a player counterparty can be the seller's
 * own second account, and the hall is the one counterparty nobody can be on
 * both sides of.
 */
export function recordEarnings(tx: DbExecutor, playerId: string, coins: number) {
    if (coins <= 0) return
    tx.update(polytownState)
        .set({ coinsEarned: sql`round(${polytownState.coinsEarned} + ${coins}, 4)` })
        .where(eq(polytownState.playerId, playerId))
        .run()
}

// ─── Milestones ──────────────────────────────────────────────────────────────

type MilestoneInput = Pick<SettledTown, 'state' | 'sim' | 'inventory' | 'satisfied'>

export function milestoneSnapshotFor(settled: MilestoneInput, now: number) {
    const derived = deriveTown(settled.sim, settled.state.happiness, now, settled.satisfied)
    return townMilestoneSnapshot(settled.sim, derived, settled.state.happiness, settled.state.plotsBought, settled.state.coinsEarned, now, {
        needsSatisfied: townAllNeedsSatisfied(settled.satisfied)
    })
}

export function serializeMilestones(settled: MilestoneInput, now: number) {
    const snapshot = milestoneSnapshotFor(settled, now)
    const claimed = new Set(settled.state.milestonesClaimed)
    return TOWN_MILESTONES.map((m) => {
        const progress = m.progress(snapshot)
        return {
            id: m.id,
            title: m.title,
            description: m.description,
            emoji: m.emoji,
            reward: m.reward,
            boosters: townMilestoneBoosters(m),
            tier: m.tier,
            chain: m.chain ?? null,
            step: m.step ?? null,
            steps: m.chain ? townMilestoneChainSize(m.chain) : null,
            current: progress.current,
            target: progress.target,
            complete: progress.current >= progress.target,
            claimed: claimed.has(m.id)
        }
    })
}

export function claimMilestone(playerId: string, milestoneId: string) {
    const def = getTownMilestone(milestoneId)
    if (!def) fail('Unknown milestone')
    return writeTx((tx) => {
        const now = Date.now()
        const settled = settleTownState(tx, playerId, now)
        if (!townMilestoneComplete(def, milestoneSnapshotFor(settled, now))) fail('Milestone not reached yet')
        // Claim-then-reward: the NOT-contains guard makes the append the mutex.
        const claimed = tx.update(polytownState)
            .set({ milestonesClaimed: sql`json_insert(${polytownState.milestonesClaimed}, '$[#]', ${def.id})` })
            .where(and(
                eq(polytownState.playerId, playerId),
                sql`not exists (select 1 from json_each(${polytownState.milestonesClaimed}) where value = ${def.id})`
            ))
            .returning({ id: polytownState.playerId })
            .get()
        if (!claimed) fail('Already claimed')
        if (def.reward > 0) creditTownCoins(tx, playerId, def.reward)
        const boosters = townMilestoneBoosters(def)
        addTownBoosters(tx, playerId, boosters)
        return { id: def.id, reward: def.reward, boosters, title: def.title }
    })
}

// ─── System market (floor / ceiling) ─────────────────────────────────────────

/**
 * What one sell of `quantity` would fetch: every resting bid that beats the
 * town hall, best price first, then the hall for whatever is left. Own bids
 * are skipped: filling one would hand your own goods to your own escrow.
 */
function planSweepSell(tx: DbExecutor, playerId: string, resource: TownResourceId, quantity: number) {
    const floor = townPriceFor(resource)
    const restingRows = tx
        .select()
        .from(polytownOrders)
        .where(and(
            eq(polytownOrders.resource, resource),
            eq(polytownOrders.status, 'open'),
            eq(polytownOrders.side, 'buy'),
            gte(polytownOrders.price, floor)
        ))
        .orderBy(desc(polytownOrders.price), asc(polytownOrders.createdAt), asc(sql`rowid`))
        .all()

    const book = restingRows
        .filter(row => row.playerId !== playerId)
        .map(row => ({ id: row.id, userId: row.playerId, price: row.price, remaining: row.quantity - row.filled }))

    const { fills, remaining } = matchTownOrder({ side: 'sell', price: floor, quantity, book })
    let playerTotal = 0
    for (const fill of fills) playerTotal += townOrderTotal(fill.price, fill.quantity)
    const hallTotal = townOrderTotal(floor, remaining)
    return { resource, quantity, floor, fills, remaining, playerTotal, hallTotal, total: playerTotal + hallTotal }
}

type SweepSellPlan = ReturnType<typeof planSweepSell>

/** Fill one resting order by `quantity`; the open-status guard is the claim. */
function fillRestingOrder(tx: DbExecutor, orderId: string, quantity: number) {
    const resting = tx.update(polytownOrders)
        .set({
            filled: sql`${polytownOrders.filled} + ${quantity}`,
            status: sql`case when ${polytownOrders.filled} + ${quantity} >= ${polytownOrders.quantity} then 'filled' else 'open' end`,
            updatedAt: new Date()
        })
        .where(and(eq(polytownOrders.id, orderId), eq(polytownOrders.status, 'open')))
        .returning({ id: polytownOrders.id, status: polytownOrders.status })
        .get()
    if (!resting) fail('Order book conflict', 500)
    return resting
}

/**
 * Apply one planned sweep. The seller's goods leave in a single conditional
 * decrement (the guard for the whole line) and are then handed to the buyers
 * the plan matched, with the rest going to the hall. Only the hall's share
 * reaches recordEarnings.
 */
function applySweepSell(tx: DbExecutor, playerId: string, plan: SweepSellPlan) {
    takeInventory(tx, playerId, plan.resource, plan.quantity)

    for (const fill of plan.fills) {
        const resting = fillRestingOrder(tx, fill.orderId, fill.quantity)
        addInventory(tx, fill.userId, plan.resource, fill.quantity)
        tx.insert(polytownTrades).values({
            resource: plan.resource,
            buyerId: fill.userId,
            sellerId: playerId,
            takerId: playerId,
            price: fill.price,
            quantity: fill.quantity,
            createdAt: new Date()
        }).run()
        recordTownEvent(tx, fill.userId, {
            kind: 'trade',
            side: 'buy',
            resource: plan.resource,
            quantity: fill.quantity,
            price: fill.price,
            coins: townOrderTotal(fill.price, fill.quantity),
            done: resting.status === 'filled'
        })
    }

    if (plan.total > 0) creditTownCoins(tx, playerId, plan.total)
    if (plan.hallTotal > 0) recordEarnings(tx, playerId, plan.hallTotal)
}

/**
 * Market day: half again on what the town hall paid, out of the budget the
 * market days granted. Read and written inside the sell's writeTx, so parallel
 * sells draw the budget down one after another. Only the hall's share counts.
 */
function payMarketBonus(tx: DbExecutor, playerId: string, hallTotal: number, now: number): number {
    if (hallTotal <= 0) return 0
    const state = tx.select({ until: polytownState.marketBoostUntil, left: polytownState.marketBoostBonusLeft })
        .from(polytownState).where(eq(polytownState.playerId, playerId)).get()
    if (!state) return 0
    // Whole cents, the unit the balance is kept in.
    const bonus = Math.floor(townMarketBonus(hallTotal, state.left, isTownBoostActive(state.until?.getTime(), now)) * 100) / 100
    if (bonus <= 0) return 0
    tx.update(polytownState)
        .set({ marketBoostBonusLeft: sql`max(0, round(${polytownState.marketBoostBonusLeft} - ${bonus}, 4))` })
        .where(eq(polytownState.playerId, playerId))
        .run()
    creditTownCoins(tx, playerId, bonus)
    return bonus
}

/**
 * Sell one good for the most coins on offer: the player bids that beat the
 * town hall first, best price first, then the hall for the remainder.
 */
export function sellToFloor(playerId: string, resource: string, quantity: number) {
    if (!isTownResourceId(resource)) fail('Unknown resource')
    if (!isValidTownQuantity(quantity)) fail('Quantity must be a whole number')
    return writeTx((tx) => {
        readTownState(tx, playerId)
        const plan = planSweepSell(tx, playerId, resource, quantity)
        applySweepSell(tx, playerId, plan)
        const marketBonus = payMarketBonus(tx, playerId, plan.hallTotal, Date.now())
        return {
            resource,
            quantity,
            price: plan.floor,
            total: plan.total,
            toPlayers: plan.playerTotal,
            toHall: plan.hallTotal,
            filledByPlayers: quantity - plan.remaining,
            /** Market-day coins paid on top of `total`. */
            marketBonus
        }
    })
}

/**
 * Sell several goods in one transaction, each routed the same way as a single
 * sell. One line per good: two lines planned against the same book could both
 * fill the same resting bid, so lines for the same good are merged.
 */
export function sellBulkToFloor(playerId: string, items: { resource: string, quantity: number }[]) {
    if (!Array.isArray(items) || items.length === 0 || items.length > TOWN_RESOURCES.length) fail('Nothing to sell')
    for (const item of items) {
        if (!isTownResourceId(item.resource)) fail('Unknown resource')
        if (!isValidTownQuantity(item.quantity)) fail('Quantity must be a whole number')
    }
    const merged = new Map<string, number>()
    for (const item of items) merged.set(item.resource, (merged.get(item.resource) ?? 0) + item.quantity)
    for (const quantity of merged.values()) {
        if (!isValidTownQuantity(quantity)) fail('That is more than anyone can hold')
    }
    const order = new Map(TOWN_RESOURCES.map((r, i) => [r.id as string, i]))
    const sorted = [...merged.entries()]
        .map(([resource, quantity]) => ({ resource, quantity }))
        .sort((a, b) => (order.get(a.resource) ?? 0) - (order.get(b.resource) ?? 0))

    return writeTx((tx) => {
        readTownState(tx, playerId)
        let total = 0
        let hallTotal = 0
        const plans: SweepSellPlan[] = []
        for (const item of sorted) {
            const plan = planSweepSell(tx, playerId, item.resource as TownResourceId, item.quantity)
            applySweepSell(tx, playerId, plan)
            plans.push(plan)
            total += plan.total
            hallTotal += plan.hallTotal
        }
        const marketBonus = payMarketBonus(tx, playerId, hallTotal, Date.now())
        const lines = plans.map(plan => ({ resource: plan.resource, quantity: plan.quantity, price: plan.floor, total: plan.total }))
        return { total, lines, resources: plans.filter(plan => plan.fills.length > 0).map(plan => plan.resource), marketBonus }
    })
}

/**
 * Production per hour bucket over the last `hours`, per resource. A settle
 * window that spans several buckets is spread evenly across them.
 */
export function getProductionHistory(playerId: string, hours = 24) {
    const now = Date.now()
    const span = Math.max(1, Math.min(168, Math.floor(hours)))
    const since = new Date(now - span * 3_600_000)
    const rows = db.select().from(polytownProduction)
        .where(and(eq(polytownProduction.playerId, playerId), gte(polytownProduction.toAt, since)))
        .all()
    const bucketMs = 3_600_000
    const start = Math.floor((now - span * bucketMs) / bucketMs) * bucketMs
    const buckets: { at: number, totals: Partial<Record<TownResourceId, number>> }[] = []
    for (let i = 0; i <= span; i++) buckets.push({ at: start + i * bucketMs, totals: {} })
    for (const row of rows) {
        const from = row.fromAt.getTime()
        const to = row.toAt.getTime()
        const first = Math.max(0, Math.floor((from - start) / bucketMs))
        const last = Math.min(buckets.length - 1, Math.floor((to - start) / bucketMs))
        const parts = Math.max(1, last - first + 1)
        for (let i = first; i <= last; i++) {
            const b = buckets[i]!
            const id = row.resource as TownResourceId
            b.totals[id] = (b.totals[id] ?? 0) + row.amount / parts
        }
    }
    return { bucketMs, buckets: buckets.map(b => ({ at: b.at, totals: Object.fromEntries(Object.entries(b.totals).map(([k, v]) => [k, Math.round(v)])) })) }
}

// ─── Player market (order book) ──────────────────────────────────────────────

export interface PlaceTownOrderResult {
    orderId: string
    resource: TownResourceId
    side: 'buy' | 'sell'
    status: 'open' | 'filled'
    quantity: number
    filled: number
    remaining: number
    price: number
    avgFillPrice: number | null
    coinsMoved: number
}

/**
 * Limit order with escrow, matched against the resting book.
 *
 * Any price from a hundredth of a coin up to TOWN_MAX_ORDER_PRICE is allowed,
 * in either direction. Buys escrow town coins (change refunded on cheaper
 * fills), sells escrow the resource.
 */
export function placeTownOrder(
    playerId: string,
    resource: string,
    side: 'buy' | 'sell',
    price: number,
    quantity: number
): PlaceTownOrderResult {
    if (!isTownResourceId(resource)) fail('Unknown resource')
    if (side !== 'buy' && side !== 'sell') fail('Choose buy or sell')
    if (!Number.isFinite(price) || price < TOWN_MARKET_MIN_PRICE) fail(`Price must be at least ${TOWN_MARKET_MIN_PRICE}`)
    if (!isValidTownPrice(price)) fail('Price must have at most 2 decimals')
    if (!isValidTownQuantity(quantity)) fail('Quantity must be a whole number')
    // A price nobody could ever pay is a typo, not an order.
    if (price > TOWN_MAX_ORDER_PRICE) fail(`Price must be ${TOWN_MAX_ORDER_PRICE.toLocaleString('en')} coins or less`)

    return writeTx((tx) => {
        readTownState(tx, playerId)
        const opposite = side === 'buy' ? 'sell' : 'buy'
        const restingRows = tx
            .select()
            .from(polytownOrders)
            .where(and(
                eq(polytownOrders.resource, resource),
                eq(polytownOrders.status, 'open'),
                eq(polytownOrders.side, opposite),
                side === 'buy' ? lte(polytownOrders.price, price) : gte(polytownOrders.price, price)
            ))
            .orderBy(side === 'buy' ? asc(polytownOrders.price) : desc(polytownOrders.price), asc(polytownOrders.createdAt), asc(sql`rowid`))
            .all()

        const book = restingRows.map(row => ({
            id: row.id,
            userId: row.playerId,
            price: row.price,
            remaining: row.quantity - row.filled
        }))
        const { fills, remaining } = matchTownOrder({ side, price, quantity, book })

        const countRow = tx.select({ openCount: sql<number>`count(*)` })
            .from(polytownOrders)
            .where(and(eq(polytownOrders.playerId, playerId), eq(polytownOrders.status, 'open')))
            .get()
        if ((countRow?.openCount ?? 0) >= TOWN_MARKET_MAX_OPEN_ORDERS) fail(`All ${TOWN_MARKET_MAX_OPEN_ORDERS} market slots are in use`)

        if (side === 'buy') debitTownCoins(tx, playerId, townOrderTotal(price, quantity))
        else takeInventory(tx, playerId, resource, quantity)

        let coinsMoved = 0
        for (const fill of fills) {
            const resting = fillRestingOrder(tx, fill.orderId, fill.quantity)
            const fillTotal = townOrderTotal(fill.price, fill.quantity)
            // No recordEarnings here at all: see the note on that function.
            if (side === 'buy') {
                const change = townOrderTotal(price, fill.quantity) - fillTotal
                addInventory(tx, playerId, resource, fill.quantity)
                // Change on a cheaper fill is the player's own escrow coming back.
                if (change > 0) creditTownCoins(tx, playerId, change)
                creditTownCoins(tx, fill.userId, fillTotal)
            } else {
                addInventory(tx, fill.userId, resource, fill.quantity)
                creditTownCoins(tx, playerId, fillTotal)
            }
            coinsMoved += fillTotal
            // The resting mayor was not here to see it: leave them a note.
            recordTownEvent(tx, fill.userId, {
                kind: 'trade',
                side: opposite,
                resource,
                quantity: fill.quantity,
                price: fill.price,
                coins: fillTotal,
                done: resting.status === 'filled'
            })

            tx.insert(polytownTrades).values({
                resource,
                buyerId: side === 'buy' ? playerId : fill.userId,
                sellerId: side === 'buy' ? fill.userId : playerId,
                takerId: playerId,
                price: fill.price,
                quantity: fill.quantity,
                createdAt: new Date()
            }).run()
        }

        const filled = quantity - remaining
        const status = remaining === 0 ? 'filled' as const : 'open' as const
        const now = new Date()
        const order = tx.insert(polytownOrders)
            .values({ playerId, resource, side, price, quantity, filled, status, createdAt: now, updatedAt: now })
            .returning({ id: polytownOrders.id })
            .get()

        return {
            orderId: order.id,
            resource,
            side,
            status,
            quantity,
            filled,
            remaining,
            price,
            avgFillPrice: filled > 0 ? coinsMoved / filled : null,
            coinsMoved
        }
    })
}

export function cancelTownOrder(playerId: string, orderId: string) {
    return writeTx((tx) => {
        const order = tx.update(polytownOrders)
            .set({ status: 'cancelled', updatedAt: new Date() })
            .where(and(eq(polytownOrders.id, orderId), eq(polytownOrders.playerId, playerId), eq(polytownOrders.status, 'open')))
            .returning()
            .get()
        if (!order || !isTownResourceId(order.resource)) {
            const existing = tx.select({ id: polytownOrders.id }).from(polytownOrders).where(and(eq(polytownOrders.id, orderId), eq(polytownOrders.playerId, playerId))).get()
            fail(existing ? 'Order is no longer open' : 'Order not found')
        }

        const remaining = order.quantity - order.filled
        if (remaining > 0) {
            if (order.side === 'buy') creditTownCoins(tx, playerId, townOrderTotal(order.price, remaining))
            else addInventory(tx, playerId, order.resource, remaining)
        }
        return { ok: true, orderId, resource: order.resource, side: order.side, refundedQuantity: remaining }
    })
}

/** One mayor's share of a price level. `mine` lets the client mark the caller's own offers. */
export interface TownBookPlayer {
    id: string
    name: string
    /** The player's avatar (the hub's image), as the mayors board shows it. */
    image: string | null
    quantity: number
    mine: boolean
}

export interface TownBookLevel {
    price: number
    quantity: number
    /** Who is behind the level, biggest share first. */
    players: TownBookPlayer[]
}

export function getTownMarket(resource: string, playerId: string | null) {
    if (!isTownResourceId(resource)) fail('Unknown resource')

    const open = db.select({
        side: polytownOrders.side,
        price: polytownOrders.price,
        playerId: polytownOrders.playerId,
        playerName: players.name,
        playerImage: players.image,
        remaining: sql<number>`${polytownOrders.quantity} - ${polytownOrders.filled}`
    })
        .from(polytownOrders)
        .innerJoin(players, eq(players.id, polytownOrders.playerId))
        .where(and(eq(polytownOrders.resource, resource), eq(polytownOrders.status, 'open')))
        .all()

    const agg = (side: 'buy' | 'sell') => {
        const map = new Map<number, Map<string, TownBookPlayer>>()
        for (const row of open) {
            if (row.side !== side) continue
            let level = map.get(row.price)
            if (!level) map.set(row.price, level = new Map())
            const p = level.get(row.playerId)
            if (p) p.quantity += row.remaining
            else level.set(row.playerId, { id: row.playerId, name: row.playerName, image: row.playerImage, quantity: row.remaining, mine: row.playerId === playerId })
        }
        const levels: TownBookLevel[] = [...map.entries()].map(([price, list]) => {
            const sorted = [...list.values()].sort((a, b) => b.quantity - a.quantity)
            return { price, quantity: sorted.reduce((n, p) => n + p.quantity, 0), players: sorted }
        })
        levels.sort((a, b) => side === 'buy' ? b.price - a.price : a.price - b.price)
        return levels.slice(0, TOWN_MARKET_BOOK_DEPTH)
    }

    // Self-trades are left out of the printed tape, or one account could post
    // any price it likes and have every other mayor read it as the market.
    const trades = db.select()
        .from(polytownTrades)
        .where(and(
            eq(polytownTrades.resource, resource),
            sql`(${polytownTrades.buyerId} is null or ${polytownTrades.sellerId} is null or ${polytownTrades.buyerId} <> ${polytownTrades.sellerId})`
        ))
        .orderBy(desc(polytownTrades.createdAt), desc(sql`rowid`))
        .limit(TOWN_MARKET_HISTORY_LIMIT)
        .all()

    let value = 0
    let volume = 0
    for (const t of trades) {
        if (t.buyerId && t.buyerId === t.sellerId) continue
        value += t.price * t.quantity
        volume += t.quantity
    }
    const floor = townFloorPrice(resource)
    const ceiling = townCeilingPrice(resource)

    const myOrders = playerId
        ? db.select().from(polytownOrders)
            .where(and(eq(polytownOrders.playerId, playerId), eq(polytownOrders.resource, resource), eq(polytownOrders.status, 'open')))
            .orderBy(desc(polytownOrders.createdAt))
            .all()
        : []

    return {
        resource,
        floor,
        ceiling,
        guidePrice: volume > 0 ? value / volume : Math.round(floor * 1.5 * 100) / 100,
        bids: agg('buy'),
        asks: agg('sell'),
        trades: trades.map(t => ({ price: t.price, quantity: t.quantity, at: t.createdAt.getTime(), mine: playerId !== null && (t.buyerId === playerId || t.sellerId === playerId) })),
        myOrders: myOrders.map(o => ({
            id: o.id,
            side: o.side,
            price: o.price,
            quantity: o.quantity,
            filled: o.filled,
            createdAt: o.createdAt.getTime()
        }))
    }
}

/** Every open order of the player across all resources, for the "my orders" panel. */
export function getMyTownOrders(playerId: string) {
    const rows = db.select().from(polytownOrders)
        .where(and(eq(polytownOrders.playerId, playerId), eq(polytownOrders.status, 'open')))
        .orderBy(desc(polytownOrders.createdAt))
        .all()
    return rows.map(o => ({
        id: o.id,
        resource: o.resource,
        side: o.side,
        price: o.price,
        quantity: o.quantity,
        filled: o.filled,
        createdAt: o.createdAt.getTime()
    }))
}

/** The last traded price of every resource: one indexed lookup per resource. A trade with yourself does not count. */
export function getTownLastPrices(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of TOWN_RESOURCES) {
        const row = db.select({ price: polytownTrades.price }).from(polytownTrades)
            .where(and(
                eq(polytownTrades.resource, r.id),
                sql`(${polytownTrades.buyerId} is null or ${polytownTrades.sellerId} is null or ${polytownTrades.buyerId} <> ${polytownTrades.sellerId})`
            ))
            .orderBy(desc(polytownTrades.createdAt), desc(sql`rowid`))
            .limit(1)
            .get()
        if (row) out[r.id] = row.price
    }
    return out
}

export function deleteTownForPlayer(playerId: string, tx: DbExecutor = db) {
    tx.delete(polytownTrades).where(or(eq(polytownTrades.buyerId, playerId), eq(polytownTrades.sellerId, playerId))).run()
    tx.delete(polytownOrders).where(eq(polytownOrders.playerId, playerId)).run()
    tx.delete(polytownProduction).where(eq(polytownProduction.playerId, playerId)).run()
    tx.delete(polytownBuildings).where(eq(polytownBuildings.playerId, playerId)).run()
    tx.delete(polytownStorage).where(eq(polytownStorage.playerId, playerId)).run()
    tx.delete(polytownRedesignDrafts).where(eq(polytownRedesignDrafts.playerId, playerId)).run()
    tx.delete(polytownInventory).where(eq(polytownInventory.playerId, playerId)).run()
    tx.delete(polytownPlots).where(eq(polytownPlots.playerId, playerId)).run()
    tx.delete(polytownEvents).where(eq(polytownEvents.playerId, playerId)).run()
    tx.delete(polytownContracts).where(eq(polytownContracts.playerId, playerId)).run()
    tx.delete(polytownContractDays).where(eq(polytownContractDays.playerId, playerId)).run()
    tx.delete(polytownState).where(eq(polytownState.playerId, playerId)).run()
}
