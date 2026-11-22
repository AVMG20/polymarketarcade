// Local dev: a Polytown town that owns every building at every look, to walk
// around the artwork in the real game (and to screenshot it). Five plots in a
// row, one per look (level 1, 5, 10, 15, 20); buildings that cap lower show
// their top look. Ported from the old site's scripts/seed-town-test.ts.
//
//   bun scripts/polytown-seed-test.ts
//
// Then sign in with the dev login as "Town Test" (/api/dev/login?name=Town%20Test).
// Re-running rebuilds that one town; nothing else in the database is touched.
import { eq } from 'drizzle-orm'
import { db, writeTx } from '../server/database/index.ts'
import {
    players, polytownBuildings, polytownContractDays, polytownContracts, polytownEvents, polytownInventory, polytownOrders, polytownPlots,
    polytownProduction, polytownRedesignDrafts, polytownState, polytownStorage, polytownStreak
} from '../server/database/schema.ts'
import { TOWN_BUILDINGS, TOWN_PLOT_SIZE, townBuildingMaxLevel } from '../shared/polytown/town.ts'

const NAME = 'Town Test'
/** What /api/dev/login?name=Town Test signs in as (server/api/dev/login.get.ts derives the id from the name). */
const PLAYER_ID = `dev-${NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
const LEVELS = [1, 5, 10, 15, 20]
/** Right beside the towns near the origin, so it shows up when you look around; moved east if taken. */
const ORIGIN = { x: 2, y: -1 }

const existing = db.select({ id: players.id }).from(players).where(eq(players.id, PLAYER_ID)).get()
if (existing) {
    // Only this player's Polytown rows; trades stay as price history (their ids are nulled when a player goes).
    writeTx((tx) => {
        for (const table of [polytownOrders, polytownProduction, polytownBuildings, polytownStorage, polytownRedesignDrafts, polytownInventory, polytownPlots, polytownEvents, polytownContracts, polytownContractDays, polytownStreak, polytownState]) {
            tx.delete(table).where(eq(table.playerId, PLAYER_ID)).run()
        }
    })
    console.log('Removed the previous test town')
} else {
    db.insert(players).values({ id: PLAYER_ID, name: NAME, origin: 'dev', title: 'Newcomer' }).run()
}

// Five free squares in a row, starting at ORIGIN and walking east past anybody's land.
const taken = new Set(db.select({ x: polytownPlots.x, y: polytownPlots.y }).from(polytownPlots).all().map(p => `${p.x},${p.y}`))
let startX = ORIGIN.x
while (LEVELS.some((_, i) => taken.has(`${startX + i},${ORIGIN.y}`))) startX++

const now = new Date()
const past = new Date(now.getTime() - 60_000)
const types = TOWN_BUILDINGS.filter(b => b.kind !== 'road')

writeTx((tx) => {
    tx.insert(polytownState).values({
        playerId: PLAYER_ID,
        coinsCents: 100_000_000 * 100,
        plotsBought: LEVELS.length,
        happiness: 100,
        lastSettledAt: now,
        lastPlotBoughtAt: now
    }).run()

    for (const [i, level] of LEVELS.entries()) {
        const plot = tx.insert(polytownPlots).values({ playerId: PLAYER_ID, x: startX + i, y: ORIGIN.y, createdAt: new Date(now.getTime() + i) }).returning().get()
        const rows: typeof polytownBuildings.$inferInsert[] = []
        const put = (type: string, tileX: number, tileY: number, lvl: number) =>
            rows.push({ playerId: PLAYER_ID, plotId: plot.id, type, tileX, tileY, level: lvl, completesAt: past, createdAt: past })
        // Every building type on the first rows, a road, then a street of houses.
        const slots: [number, number][] = []
        for (const ty of [0, 1, 3, 4, 6, 7]) for (let tx = 0; tx < TOWN_PLOT_SIZE; tx++) slots.push([tx, ty])
        types.forEach((def, n) => put(def.id, slots[n]![0], slots[n]![1], Math.min(level, townBuildingMaxLevel(def))))
        for (let n = types.length; n < slots.length; n++) put('house', slots[n]![0], slots[n]![1], level)
        for (const ty of [2, 5]) for (let tx = 0; tx < TOWN_PLOT_SIZE; tx++) put('road', tx, ty, 1)
        tx.insert(polytownBuildings).values(rows).run()
        console.log(`Plot ${startX + i},${ORIGIN.y}: level ${level}, ${rows.length} tiles`)
    }
})

console.log(`Sign in as ${NAME}: /api/dev/login?name=${encodeURIComponent(NAME)}&return=/polytown (player ${PLAYER_ID})`)
