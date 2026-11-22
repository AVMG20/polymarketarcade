import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// The hub's gem wallet, as far as these specs need it: spends succeed and burn from a pile.
const wallet = vi.hoisted(() => ({ gems: 0, spends: 0 }))
vi.mock('#server/utils/hub', async (importOriginal) => {
    const actual = await importOriginal<typeof import('#server/utils/hub')>()
    return {
        ...actual,
        spendGems: async ({ amount }: { amount: number }) => {
            if (wallet.gems < amount) throw new actual.HubError('Not enough gems', 400)
            wallet.gems -= amount
            return { spendId: `spend-${++wallet.spends}`, gems: wallet.gems }
        },
        refundGems: async () => ({ gems: wallet.gems })
    }
})
import { db } from '#server/database'
import {
    deleteTownForPlayer,
    placeBuilding,
    settleTownForRead
} from '#server/utils/polytown/town'
import { hireTownBuilder } from '#server/utils/polytown/gems'
import { TOWN_FREE_BUILDERS, TOWN_MAX_BUILDERS } from '#shared/polytown/town'
import { SKIP, cleanupUser, foundTown, lockTownRealm, moveTownToFlatGround, seedUser } from './db-helpers'

const OWNER = 'test-town-smoke-owner'

async function cleanup() {
    await deleteTownForPlayer(OWNER)
    await cleanupUser(OWNER)
}

/**
 * The path a brand-new mayor actually walks, start to finish. Every other spec
 * tests one rule; this one exists to catch the case where the rules are all
 * right and the game is still unplayable from a standing start.
 */
describe.skipIf(SKIP)('a new mayor can play (database)', () => {
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

    it('founds a town, lays a road, and puts up a house and a lumber camp', async () => {
        await seedUser(OWNER, { balance: '100000000000', gems: 5000 })
        const { plotId } = await foundTown(OWNER)
        expect(plotId).toBeTruthy()
        // Fixed tile coordinates only mean anything on ground with no water on it.
        await moveTownToFlatGround(plotId)

        await placeBuilding(OWNER, plotId, 0, 0, 'road')
        await placeBuilding(OWNER, plotId, 1, 0, 'road')
        // Rotation 2 faces -y, which is the road laid on row zero.
        await placeBuilding(OWNER, plotId, 0, 1, 'house', 2)
        // A lumber camp costs coins only, which is all a new town has.
        await placeBuilding(OWNER, plotId, 1, 1, 'lumber', 2)

        const settled = await settleTownForRead(OWNER)
        expect(settled.buildings).toHaveLength(4)
        expect(settled.state.builders).toBe(TOWN_FREE_BUILDERS)
        // No monument yet, so every bonus is zero.
        expect(settled.bonus.output).toBe(0)
    })

    it('stops the mayor at the crew cap, lets them buy their way past it, and never sells more crews than the cap', async () => {
        await seedUser(OWNER, { balance: '100000000000' })
        wallet.gems = 100_000
        const { plotId } = await foundTown(OWNER)
        await moveTownToFlatGround(plotId)
        for (let x = 0; x < 6; x++) await placeBuilding(OWNER, plotId, x, 0, 'road')

        // Roads are instant and hold nobody; the next three take every crew.
        for (let x = 0; x < TOWN_FREE_BUILDERS; x++) {
            await placeBuilding(OWNER, plotId, x, 1, 'house', 2)
        }
        expect(() => placeBuilding(OWNER, plotId, TOWN_FREE_BUILDERS, 1, 'house', 2)).toThrow(/builder/i)

        const hired = await hireTownBuilder(OWNER, crypto.randomUUID())
        expect(hired.builders).toBe(TOWN_FREE_BUILDERS + 1)
        expect(hired.gemsSpent).toBeGreaterThan(0)
        expect(hired.gems).toBe(100_000 - hired.gemsSpent)
        // With the extra crew, the job that was refused now starts.
        await placeBuilding(OWNER, plotId, TOWN_FREE_BUILDERS, 1, 'house', 2)

        for (let i = TOWN_FREE_BUILDERS + 1; i < TOWN_MAX_BUILDERS; i++) await hireTownBuilder(OWNER, crypto.randomUUID())
        await expect(hireTownBuilder(OWNER, crypto.randomUUID())).rejects.toThrow(/already have/)
    })
})
