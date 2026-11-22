import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db, writeTx } from '../../server/database'
import { polytownBuildings, polytownGemSpends, polytownInventory, polytownPlots, polytownState, polytownStorage, starReports } from '../../server/database/schema'
import { buyTownBooster, getHubGems, hireTownBuilder, rushBuildingWithGems } from '../../server/utils/polytown/gems'
import {
    addTownBoosters,
    buyPlot,
    cancelTownOrder,
    claimMilestone,
    creditTownCoins,
    debitTownCoins,
    foundTown as foundTownOnServer,
    getTownCoins,
    placeBuilding,
    placeTownOrder,
    sellPlotToSystem,
    startTownBooster
} from '../../server/utils/polytown/town'
import { upsertPlayer } from '../../server/utils/players'
import { syncStars } from '../../server/utils/stars'
import { TOWN_BOOSTER_GEM_PRICES, TOWN_BOOST_MS } from '../../shared/polytown/town-boosts'
import { TOWN_BUILDER_GEM_COSTS, TOWN_STARTER_COINS, getTownMilestone, townMilestoneBoosters, townPlotPrice, townPlotRefundFor, townRushGemCost } from '../../shared/polytown/town'
import { burst, foundTown, moveTownToFlatGround, seedUser, setTownCoins } from './db-helpers'

/**
 * What the arcade adds around the old game: the town's own coins, the booster
 * store, gem perks bought at the hub, and the star level.
 */

// The hub, as these specs need it: a gem pile per player, spends that burn
// from it (one per idempotency key), refunds that give back, star sets that
// are accepted.
const hubState = vi.hoisted(() => ({
    gems: new Map<string, number>(),
    spends: new Map<string, { playerId: string, amount: number, refunded: boolean }>(),
    keys: new Map<string, string>(),
    refunds: [] as string[],
    down: false
}))
vi.mock('#server/utils/hub', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#server/utils/hub')>()
    return {
        ...actual,
        hub: {
            ...actual.hub,
            getPlayer: async (playerId: string) => ({ id: playerId, name: 'x', image: null, gems: hubState.gems.get(playerId) ?? 0, stars: 0, title: 'Newcomer' }),
            setStars: async ({ stars }: { stars: number }) => ({ applied: true, stars, best: stars, bounty: 0, total: stars, title: 'Newcomer' })
        },
        spendGems: async ({ idempotencyKey, playerId, amount }: { idempotencyKey: string, playerId: string, amount: number }) => {
            if (hubState.down) throw new actual.HubError('fetch failed', null)
            const replay = hubState.keys.get(idempotencyKey)
            if (replay) return { spendId: replay, gems: hubState.gems.get(playerId) ?? 0 }
            const have = hubState.gems.get(playerId) ?? 0
            if (have < amount) throw new actual.HubError('Not enough gems', 400)
            hubState.gems.set(playerId, have - amount)
            const spendId = `spend-${hubState.spends.size + 1}`
            hubState.spends.set(spendId, { playerId, amount, refunded: false })
            hubState.keys.set(idempotencyKey, spendId)
            return { spendId, gems: have - amount }
        },
        refundGems: async (spendId: string) => {
            const spend = hubState.spends.get(spendId)!
            if (!spend.refunded) {
                spend.refunded = true
                hubState.gems.set(spend.playerId, (hubState.gems.get(spend.playerId) ?? 0) + spend.amount)
                hubState.refunds.push(spendId)
            }
            return { gems: hubState.gems.get(spend.playerId) ?? 0 }
        }
    }
})

let counter = 0
async function mayor(opts: { coins?: number, gems?: number, origin?: 'hub' | 'dev' } = {}) {
    const id = `arcade-mayor-${counter++}`
    await seedUser(id, { origin: opts.origin })
    const { plotId } = foundTown(id)
    await moveTownToFlatGround(plotId)
    if (opts.coins !== undefined) setTownCoins(id, opts.coins)
    hubState.gems.set(id, opts.gems ?? 0)
    return { id, plotId }
}

function state(id: string) {
    return db.select().from(polytownState).where(eq(polytownState.playerId, id)).get()!
}

function stock(id: string, resource: string, amount: number) {
    db.insert(polytownInventory).values({ playerId: id, resource, amount })
        .onConflictDoUpdate({ target: [polytownInventory.playerId, polytownInventory.resource], set: { amount } }).run()
}

/** A house under construction, finishing `ms` from now. */
function job(id: string, plotId: string, tileX: number, ms: number, type = 'house') {
    return db.insert(polytownBuildings)
        .values({ playerId: id, plotId, type, tileX, tileY: 3, level: 0, completesAt: new Date(Date.now() + ms) })
        .returning().get()
}

afterEach(() => {
    hubState.down = false
    hubState.refunds.length = 0
})

describe('town coins', () => {
    it('founds a town with the starter grant', async () => {
        const id = `arcade-mayor-${counter++}`
        upsertPlayer({ sub: id, name: 'Founder', image: null, title: null })
        foundTownOnServer(id)
        expect(getTownCoins(id)).toBe(TOWN_STARTER_COINS)
        expect(() => foundTownOnServer(id)).toThrow(/already have a town/)
        expect(getTownCoins(id)).toBe(TOWN_STARTER_COINS)
    })

    it('never lets a debit take the balance below zero, however many race for it', async () => {
        const { id } = await mayor({ coins: 100 })
        const { ok } = await burst(10, () => writeTx(tx => debitTownCoins(tx, id, 30)))
        expect(ok).toBe(3)
        expect(getTownCoins(id)).toBe(10)
        expect(() => writeTx(tx => debitTownCoins(tx, id, 10.01))).toThrow(/Insufficient balance/)
        writeTx(tx => creditTownCoins(tx, id, 0.015))
        // Whole cents: half a cent rounds.
        expect(getTownCoins(id)).toBe(10.02)
    })

    it('charges a placement from the town\'s coins and refuses one it can\'t afford', async () => {
        const { id, plotId } = await mayor({ coins: 1_500 })
        placeBuilding(id, plotId, 0, 0, 'road')
        expect(getTownCoins(id)).toBe(500)
        expect(() => placeBuilding(id, plotId, 1, 0, 'road')).toThrow(/Not enough coins/)
        expect(getTownCoins(id)).toBe(500)
    })

    it('escrows a buy order\'s coins and gives them back on cancel', async () => {
        const { id } = await mayor({ coins: 1_000 })
        const order = placeTownOrder(id, 'wheat', 'buy', 12.5, 40)
        expect(getTownCoins(id)).toBe(500)
        cancelTownOrder(id, order.orderId)
        expect(getTownCoins(id)).toBe(1_000)
    })

    it('pays a sell order\'s fill into the seller\'s town and change back to the buyer', async () => {
        const seller = await mayor({ coins: 0 })
        const buyer = await mayor({ coins: 1_000 })
        stock(seller.id, 'wheat', 10)
        placeTownOrder(seller.id, 'wheat', 'sell', 40, 10)
        placeTownOrder(buyer.id, 'wheat', 'buy', 50, 10)
        expect(getTownCoins(seller.id)).toBe(400)
        expect(getTownCoins(buyer.id)).toBe(600)
    })

    it('charges a land-office plot and refunds a quarter of it on sale', async () => {
        const { id } = await mayor({ coins: townPlotPrice(2) })
        db.update(polytownState).set({ lastPlotBoughtAt: new Date(0) }).where(eq(polytownState.playerId, id)).run()
        const own = db.select().from(polytownPlots).where(eq(polytownPlots.playerId, id)).get()!
        const bought = buyPlot(id, own.x + 1, own.y)
        expect(getTownCoins(id)).toBe(0)
        const { refund } = sellPlotToSystem(id, bought.plotId)
        expect(refund).toBe(townPlotRefundFor(townPlotPrice(2)))
        expect(getTownCoins(id)).toBe(refund)
    })
})

describe('boosters', () => {
    it('puts a milestone\'s boosters in the store, once under a burst', async () => {
        const { id, plotId } = await mayor()
        db.insert(polytownBuildings).values({ playerId: id, plotId, type: 'house', tileX: 0, tileY: 0, level: 1, completesAt: new Date(Date.now() - 1_000) }).run()
        const { ok } = await burst(10, () => claimMilestone(id, 'first-home'))
        expect(ok).toBe(1)
        expect(state(id).boosters).toEqual(townMilestoneBoosters(getTownMilestone('first-home')!))
    })

    it('starts a stored Builder\'s rush for 12 hours and halves the jobs already running', async () => {
        const { id, plotId } = await mayor()
        const pending = job(id, plotId, 0, 30 * 60_000)
        writeTx(tx => addTownBoosters(tx, id, { build: 1 }))
        const before = Date.now()
        startTownBooster(id, 'build')
        const row = state(id)
        expect(row.boosters).toEqual({})
        expect(row.buildBoostUntil!.getTime()).toBeGreaterThanOrEqual(before + TOWN_BOOST_MS)
        const ends = db.select().from(polytownBuildings).where(eq(polytownBuildings.id, pending.id)).get()!.completesAt.getTime()
        expect(pending.completesAt.getTime() - ends).toBeGreaterThan(14 * 60_000)
        expect(() => startTownBooster(id, 'build')).toThrow(/No booster/)
    })
})

describe('gem perks', () => {
    it('reads the player\'s gems from the hub, and none for a dev player', async () => {
        const hubPlayer = await mayor({ gems: 42 })
        const devPlayer = await mayor({ gems: 42, origin: 'dev' })
        expect(await getHubGems(hubPlayer.id)).toBe(42)
        expect(await getHubGems(devPlayer.id)).toBeNull()
    })

    it('buys a booster: spends at the hub, then stores it, once per key', async () => {
        const { id } = await mayor({ gems: 20 })
        const key = crypto.randomUUID()
        const bought = await buyTownBooster(id, 'production', key)
        expect(bought).toMatchObject({ kind: 'production', gemsSpent: TOWN_BOOSTER_GEM_PRICES.production, gems: 20 - TOWN_BOOSTER_GEM_PRICES.production })
        expect(state(id).boosters).toEqual({ production: 1 })

        // The same purchase retried: the hub charges the key once, and the perk lands once.
        await expect(buyTownBooster(id, 'production', key)).rejects.toMatchObject({ statusCode: 409 })
        expect(hubState.gems.get(id)).toBe(20 - TOWN_BOOSTER_GEM_PRICES.production)
        expect(state(id).boosters).toEqual({ production: 1 })
        expect(db.select().from(polytownGemSpends).where(eq(polytownGemSpends.playerId, id)).all()).toHaveLength(1)
    })

    it('applies a burst of purchases with one key exactly once', async () => {
        const { id } = await mayor({ gems: 100 })
        const key = crypto.randomUUID()
        const { ok } = await burst(8, () => buyTownBooster(id, 'market', key))
        expect(ok).toBe(1)
        expect(state(id).boosters).toEqual({ market: 1 })
        expect(hubState.gems.get(id)).toBe(100 - TOWN_BOOSTER_GEM_PRICES.market)
    })

    it('refuses what the player can\'t afford, and a dev player, without applying anything', async () => {
        const poor = await mayor({ gems: 1 })
        await expect(buyTownBooster(poor.id, 'production', crypto.randomUUID())).rejects.toThrow(/Not enough gems/)
        expect(state(poor.id).boosters).toEqual({})

        const dev = await mayor({ gems: 100, origin: 'dev' })
        await expect(buyTownBooster(dev.id, 'production', crypto.randomUUID())).rejects.toThrow(/from the hub/)
        expect(hubState.gems.get(dev.id)).toBe(100)

        const offline = await mayor({ gems: 100 })
        hubState.down = true
        await expect(buyTownBooster(offline.id, 'production', crypto.randomUUID())).rejects.toMatchObject({ statusCode: 503 })
        expect(state(offline.id).boosters).toEqual({})
    })

    it('hires a crew for its price, and refunds the spend when the hire can no longer apply', async () => {
        const { id } = await mayor({ gems: 500 })
        const hired = await hireTownBuilder(id, crypto.randomUUID())
        expect(hired).toMatchObject({ builders: 4, gemsSpent: TOWN_BUILDER_GEM_COSTS[0] })
        expect(hubState.gems.get(id)).toBe(500 - TOWN_BUILDER_GEM_COSTS[0]!)

        // Two hires priced against the same crew count: the second one's
        // conditional update finds the count moved, fails, and is refunded.
        const [a, b] = await Promise.allSettled([hireTownBuilder(id, crypto.randomUUID()), hireTownBuilder(id, crypto.randomUUID())])
        expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
        expect(state(id).builders).toBe(5)
        expect(hubState.refunds).toHaveLength(1)
        expect(hubState.gems.get(id)).toBe(500 - TOWN_BUILDER_GEM_COSTS[0]! - TOWN_BUILDER_GEM_COSTS[1]!)
        const rows = db.select().from(polytownGemSpends).where(eq(polytownGemSpends.playerId, id)).all()
        expect(rows.filter(r => r.status === 'refunded')).toHaveLength(1)
    })

    it('rushes a job for a gem an hour, and refunds a rush whose job finished first', async () => {
        const { id, plotId } = await mayor({ gems: 50 })
        const pending = job(id, plotId, 0, 150 * 60_000)
        const rushed = await rushBuildingWithGems(id, pending.id, crypto.randomUUID())
        expect(rushed.gemsSpent).toBe(townRushGemCost(150 * 60_000))
        expect(rushed.gemsSpent).toBe(3)
        expect(db.select().from(polytownBuildings).where(eq(polytownBuildings.id, pending.id)).get()!.level).toBe(1)
        await expect(rushBuildingWithGems(id, pending.id, crypto.randomUUID())).rejects.toThrow(/Nothing to rush/)
        expect(hubState.gems.get(id)).toBe(47)

        // Priced while running, finished before the spend lands: the gems come back.
        const racing = job(id, plotId, 1, 30 * 60_000)
        await Promise.allSettled([
            rushBuildingWithGems(id, racing.id, crypto.randomUUID()),
            rushBuildingWithGems(id, racing.id, crypto.randomUUID())
        ])
        expect(hubState.refunds).toHaveLength(1)
        expect(hubState.gems.get(id)).toBe(46)
    })
})

describe('star level', () => {
    function monument(id: string, plotId: string, type: string, tileX: number, level: number, upgradingTo: number | null = null, completesAt = Date.now() - 1_000, tileY = 0) {
        db.insert(polytownBuildings).values({ playerId: id, plotId, type, tileX, tileY, level, upgradingTo, completesAt: new Date(completesAt) }).run()
    }
    function reported(id: string) {
        return db.select().from(starReports).where(and(eq(starReports.playerId, id), eq(starReports.game, 'polytown'))).get()?.stars ?? 0
    }

    it('counts monument stages on the map and in storage, a finished-but-unsettled stage included', async () => {
        const { id, plotId } = await mayor()
        expect(await syncStars(id, 'polytown')).toEqual([])
        monument(id, plotId, 'pyramid', 0, 5)
        // Stage 3 of the colosseum finished a minute ago, but nobody has settled the town since.
        monument(id, plotId, 'colosseum', 4, 2, 3, Date.now() - 60_000)
        expect(await syncStars(id, 'polytown')).toEqual([{ game: 'polytown', stars: 1 }])
        expect(reported(id)).toBe(1)

        // A stage still going up does not count yet.
        monument(id, plotId, 'lighthouse', 0, 4, 5, Date.now() + 60 * 60_000, 4)
        db.insert(polytownStorage).values({ id: crypto.randomUUID(), playerId: id, type: 'arc', level: 4, createdAt: new Date(), storedAt: new Date() }).run()
        // 5 + 3 + 4 + 4 = 16 stages: two stars.
        expect(await syncStars(id, 'polytown')).toEqual([{ game: 'polytown', stars: 2 }])
        // Unchanged: nothing is sent again.
        expect(await syncStars(id, 'polytown')).toEqual([])
    })
})
