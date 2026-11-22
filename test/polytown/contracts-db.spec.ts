import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '#server/database'
import { polytownContractDays, polytownContracts, polytownInventory, polytownState } from '#server/database/schema'
import { townBoosterCount } from '#shared/polytown/town-boosts'
import {
    deleteTownForPlayer
} from '#server/utils/polytown/town'
import { claimTownContractBonus, deliverTownContract, getTownContracts } from '#server/utils/polytown/contracts'
import { townContractDayKey } from '#shared/polytown/town-contracts'
import { SKIP, burst, cleanupUser, foundTown, lockTownRealm, moveTownToFlatGround, seedUser } from './db-helpers'

const OWNER = 'test-town-contracts-owner'

async function cleanup() {
    await db.delete(polytownContracts).where(eq(polytownContracts.playerId, OWNER))
    await db.delete(polytownContractDays).where(eq(polytownContractDays.playerId, OWNER))
    await deleteTownForPlayer(OWNER)
    await cleanupUser(OWNER)
}

async function town() {
    await seedUser(OWNER, { balance: '0', gems: 0 })
    const { plotId } = await foundTown(OWNER)
    await moveTownToFlatGround(plotId)
}

async function stock(resource: string, amount: number) {
    await db.insert(polytownInventory).values({ playerId: OWNER, resource, amount })
        .onConflictDoUpdate({ target: [polytownInventory.playerId, polytownInventory.resource], set: { amount } })
}

/** The town's coins and its booster store (the old site's balance and gems). */
async function wallet() {
    const row = db.select({ cents: polytownState.coinsCents, boosters: polytownState.boosters }).from(polytownState).where(eq(polytownState.playerId, OWNER)).get()
    return { balance: row!.cents / 100, boosters: row!.boosters }
}

describe.skipIf(SKIP)('Polytown contracts (database)', () => {
    let releaseRealm: () => Promise<void>
    beforeAll(async () => {
        releaseRealm = await lockTownRealm()
        await cleanup()
    }, 120_000)
    afterEach(cleanup)
    afterAll(async () => {
        await releaseRealm()
    })

    it('rolls one set per day, even for parallel first views', async () => {
        await town()
        const views = await Promise.all(Array.from({ length: 6 }, async () => getTownContracts(OWNER)))
        const ids = views.map(v => v.contracts.map(c => c.id).join(','))
        expect(new Set(ids).size).toBe(1)
        expect(views[0]!.contracts).toHaveLength(3)
        expect(new Set(views[0]!.contracts.map(c => c.resource)).size).toBe(3)

        const rows = await db.select().from(polytownContracts)
            .where(and(eq(polytownContracts.playerId, OWNER), eq(polytownContracts.day, townContractDayKey(Date.now()))))
        expect(rows).toHaveLength(3)
        const days = await db.select().from(polytownContractDays).where(eq(polytownContractDays.playerId, OWNER))
        expect(days).toHaveLength(1)
        // The old 1–5 gem bonus, as boosters worth as much.
        expect(townBoosterCount(days[0]!.bonus)).toBeGreaterThanOrEqual(1)
        expect(townBoosterCount(days[0]!.bonus)).toBeLessThanOrEqual(2)
    })

    it('pays a burst of deliveries for one contract exactly once', async () => {
        await town()
        const { contracts } = await getTownContracts(OWNER)
        const c = contracts[0]!
        await stock(c.resource, c.quantity * 5)

        const result = await burst(10, () => deliverTownContract(OWNER, c.id))
        expect(result.ok).toBe(1)
        expect(result.rejected).toBe(9)

        const [inv] = await db.select().from(polytownInventory)
            .where(and(eq(polytownInventory.playerId, OWNER), eq(polytownInventory.resource, c.resource)))
        expect(inv!.amount).toBe(c.quantity * 4)
        expect((await wallet()).balance).toBeCloseTo(c.reward, 2)
    })

    it('refuses a short delivery, or an id that is not a contract of this town', async () => {
        await town()
        const { contracts } = await getTownContracts(OWNER)
        const c = contracts[0]!
        await stock(c.resource, c.quantity - 1)

        expect(() => deliverTownContract(OWNER, c.id)).toThrow(/Not enough/)
        expect(() => deliverTownContract(OWNER, 'nope')).toThrow(/Unknown contract/)
        expect(() => deliverTownContract(OWNER, crypto.randomUUID())).toThrow(/Unknown contract/)
        const [row] = await db.select().from(polytownContracts).where(eq(polytownContracts.id, c.id))
        expect(row!.delivered).toBe(false)
        expect((await wallet()).balance).toBe(0)
    })

    it('holds the booster bonus until all three are delivered, then pays a burst of claims once', async () => {
        await town()
        const { contracts, bonus } = await getTownContracts(OWNER)
        expect(bonus.claimable).toBe(false)
        for (const c of contracts) await stock(c.resource, c.quantity * 3)

        const first = await deliverTownContract(OWNER, contracts[0]!.id)
        expect(first.bonusReady).toBe(false)
        expect(() => claimTownContractBonus(OWNER)).toThrow(/Deliver all three/)
        // The last two at once: whichever lands second completes the set.
        const rest = await Promise.all(contracts.slice(1).map(async c => deliverTownContract(OWNER, c.id)))
        expect(rest.filter(r => r.bonusReady)).toHaveLength(1)
        // Delivering never pays the boosters by itself: the bonus waits for a claim.
        expect((await wallet()).boosters).toEqual({})
        expect((await getTownContracts(OWNER)).bonus.claimable).toBe(true)

        const result = await burst(10, () => claimTownContractBonus(OWNER))
        expect(result.ok).toBe(1)
        expect(result.rejected).toBe(9)
        expect((await wallet()).boosters).toEqual(bonus.boosters)

        expect(() => claimTownContractBonus(OWNER)).toThrow(/already claimed/)
        const view = await getTownContracts(OWNER)
        expect(view.bonus.claimed).toBe(true)
        expect(view.bonus.claimable).toBe(false)
    })
})
