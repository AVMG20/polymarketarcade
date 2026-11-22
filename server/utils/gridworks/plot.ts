import { eq } from 'drizzle-orm'
import { db, writeTx, type DbExecutor } from '#server/database/index'
import { gridworksPlot, players } from '#server/database/schema'
import { randomInt } from '#shared/utils/random'
import { newState, settle, type GridState, type SettleEvent } from '#shared/gridworks/game'
import { broadcastGridworks } from './live'

type PlotRow = typeof gridworksPlot.$inferSelect

export function toState(row: PlotRow): GridState {
    return {
        seed: row.seed,
        entities: row.entities,
        chunks: row.chunks,
        stock: row.stock,
        done: row.researchDone,
        queue: row.researchQueue,
        progress: row.researchProgress,
        mine: row.mine,
        settledAt: row.lastSettledAt.getTime(),
        layout: row.layoutVersion,
        goals: row.goals,
        mined: row.mined
    }
}

function toRow(s: GridState) {
    return {
        entities: s.entities,
        chunks: s.chunks,
        stock: s.stock,
        researchDone: s.done,
        researchQueue: s.queue,
        researchProgress: s.progress,
        mine: s.mine,
        layoutVersion: s.layout,
        goals: s.goals,
        mined: s.mined,
        lastSettledAt: new Date(s.settledAt),
        updatedAt: new Date()
    }
}

/** Creates the player's plot on first visit. Safe under parallel calls. */
export function ensurePlot(playerId: string, exec: DbExecutor = db): void {
    const now = Date.now()
    const s = newState(randomInt(1, 2 ** 31 - 1), now)
    exec.insert(gridworksPlot).values({
        playerId,
        seed: s.seed,
        ...toRow(s)
    }).onConflictDoNothing({ target: gridworksPlot.playerId }).run()
}

export function readPlot(playerId: string, exec: DbExecutor = db): GridState | null {
    const row = exec.select().from(gridworksPlot).where(eq(gridworksPlot.playerId, playerId)).get()
    return row ? toState(row) : null
}

/**
 * Lock-then-read in one synchronous `writeTx` (`BEGIN IMMEDIATE`): ensures the
 * plot exists, settles it to now, hands it to `fn` to mutate, then writes it
 * back. Every state-changing action goes through here.
 */
export function withPlot<T>(playerId: string, fn: (s: GridState, now: number, events: SettleEvent[]) => T): { state: GridState, result: T, events: SettleEvent[] } {
    return writeTx((tx) => {
        ensurePlot(playerId, tx)
        const row = tx.select().from(gridworksPlot).where(eq(gridworksPlot.playerId, playerId)).get()
        if (!row) throw createError({ statusCode: 404, statusMessage: 'No plot' })
        const s = toState(row)
        const now = Math.max(Date.now(), s.settledAt)
        const events = settle(playerId, s, now)
        const result = fn(s, now, events)
        tx.update(gridworksPlot).set(toRow(s)).where(eq(gridworksPlot.playerId, playerId)).run()
        return { state: s, result, events }
    })
}

/** The plot as of now, without writing (reads never need a write transaction). */
export function viewPlot(playerId: string): GridState {
    ensurePlot(playerId)
    const s = readPlot(playerId)
    if (!s) throw createError({ statusCode: 404, statusMessage: 'No plot' })
    settle(playerId, s, Math.max(Date.now(), s.settledAt))
    return s
}

export interface WorldPlot {
    playerId: string
    name: string
    image: string | null
    seed: number
    entities: GridState['entities']
    chunks: string[]
    done: number
    layout: number
}

/** The world list is the same for everyone, so one query serves every watcher until a plot changes. */
const WORLD_TTL_MS = 5_000
let worldCache: { at: number, plots: WorldPlot[] } | null = null

export function clearWorldCache() {
    worldCache = null
}

export function worldPlots(): WorldPlot[] {
    const hit = worldCache
    if (hit && Date.now() - hit.at < WORLD_TTL_MS) return hit.plots
    const rows = db.select({
        playerId: gridworksPlot.playerId,
        name: players.name,
        image: players.image,
        seed: gridworksPlot.seed,
        entities: gridworksPlot.entities,
        chunks: gridworksPlot.chunks,
        done: gridworksPlot.researchDone,
        layout: gridworksPlot.layoutVersion
    }).from(gridworksPlot).innerJoin(players, eq(players.id, gridworksPlot.playerId)).orderBy(gridworksPlot.createdAt).all()
    const plots = rows.map(r => ({ ...r, done: r.done.length }))
    worldCache = { at: Date.now(), plots }
    return plots
}

export function notifyPlotChanged(playerId: string, layout: number) {
    clearWorldCache()
    broadcastGridworks(playerId, layout)
}
