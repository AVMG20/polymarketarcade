import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '#server/database'
import { polytownState, polytownPlots, polytownBuildings, polytownInventory, polytownOrders, polytownProduction, polytownTrades } from '#server/database/schema'
import {
    buyPlot,
    cancelTownOrder,
    claimMilestone,
    demolishBuilding,
    getTownMarket,
    getTownLastPrices,
    moveBuilding,
    placeBuilding,
    placeTownOrder,
    redesignTown,
    sellBulkToFloor,
    sellToFloor,
    settleTownForRead,
    upgradeBuilding,
    deleteTownForPlayer
} from '#server/utils/polytown/town'
import {
    TOWN_PLOT_SIZE,
    TOWN_TIER_POP_REQUIREMENT,
    TOWN_TIER_PRODUCTION_REQUIREMENT,
    getTownBuilding,
    getTownMilestone,
    townMilestoneBoosters,
    townCeilingPrice,
    townFloorPrice,
    townIndustryNuisance,
    TOWN_SUPPLY_MIN_EFFICIENCY,
    townLevelBuildMs,
    townLevelCost,
    townPlaceCost,
    townPlotCooldownMs,
    townPlotPrice,
    townRushGemCost,
    townWorkersFor,
    TOWN_MAX_ORDER_PRICE,
    TOWN_MARKET_MIN_PRICE,
    TOWN_GEM_MINE_CAP,
    deriveTown,
    settleTown,
    type TownSimBuilding,
    type TownResourceId
} from '#shared/polytown/town'
import { SKIP, burst, cleanupUser, foundTown, getBalance, lockTownRealm, moveTownToFlatGround, seedUser } from './db-helpers'

const OWNER = 'test-town-owner'
const BUYER = 'test-town-buyer'
const SELLER = 'test-town-seller'
const USERS = [OWNER, BUYER, SELLER]

const FARM = getTownBuilding('farm')!
const MILL = getTownBuilding('mill')!
const HOUSE = getTownBuilding('house')!
const ROAD = getTownBuilding('road')!

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Rotation 2 faces −y, so a building on (x, 1) fronts the plot-edge road on (x, 0). */
const FACES_EDGE_ROAD = 2

/**
 * The nearest tile a farm can sit to a house on tile 0 without its smog
 * reaching the residents. Industry inside the radius costs enough happiness to
 * drop a starter town out of Content, and a slower mood means fewer ticks —
 * which is not what the production specs below are measuring.
 */
const QUIET_FARM_TILE = townIndustryNuisance(FARM).radius + 1

/**
 * The smallest town that runs a surplus: a house whose residents eat one grain
 * a tick, and a level-2 farm growing two of them a safe distance away.
 */
const HOUSE_AND_FARM = [
    { type: 'house', tileX: 0 },
    { type: 'farm', tileX: QUIET_FARM_TILE, level: 2 }
]

async function plotsOf(id: string) {
    return db.select().from(polytownPlots).where(eq(polytownPlots.playerId, id))
}

async function buildingsOf(id: string) {
    return db.select().from(polytownBuildings).where(eq(polytownBuildings.playerId, id))
}

async function buildingsTyped(id: string, type: string) {
    return db.select().from(polytownBuildings).where(and(eq(polytownBuildings.playerId, id), eq(polytownBuildings.type, type)))
}

async function stateOf(id: string) {
    const row = await db.query.polytownState.findFirst({ where: eq(polytownState.playerId, id) })
    return row!
}

async function productionOf(id: string) {
    return db.select().from(polytownProduction).where(eq(polytownProduction.playerId, id))
}

async function stock(id: string, resource: TownResourceId, amount: number) {
    await db.insert(polytownInventory).values({ playerId: id, resource, amount })
        .onConflictDoUpdate({ target: [polytownInventory.playerId, polytownInventory.resource], set: { amount } })
}

/**
 * Put exactly the goods a set of costs asks for in the player's warehouse.
 * Placing and upgrading buy materials as well as coins now, so anything that
 * exercises a build has to stock what the current tuning charges for it.
 */
async function stockFor(id: string, ...costs: { resources: Partial<Record<TownResourceId, number>> }[]) {
    const total: Partial<Record<TownResourceId, number>> = {}
    for (const cost of costs) {
        for (const [resource, qty] of Object.entries(cost.resources) as [TownResourceId, number][]) {
            total[resource] = (total[resource] ?? 0) + qty
        }
    }
    for (const [resource, qty] of Object.entries(total) as [TownResourceId, number][]) {
        await stock(id, resource, qty)
    }
}

async function held(id: string, resource: TownResourceId) {
    const row = await db.query.polytownInventory.findFirst({
        where: and(eq(polytownInventory.playerId, id), eq(polytownInventory.resource, resource))
    })
    return row?.amount ?? 0
}

async function openOrders(id: string) {
    return db.select().from(polytownOrders).where(and(eq(polytownOrders.playerId, id), eq(polytownOrders.status, 'open')))
}

/** Backdate the town clock so a settle covers a known window. */
async function rewindSettle(id: string, ms: number) {
    await db.update(polytownState)
        .set({ lastSettledAt: new Date(Date.now() - ms) })
        .where(eq(polytownState.playerId, id))
}

/**
 * A square that touches one of the player's plots and belongs to nobody. The
 * world is shared with every other town in the database, so the free neighbour
 * has to be looked up rather than assumed.
 */
async function freeNeighbour(id: string) {
    const own = await plotsOf(id)
    const taken = new Set((await db.select({ x: polytownPlots.x, y: polytownPlots.y }).from(polytownPlots)).map(p => `${p.x},${p.y}`))
    for (const plot of own) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const square = { x: plot.x + dx, y: plot.y + dy }
            if (!taken.has(`${square.x},${square.y}`)) return square
        }
    }
    throw new Error(`no free square next to ${id}'s town`)
}

/** Backdate the land office clock so the next plot is on sale. */
async function rewindPlotClock(id: string, ms: number) {
    await db.update(polytownState)
        .set({ lastPlotBoughtAt: new Date(Date.now() - ms) })
        .where(eq(polytownState.playerId, id))
}

/**
 * Drop a finished building straight into the world, skipping the build queue
 * (and the road rule with it) — for the tests where placement is not what is
 * under test.
 */
async function seedBuilding(
    playerId: string,
    plotId: string,
    type: string,
    tileX: number,
    level = 1,
    over: { tileY?: number, rotation?: number, completesAt?: Date } = {}
) {
    const [row] = await db.insert(polytownBuildings).values({
        playerId,
        plotId,
        type,
        tileX,
        tileY: over.tileY ?? 0,
        rotation: over.rotation ?? 0,
        level,
        completesAt: over.completesAt ?? new Date(Date.now() - 10 * MINUTE),
        createdAt: new Date(Date.now() - 10 * MINUTE)
    }).returning()
    return row!
}

/** A road on the plot edge at (tileX, 0) — the front door for anything on (tileX, 1). */
async function seedRoad(playerId: string, plotId: string, tileX: number) {
    return seedBuilding(playerId, plotId, 'road', tileX, 1, { tileY: 0 })
}

/**
 * Seed a whole street: one unbroken road along row `roadY` from the first
 * building to the last, and each building on the row above facing it. People
 * only staff what their own roads reach, so a house and a farm seeded for
 * each other have to share a street, not just a row.
 */
async function seedStreet(
    playerId: string,
    plotId: string,
    roadY: number,
    specs: { type: string, tileX: number, level?: number, completesAt?: Date }[]
) {
    const rows = []
    if (specs.length > 0) {
        const xs = specs.map(s => s.tileX)
        for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
            await seedBuilding(playerId, plotId, 'road', x, 1, { tileY: roadY })
        }
    }
    for (const spec of specs) {
        rows.push(await seedBuilding(playerId, plotId, spec.type, spec.tileX, spec.level ?? 1, {
            tileY: roadY + 1,
            rotation: FACES_EDGE_ROAD,
            completesAt: spec.completesAt
        }))
    }
    return rows
}

/** Rewrite the lifetime production ledger the tier gate reads. */
async function seedProduced(playerId: string, produced: Record<string, number>) {
    await db.update(polytownState).set({ produced }).where(eq(polytownState.playerId, playerId))
}

/**
 * A street of houses sheltering `pop` residents, one per tile from tileX 0.
 * The level is worked out from the house's popCap so the row always fits on
 * the plot, however few residents a single house level is worth.
 */
function housingFor(pop: number, tiles = TOWN_PLOT_SIZE - 1) {
    const level = Math.ceil(pop / (HOUSE.popCap * tiles))
    const count = Math.ceil(pop / (HOUSE.popCap * level))
    return Array.from({ length: count }, (_, i) => ({ type: 'house', tileX: i, level }))
}

/**
 * Everything tier 2 asks for: a finished tier-1 building, the residents to
 * staff it, and the lifetime output that no amount of coins can buy.
 */
async function unlockTier2(playerId: string, plotId: string) {
    await seedStreet(playerId, plotId, 5, [
        { type: 'farm', tileX: 7 },
        ...housingFor(TOWN_TIER_POP_REQUIREMENT[2]!)
    ])
    const gate = TOWN_TIER_PRODUCTION_REQUIREMENT[2]!
    await seedProduced(playerId, { wheat: gate.amount })
}

// These specs share the order book with whatever else uses the database (a
// running dev server included). Cancel every open order — refunding its owner's
// escrow properly — so a stray real offer can never cross a test one.
async function clearBook() {
    const open = await db.select().from(polytownOrders).where(eq(polytownOrders.status, 'open'))
    for (const order of open) {
        try {
            cancelTownOrder(order.playerId, order.id)
        } catch {
            // Already gone.
        }
    }
}

// Trades reference users with SET NULL, so they must go before the users do.
async function cleanup() {
    await clearBook()
    await db.delete(polytownTrades).where(or(inArray(polytownTrades.buyerId, USERS), inArray(polytownTrades.sellerId, USERS)))
    await db.delete(polytownOrders).where(inArray(polytownOrders.playerId, USERS))
    // deleteTownForPlayer clears these too; doing it here as well keeps the table
    // clean for the users whose town was already deleted by a spec.
    await db.delete(polytownProduction).where(inArray(polytownProduction.playerId, USERS))
    await Promise.all(USERS.map(async (id) => {
        await deleteTownForPlayer(id)
        await cleanupUser(id)
    }))
}

/**
 * Crews cap how many builds can run at once, which every one of these tests
 * would otherwise trip over while setting a town up. Give them plenty.
 */
async function unlimitedBuilders(playerId: string) {
    await db.update(polytownState).set({ builders: 99 }).where(eq(polytownState.playerId, playerId))
}

/**
 * Seed a player, found their town, and hand back their only plot. The plot is
 * moved onto flat grassland: these specs build on fixed tile coordinates, and
 * terrain would otherwise decide which of them are water and which grow more
 * than the spec asks for.
 */
async function foundFor(id: string, opts: { balance?: string, gems?: number } = {}) {
    await seedUser(id, opts)
    const { plotId } = await foundTown(id)
    await moveTownToFlatGround(plotId)
    await unlimitedBuilders(id)
    return plotId
}

/**
 * Order-book prices in these specs used to be literals a coin or two above the
 * old wheat floor. Express them against the floor instead, so retuning prices
 * never breaks a test that is really about the book.
 */
const WHEAT_FLOOR = townFloorPrice('wheat')
/** A price `n` steps above the floor, still inside the band. */
const over = (n: number) => Math.round(WHEAT_FLOOR + n * WHEAT_FLOOR * 0.1)
/** Coins as a fixed-4 string, the shape getBalance hands back. */
const coins = (n: number) => n.toFixed(4)
/** A purse that covers any order these specs place, with change left over. */
const PURSE = over(5) * 20

describe.skipIf(SKIP)('polytown (database)', () => {
    // One shared realm: hold it for this file so a sibling spec cannot plant
    // or delete plots midway through a test here (db-helpers, lockTownRealm).
    let releaseRealm: () => Promise<void>
    beforeAll(async () => {
        releaseRealm = await lockTownRealm()
        await cleanup()
    }, 120_000)
    afterEach(cleanup)
    afterAll(async () => {
        await releaseRealm()
    })

    describe('foundTown', () => {
        it('creates the town state and hands over the free founding plot', async () => {
            await seedUser(OWNER)
            const { stateId, plotId } = await foundTown(OWNER)
            await unlimitedBuilders(OWNER)

            expect(stateId).toBeTruthy()
            const state = await stateOf(OWNER)
            expect(state.plotsBought).toBe(1)
            expect(state.happiness).toBe(50)
            expect(state.produced).toEqual({})

            const plots = await plotsOf(OWNER)
            expect(plots).toHaveLength(1)
            expect(plots[0]!.id).toBe(plotId)

            // A second founding is refused and leaves the first town alone.
            expect(() => foundTown(OWNER)).toThrow(/already have a town/)
            expect(await plotsOf(OWNER)).toHaveLength(1)
        })
    })

    describe('placeBuilding', () => {
        it('charges the coins and queues the build', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await placeBuilding(OWNER, plotId, 2, 0, 'road')
            await stockFor(OWNER, townPlaceCost(FARM, 0))

            const happiness = (await stateOf(OWNER)).happiness
            const before = Date.now()
            const result = await placeBuilding(OWNER, plotId, 2, 1, 'farm', FACES_EDGE_ROAD)

            expect(result.cost.coins).toBe(townPlaceCost(FARM, 0).coins)
            const spent = townPlaceCost(ROAD, 0).coins + townPlaceCost(FARM, 0).coins
            expect(await getBalance(OWNER)).toBe((100000 - spent).toFixed(4))

            const [farm] = await buildingsTyped(OWNER, 'farm')
            expect(farm!.level).toBe(0)
            expect(farm!.upgradingTo).toBeNull()
            expect(farm!.tileX).toBe(2)
            expect(farm!.tileY).toBe(1)
            expect(farm!.rotation).toBe(FACES_EDGE_ROAD)

            const expected = before + townLevelBuildMs(FARM, 1, happiness)
            expect(Math.abs(farm!.completesAt.getTime() - expected)).toBeLessThan(5_000)
        })

        it('rejects a tile that is off the plot, or a plot owned by someone else', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            const otherPlot = await foundFor(BUYER, { balance: '100000.0000' })

            expect(() => placeBuilding(OWNER, plotId, 8, 0, 'farm')).toThrow(/off the plot/)
            expect(() => placeBuilding(OWNER, plotId, 0, -1, 'farm')).toThrow(/off the plot/)
            expect(() => placeBuilding(OWNER, plotId, 0, 0, 'castle')).toThrow(/Unknown building/)
            expect(() => placeBuilding(OWNER, otherPlot, 0, 0, 'farm')).toThrow(/not yours/)

            expect(await buildingsOf(OWNER)).toHaveLength(0)
            expect(await getBalance(OWNER)).toBe('100000.0000')
        })

        it('builds nothing when the coins are short', async () => {
            const plotId = await foundFor(OWNER, { balance: '100.0000' })
            await seedRoad(OWNER, plotId, 0)

            expect(() => placeBuilding(OWNER, plotId, 0, 1, 'farm', FACES_EDGE_ROAD)).toThrow()

            expect(await buildingsTyped(OWNER, 'farm')).toHaveLength(0)
            expect(await getBalance(OWNER)).toBe('100.0000')
        })

        it('charges the repeat price for every further copy', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            await seedRoad(OWNER, plotId, 0)
            await seedRoad(OWNER, plotId, 1)
            await stockFor(OWNER, townPlaceCost(FARM, 0), townPlaceCost(FARM, 1))

            const first = await placeBuilding(OWNER, plotId, 0, 1, 'farm', FACES_EDGE_ROAD)
            const second = await placeBuilding(OWNER, plotId, 1, 1, 'farm', FACES_EDGE_ROAD)

            expect(first.cost.coins).toBe(townPlaceCost(FARM, 0).coins)
            expect(second.cost.coins).toBe(townPlaceCost(FARM, 1).coins)
            expect(second.cost.coins).toBeGreaterThan(first.cost.coins)
            expect(await getBalance(OWNER)).toBe((1000000 - first.cost.coins - second.cost.coins).toFixed(4))
        })

        it('lets only one of ten concurrent placements on one tile through', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            await seedRoad(OWNER, plotId, 4)
            const cost = townPlaceCost(FARM, 0)
            // Ten placements' worth of timber, so the tile is the only guard left.
            await stockFor(OWNER, ...Array.from({ length: 10 }, () => cost))

            const result = await burst(10, () => placeBuilding(OWNER, plotId, 4, 1, 'farm', FACES_EDGE_ROAD))

            expect(result.ok).toBe(1)
            expect(await buildingsTyped(OWNER, 'farm')).toHaveLength(1)
            expect(await getBalance(OWNER)).toBe((1000000 - cost.coins).toFixed(4))
            // Exactly one placement's worth of timber left the warehouse.
            expect(await held(OWNER, 'wood')).toBe(9 * cost.resources.wood!)
        })

        it('refuses a tier-2 building until a tier-1 one has finished', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            await seedRoad(OWNER, plotId, 0)
            await seedStreet(OWNER, plotId, 5, housingFor(TOWN_TIER_POP_REQUIREMENT[2]!))
            await seedProduced(OWNER, { wheat: TOWN_TIER_PRODUCTION_REQUIREMENT[2]!.amount })
            const cost = townPlaceCost(MILL, 0)
            await stock(OWNER, 'wood', cost.resources.wood!)
            await stock(OWNER, 'stone', cost.resources.stone!)

            expect(() => placeBuilding(OWNER, plotId, 0, 1, 'mill', FACES_EDGE_ROAD)).toThrow(/tier 1/)

            // A farm still under construction does not unlock the tier either.
            await seedStreet(OWNER, plotId, 5, [{ type: 'farm', tileX: 7, level: 0, completesAt: new Date(Date.now() + 10 * MINUTE) }])
            expect(() => placeBuilding(OWNER, plotId, 0, 1, 'mill', FACES_EDGE_ROAD)).toThrow(/tier 1/)

            expect(await buildingsTyped(OWNER, 'mill')).toHaveLength(0)
            expect(await getBalance(OWNER)).toBe('1000000.0000')
            expect(await held(OWNER, 'wood')).toBe(cost.resources.wood!)
            expect(await held(OWNER, 'stone')).toBe(cost.resources.stone!)
        })

        it('refuses a tier-2 building until the town has made enough tier-1 goods', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            await unlockTier2(OWNER, plotId)
            await seedRoad(OWNER, plotId, 0)
            const gate = TOWN_TIER_PRODUCTION_REQUIREMENT[2]!
            await seedProduced(OWNER, { wheat: gate.amount - 1 })
            const cost = townPlaceCost(MILL, 0)
            await stock(OWNER, 'wood', cost.resources.wood!)
            await stock(OWNER, 'stone', cost.resources.stone!)

            expect(() => placeBuilding(OWNER, plotId, 0, 1, 'mill', FACES_EDGE_ROAD)).toThrow(new RegExp(`producing ${gate.amount} tier-${gate.tier} goods`))

            // One more unit of lifetime output and the tier opens, charging
            // the coins and exactly the goods the mill costs.
            await seedProduced(OWNER, { wheat: gate.amount })
            await placeBuilding(OWNER, plotId, 0, 1, 'mill', FACES_EDGE_ROAD)
            expect(await buildingsTyped(OWNER, 'mill')).toHaveLength(1)
            expect(await held(OWNER, 'wood')).toBe(0)
            expect(await held(OWNER, 'stone')).toBe(0)
            expect(await getBalance(OWNER)).toBe((1000000 - cost.coins).toFixed(4))
        })

        it('rolls the coin charge back when the resources fall short', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            await unlockTier2(OWNER, plotId)
            await seedRoad(OWNER, plotId, 0)
            const cost = townPlaceCost(MILL, 0)
            await stock(OWNER, 'wood', cost.resources.wood!)
            await stock(OWNER, 'stone', 1)

            expect(() => placeBuilding(OWNER, plotId, 0, 1, 'mill', FACES_EDGE_ROAD)).toThrow(/Not enough Stone/)

            expect(await getBalance(OWNER)).toBe('1000000.0000')
            expect(await held(OWNER, 'wood')).toBe(cost.resources.wood!)
            expect(await held(OWNER, 'stone')).toBe(1)
            expect(await buildingsTyped(OWNER, 'mill')).toHaveLength(0)
        })
    })

    describe('moveBuilding', () => {
        it('moves a finished building onto another road', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await seedRoad(OWNER, plotId, 0)
            await seedRoad(OWNER, plotId, 5)
            const farm = await seedBuilding(OWNER, plotId, 'farm', 0, 1, { tileY: 1, rotation: FACES_EDGE_ROAD })

            const result = await moveBuilding(OWNER, farm.id, plotId, 5, 1, FACES_EDGE_ROAD)

            expect(result).toMatchObject({ buildingId: farm.id, tileX: 5, tileY: 1, rotation: FACES_EDGE_ROAD })
            const [row] = await buildingsTyped(OWNER, 'farm')
            expect(row!.tileX).toBe(5)
            expect(row!.tileY).toBe(1)
            // Moving is free.
            expect(await getBalance(OWNER)).toBe('100000.0000')
        })

        it('moves a building that is still going up without touching its clock', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await seedRoad(OWNER, plotId, 0)
            await seedRoad(OWNER, plotId, 5)
            const completesAt = new Date(Date.now() + HOUR)
            const site = await seedBuilding(OWNER, plotId, 'farm', 0, 0, {
                tileY: 1,
                rotation: FACES_EDGE_ROAD,
                completesAt
            })

            await moveBuilding(OWNER, site.id, plotId, 5, 1, FACES_EDGE_ROAD)
            expect(() => moveBuilding(OWNER, 'no-such-building', plotId, 4, 1, FACES_EDGE_ROAD)).toThrow(/not found/i)

            const [moved] = await buildingsTyped(OWNER, 'farm')
            expect(moved!.tileX).toBe(5)
            expect(moved!.level).toBe(0)
            expect(moved!.completesAt.getTime()).toBe(completesAt.getTime())
        })

        it('refuses an occupied target tile', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await seedRoad(OWNER, plotId, 0)
            await seedRoad(OWNER, plotId, 5)
            const farm = await seedBuilding(OWNER, plotId, 'farm', 0, 1, { tileY: 1, rotation: FACES_EDGE_ROAD })
            await seedBuilding(OWNER, plotId, 'house', 5, 1, { tileY: 1, rotation: FACES_EDGE_ROAD })

            expect(() => moveBuilding(OWNER, farm.id, plotId, 5, 1, FACES_EDGE_ROAD)).toThrow(/already taken/)
            expect((await buildingsTyped(OWNER, 'farm'))[0]!.tileX).toBe(0)
        })

        it('rejects a rotation or a tile that is not on the board', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            const farm = await seedBuilding(OWNER, plotId, 'farm', 0, 1, { tileY: 1 })

            expect(() => moveBuilding(OWNER, farm.id, plotId, 1, 1, 4)).toThrow(/quarter turns/)
            expect(() => moveBuilding(OWNER, farm.id, plotId, TOWN_PLOT_SIZE, 1, 0)).toThrow(/off the plot/)
        })
    })

    describe('redesignTown', () => {
        it('moves every building, drops the roads left out and lays new ones for coins', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            const roadA = await seedRoad(OWNER, plotId, 0)
            const roadB = await seedRoad(OWNER, plotId, 1)
            const house = await seedBuilding(OWNER, plotId, 'house', 0, 2, { tileY: 1, rotation: FACES_EDGE_ROAD })
            const farm = await seedBuilding(OWNER, plotId, 'farm', 1, 1, { tileY: 1, rotation: FACES_EDGE_ROAD, completesAt: new Date(Date.now() + HOUR) })

            const res = await redesignTown(OWNER, {
                moves: [
                    { buildingId: roadA.id, plotId, tileX: 4, tileY: 4, rotation: 0 },
                    { buildingId: house.id, plotId, tileX: 4, tileY: 5, rotation: 0 },
                    // The farm takes the house's old tile: the shuffle is legal.
                    { buildingId: farm.id, plotId, tileX: 0, tileY: 1, rotation: 1 }
                ],
                roads: [{ plotId, tileX: 5, tileY: 4 }, { plotId, tileX: 6, tileY: 4 }]
            })

            expect(res.moved).toEqual([roadA.id, house.id, farm.id])
            expect(res.removed).toEqual([roadB.id])
            expect(res.built).toHaveLength(2)
            const rows = await buildingsOf(OWNER)
            expect(rows).toHaveLength(5)
            expect(rows.find(r => r.id === house.id)).toMatchObject({ tileX: 4, tileY: 5, level: 2 })
            expect(rows.find(r => r.id === farm.id)).toMatchObject({ tileX: 0, tileY: 1, rotation: 1, level: 1 })
            expect(rows.find(r => r.id === farm.id)!.completesAt.getTime()).toBe(farm.completesAt.getTime())
            expect(rows.find(r => r.id === roadB.id)).toBeUndefined()
            // Two new roads, priced as the second and third road standing after the save.
            const road = getTownBuilding('road')!
            const coins = townPlaceCost(road, 1).coins + townPlaceCost(road, 2).coins
            expect(res.coins).toBe(coins)
            expect(await getBalance(OWNER)).toBe((100000 - coins).toFixed(4))
        })

        it('refuses to save while a building is still in the tray', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await seedRoad(OWNER, plotId, 0)
            const house = await seedBuilding(OWNER, plotId, 'house', 0, 1, { tileY: 1, rotation: FACES_EDGE_ROAD })
            await seedBuilding(OWNER, plotId, 'farm', 1, 1, { tileY: 1, rotation: FACES_EDGE_ROAD })

            expect(() => redesignTown(OWNER, {
                moves: [{ buildingId: house.id, plotId, tileX: 3, tileY: 3, rotation: 0 }],
                roads: []
            })).toThrow(/has to be placed/)

            // Nothing moved, nothing removed.
            expect(await buildingsOf(OWNER)).toHaveLength(3)
            expect((await buildingsOf(OWNER)).find(b => b.id === house.id)).toMatchObject({ tileX: 0, tileY: 1 })
            expect(await buildingsTyped(OWNER, 'road')).toHaveLength(1)
        })

        it('refuses a layout that lands two pieces on one tile, or one on water, or a road it cannot pay for', async () => {
            const plotId = await foundFor(OWNER, { balance: '0.0000' })
            const house = await seedBuilding(OWNER, plotId, 'house', 0, 1, { tileY: 1 })
            const farm = await seedBuilding(OWNER, plotId, 'farm', 1, 1, { tileY: 1 })
            const both = (x: number) => [
                { buildingId: house.id, plotId, tileX: x, tileY: 2, rotation: 0 },
                { buildingId: farm.id, plotId, tileX: x, tileY: 2, rotation: 0 }
            ]
            expect(() => redesignTown(OWNER, { moves: both(2), roads: [] })).toThrow(/already taken/)
            expect(() => redesignTown(OWNER, {
                moves: [{ buildingId: house.id, plotId, tileX: 2, tileY: 2, rotation: 0 }, { buildingId: farm.id, plotId, tileX: 3, tileY: 2, rotation: 0 }],
                roads: [{ plotId, tileX: 2, tileY: 2 }]
            })).toThrow(/already taken/)
            expect(() => redesignTown(OWNER, {
                moves: [{ buildingId: house.id, plotId, tileX: 2, tileY: 2, rotation: 0 }, { buildingId: farm.id, plotId, tileX: 3, tileY: 2, rotation: 0 }],
                roads: [{ plotId, tileX: 4, tileY: 2 }]
            })).toThrow()
            expect((await buildingsOf(OWNER)).find(b => b.id === house.id)).toMatchObject({ tileX: 0, tileY: 1 })
        })
    })

    describe('demolishBuilding', () => {
        it('refuses a building that belongs to someone else', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await foundFor(BUYER, { balance: '100000.0000' })
            const road = await seedRoad(OWNER, plotId, 0)

            expect(() => demolishBuilding(BUYER, road.id)).toThrow(/not found/i)
            expect(() => demolishBuilding(OWNER, 'no-such-building')).toThrow(/not found/i)
            expect(await buildingsOf(OWNER)).toHaveLength(1)
        })
    })

    describe('upgradeBuilding', () => {
        it('charges the next level and marks the building as upgrading', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            const building = await seedBuilding(OWNER, plotId, 'farm', 0)
            const cost = townLevelCost(FARM, 2)
            for (const [id, qty] of Object.entries(cost.resources)) await stock(OWNER, id as TownResourceId, qty)

            const result = await upgradeBuilding(OWNER, building.id)

            expect(result.level).toBe(2)
            expect(result.cost.coins).toBe(cost.coins)
            expect(await getBalance(OWNER)).toBe((1000000 - cost.coins).toFixed(4))
            for (const id of Object.keys(cost.resources)) expect(await held(OWNER, id as TownResourceId)).toBe(0)

            const [row] = await buildingsTyped(OWNER, 'farm')
            expect(row!.level).toBe(1)
            expect(row!.upgradingTo).toBe(2)
        })

        it('refuses to upgrade a road, or a building that is still going up', async () => {
            const plotId = await foundFor(OWNER, { balance: '1000000.0000' })
            const road = await seedRoad(OWNER, plotId, 0)
            await stockFor(OWNER, townPlaceCost(FARM, 0))
            const { buildingId } = await placeBuilding(OWNER, plotId, 0, 1, 'farm', FACES_EDGE_ROAD)

            expect(() => upgradeBuilding(OWNER, buildingId)).toThrow(/under construction/)
            expect(() => upgradeBuilding(OWNER, road.id)).toThrow(/no levels/)
            expect(() => upgradeBuilding(OWNER, 'no-such-building')).toThrow(/not found/i)
        })

        it('lets only one of five concurrent upgrades charge the player', async () => {
            const plotId = await foundFor(OWNER, { balance: '10000000.0000' })
            const building = await seedBuilding(OWNER, plotId, 'farm', 0)
            const cost = townLevelCost(FARM, 2)
            // Five upgrades' worth of timber, so the CAS is the only guard left.
            for (const [id, qty] of Object.entries(cost.resources)) await stock(OWNER, id as TownResourceId, qty * 5)

            const result = await burst(5, () => upgradeBuilding(OWNER, building.id))

            expect(result.ok).toBe(1)
            const [row] = await buildingsTyped(OWNER, 'farm')
            expect(row!.upgradingTo).toBe(2)
            expect(await getBalance(OWNER)).toBe((10000000 - cost.coins).toFixed(4))
            for (const [id, qty] of Object.entries(cost.resources)) {
                expect(await held(OWNER, id as TownResourceId)).toBe(qty * 4)
            }
        })
    })

    describe('buyPlot', () => {
        it('makes a fresh town wait out the land office cooldown', async () => {
            await foundFor(OWNER, { balance: '10000000.0000' })
            const square = await freeNeighbour(OWNER)

            expect(() => buyPlot(OWNER, square.x, square.y)).toThrow(/not selling to you yet/)

            // Off cooldown, it still only sells land that shares an edge with the town.
            await rewindPlotClock(OWNER, townPlotCooldownMs(2) + MINUTE)
            const [plot] = await plotsOf(OWNER)
            expect(() => buyPlot(OWNER, plot!.x + 5, plot!.y)).toThrow(/must touch a plot you own/)
            expect(() => buyPlot(OWNER, plot!.x + 1, plot!.y + 1)).toThrow(/must touch a plot you own/)
            expect(() => buyPlot(OWNER, plot!.x + 0.5, plot!.y)).toThrow(/Pick a square/)

            expect(await plotsOf(OWNER)).toHaveLength(1)
            expect(await getBalance(OWNER)).toBe('10000000.0000')
        })

        it('sells exactly one plot to five concurrent buyers', async () => {
            await foundFor(OWNER, { balance: '10000000.0000' })
            await rewindPlotClock(OWNER, townPlotCooldownMs(2) + MINUTE)
            const square = await freeNeighbour(OWNER)

            const result = await burst(5, () => buyPlot(OWNER, square.x, square.y))

            expect(result.ok).toBe(1)
            expect(await plotsOf(OWNER)).toHaveLength(2)
            expect((await stateOf(OWNER)).plotsBought).toBe(2)
            expect(await getBalance(OWNER)).toBe((10000000 - townPlotPrice(2)).toFixed(4))
        })
    })

    describe('settleTownForRead', () => {
        // A house (its residents eat 1 grain a tick) and a level-2 farm (2 grain
        // a tick): five and a half minutes at 50 happiness is five whole ticks
        // of one surplus wheat each.
        async function surplusTown(balance = '100000.0000') {
            const plotId = await foundFor(OWNER, { balance })
            await seedStreet(OWNER, plotId, 3, HOUSE_AND_FARM)
            return plotId
        }

        it('advances production and carries the leftover tick progress', async () => {
            await surplusTown()
            await rewindSettle(OWNER, 5 * MINUTE + 30_000)

            const settled = await settleTownForRead(OWNER)

            expect(settled.inventory.wheat).toBe(5)
            expect(await held(OWNER, 'wheat')).toBe(5)
            expect(settled.satisfied).toEqual({ wheat: true })
            expect(settled.state.tickProgressMs).toBeGreaterThan(0)
            expect(settled.state.lastSettledAt.getTime()).toBeGreaterThan(Date.now() - 10_000)

            // Settling again straight away must not mint anything extra.
            const again = await settleTownForRead(OWNER)
            expect(again.inventory.wheat).toBe(settled.inventory.wheat)
        })

        it('bakes a finished build into the building row', async () => {
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            await seedStreet(OWNER, plotId, 3, [{ type: 'house', tileX: 0 }])
            await seedRoad(OWNER, plotId, 1)
            await stockFor(OWNER, townPlaceCost(FARM, 0))
            const { buildingId } = await placeBuilding(OWNER, plotId, 1, 1, 'farm', FACES_EDGE_ROAD)
            await db.update(polytownBuildings)
                .set({ completesAt: new Date(Date.now() - MINUTE) })
                .where(eq(polytownBuildings.id, buildingId))
            await rewindSettle(OWNER, 5 * MINUTE)

            const settled = await settleTownForRead(OWNER)

            expect(settled.completed).toEqual([{ id: buildingId, level: 1 }])
            expect(settled.buildings.find(b => b.id === buildingId)!.level).toBe(1)
        })

        it('keeps a workshop\'s unfinished fraction in town_state between settles', async () => {
            // A mill with no farm anywhere runs at the supply floor: a whole
            // tick grinds only a fraction of a flour, so without a carry it
            // would never finish one at all.
            const plotId = await foundFor(OWNER, { balance: '100000.0000' })
            const [, mill] = await seedStreet(OWNER, plotId, 3, [
                { type: 'house', tileX: 0 },
                { type: 'mill', tileX: townIndustryNuisance(MILL).radius + 1 }
            ])
            await stock(OWNER, 'wheat', 100)
            const perTick = MILL.outputs.flour! * TOWN_SUPPLY_MIN_EFFICIENCY
            expect(perTick).toBeLessThan(1)

            // Five ticks: one and a half flour's worth of grinding.
            await rewindSettle(OWNER, 5 * MINUTE + 30_000)
            const settled = await settleTownForRead(OWNER)
            expect(settled.inventory.flour).toBe(Math.floor(5 * perTick))
            const carried = (await stateOf(OWNER)).carry[mill!.id]!
            expect(carried.flour).toBeCloseTo(5 * perTick - Math.floor(5 * perTick))

            // A short second window — two ticks, three with the progress the
            // first one left over — grinds well under a whole flour on its
            // own. Picking the carry back up is what finishes the second one.
            await rewindSettle(OWNER, 2 * MINUTE + 30_000)
            const again = await settleTownForRead(OWNER)
            const carriedAgain = (await stateOf(OWNER)).carry[mill!.id]!.flour!
            const ticks = Math.round((again.inventory.flour! + carriedAgain) / perTick)
            expect(again.inventory.flour! + carriedAgain).toBeCloseTo(ticks * perTick)
            expect(ticks).toBeGreaterThanOrEqual(7)
            expect(ticks).toBeLessThanOrEqual(8)
            expect(Math.floor((ticks - 5) * perTick)).toBe(0)
            expect(again.inventory.flour).toBe(Math.floor(ticks * perTick))
            expect(again.inventory.flour).toBe(2)
        })

        it('logs every positive delta to the production table and the lifetime ledger', async () => {
            await surplusTown()
            await rewindSettle(OWNER, 5 * MINUTE + 30_000)

            const settled = await settleTownForRead(OWNER)

            const rows = await productionOf(OWNER)
            expect(rows).toHaveLength(1)
            expect(rows[0]!.resource).toBe('wheat')
            expect(rows[0]!.amount).toBe(settled.delta.wheat)
            expect(rows[0]!.toAt.getTime()).toBeGreaterThan(rows[0]!.fromAt.getTime())
            expect((await stateOf(OWNER)).produced).toEqual({ wheat: settled.delta.wheat })

            // A second settle over no time logs nothing new.
            await settleTownForRead(OWNER)
            expect(await productionOf(OWNER)).toHaveLength(1)
        })
    })

    describe('sellToFloor', () => {
        it('pays the floor price and takes the goods', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 10)

            const result = await sellToFloor(OWNER, 'wheat', 4)

            expect(result.price).toBe(townFloorPrice('wheat'))
            expect(result.total).toBe(townFloorPrice('wheat') * 4)
            expect(await getBalance(OWNER)).toBe(result.total.toFixed(4))
            expect(await held(OWNER, 'wheat')).toBe(6)
        })

        it('will not buy goods the player does not have', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 3)

            expect(() => sellToFloor(OWNER, 'wheat', 4)).toThrow(/Not enough Wheat/)
            expect(() => sellToFloor(OWNER, 'gold', 1)).toThrow(/Unknown resource/)
            expect(() => sellToFloor(OWNER, 'wheat', 0)).toThrow(/whole number/)

            expect(await held(OWNER, 'wheat')).toBe(3)
            expect(await getBalance(OWNER)).toBe('0.0000')
        })

        it('sells the same stack only once under a concurrent burst', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 10)

            const result = await burst(10, () => sellToFloor(OWNER, 'wheat', 10))

            expect(result.ok).toBe(1)
            expect(await held(OWNER, 'wheat')).toBe(0)
            expect(await getBalance(OWNER)).toBe((townFloorPrice('wheat') * 10).toFixed(4))
        })

        it('takes the best bids above the floor before the town hall gets a look', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE * 100) })
            await stock(OWNER, 'wheat', 10)

            // Two mayors bidding over the floor, and one under it.
            await placeTownOrder(BUYER, 'wheat', 'buy', over(20), 3)
            await placeTownOrder(BUYER, 'wheat', 'buy', over(5), 2)
            await placeTownOrder(BUYER, 'wheat', 'buy', WHEAT_FLOOR - 1, 5)

            const result = await sellToFloor(OWNER, 'wheat', 8)

            // Best bid first, then the next, then the hall for the remaining 3.
            const expected = over(20) * 3 + over(5) * 2 + WHEAT_FLOOR * 3
            expect(result.filledByPlayers).toBe(5)
            expect(result.toPlayers).toBe(over(20) * 3 + over(5) * 2)
            expect(result.toHall).toBe(WHEAT_FLOOR * 3)
            expect(result.total).toBe(expected)
            expect(await getBalance(OWNER)).toBe(expected.toFixed(4))
            expect(await held(OWNER, 'wheat')).toBe(2)
            expect(await held(BUYER, 'wheat')).toBe(5)

            // The under-floor bid is still resting: the hall beat it.
            expect(await openOrders(BUYER)).toHaveLength(1)
        })

        it('leaves your own bids alone rather than trading with yourself', async () => {
            await foundFor(OWNER, { balance: coins(PURSE * 100) })
            await stock(OWNER, 'wheat', 5)
            await placeTownOrder(OWNER, 'wheat', 'buy', over(20), 5)
            const before = await getBalance(OWNER)

            const result = await sellToFloor(OWNER, 'wheat', 5)

            expect(result.filledByPlayers).toBe(0)
            expect(result.total).toBe(WHEAT_FLOOR * 5)
            expect(await getBalance(OWNER)).toBe((parseFloat(before) + WHEAT_FLOOR * 5).toFixed(4))
            expect(await openOrders(OWNER)).toHaveLength(1)
        })

        it('counts only the town hall share toward lifetime earnings', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE * 100) })
            await stock(OWNER, 'wheat', 10)
            await placeTownOrder(BUYER, 'wheat', 'buy', over(20), 6)

            await sellToFloor(OWNER, 'wheat', 10)

            expect((await stateOf(OWNER)).coinsEarned).toBe(WHEAT_FLOOR * 4)
        })
    })

    describe('sellBulkToFloor', () => {
        it('credits the whole basket and empties each line', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 10)
            await stock(OWNER, 'wood', 5)
            await stock(OWNER, 'stone', 3)

            const result = await sellBulkToFloor(OWNER, [
                { resource: 'wheat', quantity: 4 },
                { resource: 'wood', quantity: 5 },
                { resource: 'stone', quantity: 3 }
            ])

            const expected = townFloorPrice('wheat') * 4 + townFloorPrice('wood') * 5 + townFloorPrice('stone') * 3
            expect(result.total).toBe(expected)
            expect(result.lines).toHaveLength(3)
            expect(await getBalance(OWNER)).toBe(expected.toFixed(4))
            expect(await held(OWNER, 'wheat')).toBe(6)
            expect(await held(OWNER, 'wood')).toBe(0)
            expect(await held(OWNER, 'stone')).toBe(0)
            expect((await stateOf(OWNER)).coinsEarned).toBe(expected)
        })

        it('merges a good listed twice into one line', async () => {
            // Two lines for one good would each plan against the same book and
            // then both fill the same resting bid, taking more off it than the
            // bidder escrowed.
            await foundFor(OWNER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE * 100) })
            await stock(OWNER, 'wheat', 10)
            await placeTownOrder(BUYER, 'wheat', 'buy', over(20), 4)

            const result = await sellBulkToFloor(OWNER, [
                { resource: 'wheat', quantity: 3 },
                { resource: 'wheat', quantity: 3 }
            ])

            expect(result.lines).toHaveLength(1)
            expect(result.lines[0]!.quantity).toBe(6)
            expect(result.total).toBe(over(20) * 4 + WHEAT_FLOOR * 2)
            expect(await held(OWNER, 'wheat')).toBe(4)
            expect(await held(BUYER, 'wheat')).toBe(4)
            // The bid took its four and no more.
            expect(await openOrders(BUYER)).toHaveLength(0)
        })

        it('rolls the whole basket back when one line is short', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 10)
            await stock(OWNER, 'wood', 1)

            expect(() => sellBulkToFloor(OWNER, [
                { resource: 'wheat', quantity: 10 },
                { resource: 'wood', quantity: 5 }
            ])).toThrow(/Not enough Wood/)

            // The wheat line ran first and still has to be undone.
            expect(await held(OWNER, 'wheat')).toBe(10)
            expect(await held(OWNER, 'wood')).toBe(1)
            expect(await getBalance(OWNER)).toBe('0.0000')
            expect((await stateOf(OWNER)).coinsEarned).toBe(0)
        })

        it('validates the basket before it touches anything', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 10)

            expect(() => sellBulkToFloor(OWNER, [])).toThrow(/Nothing to sell/)
            expect(() => sellBulkToFloor(OWNER, [{ resource: 'gold', quantity: 1 }])).toThrow(/Unknown resource/)
            expect(() => sellBulkToFloor(OWNER, [{ resource: 'wheat', quantity: 0 }])).toThrow(/whole number/)

            expect(await held(OWNER, 'wheat')).toBe(10)
            expect(await getBalance(OWNER)).toBe('0.0000')
        })

        it('sells one basket to ten concurrent callers', async () => {
            await foundFor(OWNER, { balance: '0.0000' })
            await stock(OWNER, 'wheat', 10)
            await stock(OWNER, 'wood', 10)

            const result = await burst(10, () => sellBulkToFloor(OWNER, [
                { resource: 'wheat', quantity: 10 },
                { resource: 'wood', quantity: 10 }
            ]))

            expect(result.ok).toBe(1)
            expect(await held(OWNER, 'wheat')).toBe(0)
            expect(await held(OWNER, 'wood')).toBe(0)
            expect(await getBalance(OWNER))
                .toBe((townFloorPrice('wheat') * 10 + townFloorPrice('wood') * 10).toFixed(4))
        })
    })

    describe('player market', () => {
        it('escrows the seller stock and fills a crossing buy at the resting price', async () => {
            await foundFor(SELLER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE) })
            await stock(SELLER, 'wheat', 10)

            const sell = await placeTownOrder(SELLER, 'wheat', 'sell', over(1), 10)
            expect(sell.status).toBe('open')
            expect(await held(SELLER, 'wheat')).toBe(0)

            const buy = await placeTownOrder(BUYER, 'wheat', 'buy', over(3), 10)

            expect(buy.status).toBe('filled')
            expect(buy.filled).toBe(10)
            expect(buy.avgFillPrice).toBe(over(1))
            // Escrowed at the bid, paid at the resting ask, the rest is change.
            expect(await getBalance(BUYER)).toBe(coins(PURSE - over(1) * 10))
            expect(await getBalance(SELLER)).toBe(coins(over(1) * 10))
            expect(await held(BUYER, 'wheat')).toBe(10)

            const trades = await db.select().from(polytownTrades).where(eq(polytownTrades.sellerId, SELLER))
            expect(trades).toHaveLength(1)
            expect(trades[0]!.quantity).toBe(10)
            expect(trades[0]!.price).toBe(over(1))
        })

        it('counts nothing toward lifetime earnings, whichever side crosses', async () => {
            // A player counterparty can be the seller's own second account, so
            // no trade between players may move the counter the milestones pay
            // out on (the Magnate goal alone is ten million coins and gems):
            // two accounts passing goods back and forth at a price they choose
            // is free. Only the town hall can vouch for a sale.
            await foundFor(SELLER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE) })
            await stock(SELLER, 'wheat', 16)

            // Seller rests, buyer crosses.
            await placeTownOrder(SELLER, 'wheat', 'sell', over(1), 10)
            await placeTownOrder(BUYER, 'wheat', 'buy', over(3), 10)
            // …and the other way round.
            await placeTownOrder(BUYER, 'wheat', 'buy', over(2), 6)
            await placeTownOrder(SELLER, 'wheat', 'sell', over(0), 6)

            expect((await stateOf(SELLER)).coinsEarned).toBe(0)
            expect((await stateOf(BUYER)).coinsEarned).toBe(0)
            // The seller was still paid both times.
            expect(parseFloat(await getBalance(SELLER))).toBe(over(1) * 10 + over(2) * 6)
        })

        it('leaves the unmatched remainder resting on the book', async () => {
            await foundFor(SELLER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE) })
            await stock(SELLER, 'wheat', 10)

            await placeTownOrder(SELLER, 'wheat', 'sell', over(1), 10)
            const buy = await placeTownOrder(BUYER, 'wheat', 'buy', over(1), 4)

            expect(buy.status).toBe('filled')
            const [resting] = await openOrders(SELLER)
            expect(resting!.filled).toBe(4)
            expect(resting!.quantity).toBe(10)
            expect(await held(BUYER, 'wheat')).toBe(4)
        })

        it('refunds the resource on a cancelled sell and the coins on a cancelled buy', async () => {
            await foundFor(SELLER, { balance: '0.0000' })
            await foundFor(BUYER, { balance: coins(PURSE) })
            await stock(SELLER, 'wheat', 10)

            const sell = await placeTownOrder(SELLER, 'wheat', 'sell', over(1), 10)
            const sellCancel = await cancelTownOrder(SELLER, sell.orderId)
            expect(sellCancel.refundedQuantity).toBe(10)
            expect(await held(SELLER, 'wheat')).toBe(10)

            const buy = await placeTownOrder(BUYER, 'wheat', 'buy', over(5), 10)
            expect(await getBalance(BUYER)).toBe(coins(PURSE - over(5) * 10))
            await cancelTownOrder(BUYER, buy.orderId)
            expect(await getBalance(BUYER)).toBe(coins(PURSE))

            expect(() => cancelTownOrder(BUYER, buy.orderId)).toThrow(/no longer open/)
        })

        it('takes any price a mayor names, and refuses only the typos', async () => {
            const floor = townFloorPrice('wheat')
            await foundFor(BUYER, { balance: coins(PURSE * 100) })

            expect(() => placeTownOrder(BUYER, 'wheat', 'buy', 0, 1)).toThrow(/at least/)
            expect(() => placeTownOrder(BUYER, 'wheat', 'buy', TOWN_MAX_ORDER_PRICE + 1, 1)).toThrow(/or less/)
            expect(() => placeTownOrder(BUYER, 'wheat', 'buy', over(1) + 0.005, 1)).toThrow(/2 decimals/)
            expect(() => placeTownOrder(BUYER, 'wheat', 'buy', over(1), 1.5)).toThrow(/whole number/)
            expect(() => placeTownOrder(BUYER, 'gold', 'buy', over(1), 1)).toThrow(/Unknown resource/)

            expect(await openOrders(BUYER)).toHaveLength(0)
            expect(await getBalance(BUYER)).toBe(coins(PURSE * 100))

            // Any price is allowed, under the floor as well as over it: what a
            // good is worth to another mayor is between the two of them, and a
            // sell that beats nobody simply never gets taken.
            await placeTownOrder(BUYER, 'wheat', 'buy', floor, 1)
            const under = await placeTownOrder(BUYER, 'wheat', 'buy', TOWN_MARKET_MIN_PRICE, 1)
            expect(under.status).toBe('open')
            expect(() => placeTownOrder(BUYER, 'wheat', 'sell', townCeilingPrice('wheat') * 50, 0)).toThrow(/whole number/)
            await foundFor(SELLER, { balance: '0.0000' })
            await stock(SELLER, 'wheat', 1)
            const wayAbove = await placeTownOrder(SELLER, 'wheat', 'sell', townCeilingPrice('wheat') * 100, 1)
            expect(wayAbove.status).toBe('open')
        })

        it('keeps a self-trade out of the price every other mayor reads', async () => {
            await foundFor(SELLER, { balance: coins(PURSE * 100) })
            await stock(SELLER, 'wheat', 2)

            const before = (await getTownLastPrices()).wheat
            await placeTownOrder(SELLER, 'wheat', 'sell', over(50), 1)
            await placeTownOrder(SELLER, 'wheat', 'buy', over(50), 1)

            expect((await getTownLastPrices()).wheat).toBe(before)
            const market = await getTownMarket('wheat', SELLER)
            expect(market.trades.every(t => t.price !== over(50))).toBe(true)
        })

        it('gives escrow back without the bank taking a cut', async () => {
            // Money coming back that the player already owned is not an
            // earning; a cancelled order must not cost a debtor 10% to place.
            await foundFor(BUYER, { balance: coins(PURSE) })
            const order = await placeTownOrder(BUYER, 'wheat', 'buy', over(1), 5)
            await cancelTownOrder(BUYER, order.orderId)

            expect(await getBalance(BUYER)).toBe(coins(PURSE))
        })

        it('places nothing when the escrow cannot be paid', async () => {
            await foundFor(BUYER, { balance: '1.0000' })
            await foundFor(SELLER, { balance: '0.0000' })
            await stock(SELLER, 'wheat', 1)

            expect(() => placeTownOrder(BUYER, 'wheat', 'buy', over(1), 10)).toThrow()
            expect(() => placeTownOrder(SELLER, 'wheat', 'sell', over(1), 10)).toThrow(/Not enough Wheat/)

            expect(await openOrders(BUYER)).toHaveLength(0)
            expect(await openOrders(SELLER)).toHaveLength(0)
            expect(await getBalance(BUYER)).toBe('1.0000')
            expect(await held(SELLER, 'wheat')).toBe(1)
        })

        it('records the trade history a fill produces', async () => {
            await foundFor(BUYER, { balance: coins(PURSE * 100) })
            await foundFor(SELLER, { balance: '0.0000' })
            await stock(SELLER, 'wheat', 6)

            await placeTownOrder(BUYER, 'wheat', 'buy', over(2), 6)
            const sell = await placeTownOrder(SELLER, 'wheat', 'sell', over(0), 6)

            // The seller crossed a resting bid, so they are paid the higher bid.
            expect(sell.status).toBe('filled')
            expect(sell.avgFillPrice).toBe(over(2))
            expect(await getBalance(SELLER)).toBe(coins(over(2) * 6))

            // The book is shared with whatever else uses this database (a dev
            // server's real trades included), so only assert on our own fill.
            const market = await getTownMarket('wheat', BUYER)
            const mine = market.trades.filter(t => t.mine)
            expect(mine).toHaveLength(1)
            expect(mine[0]).toMatchObject({ price: over(2), quantity: 6, mine: true })
            expect(market.guidePrice).toBeGreaterThanOrEqual(market.floor)
            expect(market.guidePrice).toBeLessThanOrEqual(market.ceiling)
            expect(market.bids).toEqual([])
        })
    })

    describe('claimMilestone', () => {
        it('pays a completed milestone exactly once under a concurrent burst', async () => {
            const plotId = await foundFor(OWNER, { balance: '0.0000', gems: 0 })
            await seedBuilding(OWNER, plotId, 'house', 0)
            const def = getTownMilestone('first-home')!
            const boosters = townMilestoneBoosters(def)
            // The early goals pay boosters (the old site's gems), so the
            // booster store is what a burst could double up on.
            expect(Object.keys(boosters).length).toBeGreaterThan(0)

            const result = await burst(10, () => claimMilestone(OWNER, 'first-home'))

            expect(result.ok).toBe(1)
            expect(await getBalance(OWNER)).toBe(def.reward.toFixed(4))
            expect((await stateOf(OWNER)).boosters).toEqual(boosters)
            expect((await stateOf(OWNER)).milestonesClaimed).toEqual(['first-home'])

            expect(() => claimMilestone(OWNER, 'first-home')).toThrow(/Already claimed/)
            expect(await getBalance(OWNER)).toBe(def.reward.toFixed(4))
            expect((await stateOf(OWNER)).boosters).toEqual(boosters)
        })

        it('refuses a milestone the town has not reached', async () => {
            const plotId = await foundFor(OWNER, { balance: '0.0000' })

            expect(() => claimMilestone(OWNER, 'first-home')).toThrow(/not reached yet/)
            expect(() => claimMilestone(OWNER, 'merchant')).toThrow(/not reached yet/)
            expect(() => claimMilestone(OWNER, 'no-such-milestone')).toThrow(/Unknown milestone/)

            // A house that is still going up does not count as built.
            await seedBuilding(OWNER, plotId, 'house', 0, 0, { completesAt: new Date(Date.now() + 10 * MINUTE) })
            expect(() => claimMilestone(OWNER, 'first-home')).toThrow(/not reached yet/)

            expect(await getBalance(OWNER)).toBe('0.0000')
            expect((await stateOf(OWNER)).milestonesClaimed).toEqual([])
        })
    })

    describe('jewel mine', () => {
        const GEM_MINE = getTownBuilding('gemmine')!

        /** A street of houses and `mines` jewel mines at `level`, every mine fully staffed. */
        function minedTown(mines: number, level: number, now: number): TownSimBuilding[] {
            const out: TownSimBuilding[] = []
            const workers = townWorkersFor(GEM_MINE, level) * mines
            const houseLevel = Math.ceil(workers / (HOUSE.popCap * 8))
            const count = Math.ceil(workers / (HOUSE.popCap * houseLevel))
            const road = (wx: number) => ({ id: `r${wx}`, type: 'road' as const, level: 1, completesAt: 0, upgradingTo: null, createdAt: 0, wx, wy: 0, rotation: 0 })
            for (let x = 0; x < count + mines; x++) out.push(road(x))
            for (let x = 0; x < count; x++) out.push({ id: `h${x}`, type: 'house', level: houseLevel, completesAt: 0, upgradingTo: null, createdAt: 0, wx: x, wy: 1, rotation: FACES_EDGE_ROAD })
            for (let x = 0; x < mines; x++) out.push({ id: `m${x}`, type: 'gemmine', level, completesAt: 0, upgradingTo: null, createdAt: 1, wx: count + x, wy: 1, rotation: FACES_EDGE_ROAD })
            void now
            return out
        }

        it('stops digging once the warehouse is full of jewels', () => {
            const now = Date.now()
            const buildings = minedTown(1, 1, now)
            const derived = deriveTown(buildings, 50, now)

            const full = settleTown({ happiness: 50, tickProgressMs: 0, lastSettledAt: now - 8 * HOUR, inventory: { jewels: derived.storageCap }, buildings }, now)
            expect(full.delta.jewels ?? 0).toBe(0)
            const room = settleTown({ happiness: 50, tickProgressMs: 0, lastSettledAt: now - 8 * HOUR, inventory: {}, buildings }, now)
            expect(room.delta.jewels ?? 0).toBeGreaterThan(0)
        })

        it('never grows past the mine cap, even inside one drag', async () => {
            const plotId = await foundFor(OWNER, { balance: coins(1_000_000_000) })
            await unlockTier2(OWNER, plotId)
            for (let x = 0; x < 8; x++) await seedRoad(OWNER, plotId, x)
            await stockFor(OWNER, ...Array.from({ length: TOWN_GEM_MINE_CAP + 1 }, (_, i) => townPlaceCost(GEM_MINE, i)))

            for (let i = 0; i < TOWN_GEM_MINE_CAP; i++) {
                await placeBuilding(OWNER, plotId, i, 1, 'gemmine', FACES_EDGE_ROAD)
            }
            expect(() => placeBuilding(OWNER, plotId, TOWN_GEM_MINE_CAP, 1, 'gemmine', FACES_EDGE_ROAD)).toThrow(/only have/)
            expect(await buildingsTyped(OWNER, 'gemmine')).toHaveLength(TOWN_GEM_MINE_CAP)
        })
    })
})
