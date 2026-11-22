import { eq } from 'drizzle-orm'
import { db, writeTx } from '../../server/database'
import { players, polytownPlots, polytownState } from '../../server/database/schema'
import { upsertPlayer } from '../../server/utils/players'
import { foundTown as foundTownOnServer, rushTownJob, townCents } from '../../server/utils/polytown/town'
import { townPlotIsFlat, townSpiralCoords } from '../../shared/polytown/town'

/**
 * The old site's town DB specs, on the arcade's SQLite: every spec file gets
 * its own database (test/setup/env.ts), so nothing here has to be skipped or
 * serialized against a shared realm.
 */

export const SKIP = false

/** The old specs serialized on a shared Postgres realm; each file has its own SQLite file here. */
export async function lockTownRealm(): Promise<() => Promise<void>> {
    return async () => {}
}

/** Coins to give a player's town when it is founded (the old site seeded them on the user's balance). */
const pendingCoins = new Map<string, number>()

/** Set a town's coins outright. */
export function setTownCoins(id: string, coins: number) {
    db.update(polytownState).set({ coinsCents: townCents(coins) }).where(eq(polytownState.playerId, id)).run()
}

/**
 * A player with the given id, as the old specs' `seedUser`. `balance` becomes
 * the town's coins: at once when the town exists, else when it is founded
 * (through `foundTown` below). Gems live at the hub, so they are ignored.
 */
export async function seedUser(id: string, { balance = '0', origin = 'hub' }: { balance?: string, gems?: number, origin?: 'hub' | 'dev' } = {}) {
    upsertPlayer({ sub: id, name: 'concurrency test user', image: null, title: null }, origin)
    const coins = parseFloat(balance)
    const town = db.select({ id: polytownState.playerId }).from(polytownState).where(eq(polytownState.playerId, id)).get()
    if (town) setTownCoins(id, coins)
    else pendingCoins.set(id, coins)
}

/** Found the town, then give it the coins `seedUser` asked for instead of the starter grant. */
export function foundTown(id: string) {
    const result = foundTownOnServer(id)
    const coins = pendingCoins.get(id)
    if (coins !== undefined) {
        setTownCoins(id, coins)
        pendingCoins.delete(id)
    }
    return result
}

/** Everything of a player's goes with the player row (every Polytown table cascades). */
export async function cleanupUser(id: string) {
    pendingCoins.delete(id)
    db.delete(players).where(eq(players.id, id)).run()
}

/** The town's coins as the old `getBalance` handed them back: a fixed-4 string. */
export async function getBalance(id: string): Promise<string> {
    const row = db.select({ cents: polytownState.coinsCents }).from(polytownState).where(eq(polytownState.playerId, id)).get()
    return ((row?.cents ?? 0) / 100).toFixed(4)
}

const FLAT_SCAN_BASE = 250_000
let flatScanCursor = 0

/**
 * Move a town's plot onto flat grassland: no water and no production bonuses,
 * so a fixture's tile coordinates mean exactly what they say.
 */
export async function moveTownToFlatGround(plotId: string) {
    for (let i = 0; i < 20_000; i++) {
        const spot = townSpiralCoords(FLAT_SCAN_BASE + flatScanCursor++)
        if (!townPlotIsFlat(spot.x, spot.y)) continue
        try {
            const moved = db.update(polytownPlots).set({ x: spot.x, y: spot.y }).where(eq(polytownPlots.id, plotId)).returning().get()
            if (moved) return moved
        } catch {
            // Somebody else's plot already sits there: take the next square.
        }
    }
    throw new Error('no free flat ground left in the test realm')
}

/** Fire `fn` n times at once; the server's calls are synchronous, so each runs whole before the next. */
export async function burst<T>(n: number, fn: (i: number) => T | Promise<T>) {
    const results = await Promise.allSettled(Array.from({ length: n }, async (_, i) => fn(i)))
    return {
        ok: results.filter(r => r.status === 'fulfilled').length,
        rejected: results.filter(r => r.status === 'rejected').length
    }
}

/** What a synchronous call threw, for `toMatchObject` on the error. */
export function caught(fn: () => unknown): unknown {
    try {
        fn()
    } catch (error) {
        return error
    }
    throw new Error('expected the call to throw')
}

/** Finish a running job at once, as the gem rush does once the hub has been paid. */
export function rushBuilding(playerId: string, buildingId: string) {
    return writeTx(tx => rushTownJob(tx, playerId, buildingId, Date.now()))
}
