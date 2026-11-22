import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { db, writeTx } from '#server/database'
import { polytownContractDays, polytownContracts } from '#server/database/schema'
import { deriveTown, getTownResource, isTownResourceId } from '#shared/polytown/town'
import {
    TOWN_CONTRACT_KEEP_DAYS,
    TOWN_CONTRACT_SLOTS,
    rollTownContracts,
    townContractDayBefore,
    townContractDayKey,
    townContractFloorValue,
    townContractRates,
    townContractResetAt
} from '#shared/polytown/town-contracts'
import { addTownBoosters, creditTownCoins, getTownCoins, getTownState, recordEarnings, settleTownForRead, settleTownState, takeInventory, type SettledTown } from './town'

const CONTRACT_ID = /^[0-9a-f-]{36}$/i

function fail(statusMessage: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage })
}

function requireTown(playerId: string) {
    if (!getTownState(playerId)) fail('Found a town first')
}

/**
 * Roll today's contracts unless they exist. The day row is the mutex: it is
 * inserted first with ON CONFLICT DO NOTHING, and only the transaction that
 * got a row back writes the contracts.
 */
function ensureContracts(playerId: string, day: string, settled: SettledTown, now: number) {
    const existing = db.select({ id: polytownContractDays.id }).from(polytownContractDays)
        .where(and(eq(polytownContractDays.playerId, playerId), eq(polytownContractDays.day, day)))
        .get()
    if (existing) return

    const derived = deriveTown(settled.sim, settled.state.happiness, now, settled.satisfied)
    const roll = rollTownContracts(townContractRates(settled.sim, derived, now), derived.storageCap)

    writeTx((tx) => {
        const created = tx.insert(polytownContractDays)
            .values({ playerId, day, bonus: roll.bonus })
            .onConflictDoNothing()
            .returning({ id: polytownContractDays.id })
            .get()
        if (!created) return
        tx.insert(polytownContracts)
            .values(roll.contracts.map(c => ({
                playerId,
                day,
                slot: c.slot,
                resource: c.resource,
                quantity: c.quantity,
                reward: c.reward
            })))
            .onConflictDoNothing()
            .run()

        // Day keys sort as text, so anything older than a week goes in one pass.
        const cutoff = townContractDayBefore(now, TOWN_CONTRACT_KEEP_DAYS)
        tx.delete(polytownContracts).where(and(eq(polytownContracts.playerId, playerId), lt(polytownContracts.day, cutoff))).run()
        tx.delete(polytownContractDays).where(and(eq(polytownContractDays.playerId, playerId), lt(polytownContractDays.day, cutoff))).run()
    })
}

export function getTownContracts(playerId: string) {
    requireTown(playerId)
    const now = Date.now()
    const day = townContractDayKey(now)
    const settled = settleTownForRead(playerId)
    ensureContracts(playerId, day, settled, now)

    const rows = db.select().from(polytownContracts)
        .where(and(eq(polytownContracts.playerId, playerId), eq(polytownContracts.day, day)))
        .orderBy(asc(polytownContracts.slot))
        .all()
    const dayRow = db.select().from(polytownContractDays)
        .where(and(eq(polytownContractDays.playerId, playerId), eq(polytownContractDays.day, day)))
        .get()

    const contracts = rows.map((row) => {
        const resource = isTownResourceId(row.resource) ? row.resource : null
        return {
            id: row.id,
            slot: row.slot,
            resource: row.resource,
            name: getTownResource(row.resource)?.name ?? row.resource,
            quantity: row.quantity,
            reward: row.reward,
            floorValue: resource ? townContractFloorValue(resource, row.quantity) : 0,
            delivered: row.delivered,
            have: resource ? settled.inventory[resource] ?? 0 : 0
        }
    })

    const allDelivered = contracts.length > 0 && contracts.every(c => c.delivered)
    const claimed = dayRow?.bonusClaimed ?? false
    return {
        day,
        serverNow: now,
        resetAt: townContractResetAt(now),
        contracts,
        bonus: { boosters: dayRow?.bonus ?? {}, claimed, claimable: allDelivered && !claimed },
        allDelivered
    }
}

/**
 * Hand one contract's goods to the hall. All or nothing, and safe under a
 * burst: the delivered flag flips false → true as the guard, the goods leave
 * in a conditional decrement that throws when short (rolling the flip back),
 * and the coins land in the same transaction. The booster bonus is not paid
 * here: the player claims it with `claimTownContractBonus`.
 */
export function deliverTownContract(playerId: string, contractId: string) {
    if (!CONTRACT_ID.test(contractId)) fail('Unknown contract')
    requireTown(playerId)

    return writeTx((tx) => {
        const now = Date.now()
        const day = townContractDayKey(now)
        // Production up to this instant lands first, so goods made a second ago count.
        settleTownState(tx, playerId, now)

        const contract = tx.update(polytownContracts)
            .set({ delivered: true, deliveredAt: new Date(now) })
            .where(and(
                eq(polytownContracts.id, contractId),
                eq(polytownContracts.playerId, playerId),
                eq(polytownContracts.day, day),
                eq(polytownContracts.delivered, false)
            ))
            .returning()
            .get()
        if (!contract) {
            const row = tx.select({ delivered: polytownContracts.delivered }).from(polytownContracts)
                .where(and(eq(polytownContracts.id, contractId), eq(polytownContracts.playerId, playerId)))
                .get()
            fail(!row ? 'Unknown contract' : row.delivered ? 'Already delivered' : 'That contract has expired')
        }
        if (!isTownResourceId(contract.resource)) fail('Unknown contract good', 500)

        takeInventory(tx, playerId, contract.resource, contract.quantity)
        creditTownCoins(tx, playerId, contract.reward)
        // A contract is a sale to the town hall, so it counts toward the merchant goals.
        recordEarnings(tx, playerId, contract.reward)

        const done = tx.select({ count: sql<number>`count(*)` }).from(polytownContracts)
            .where(and(eq(polytownContracts.playerId, playerId), eq(polytownContracts.day, day), eq(polytownContracts.delivered, true)))
            .get()
        const allDelivered = (done?.count ?? 0) >= TOWN_CONTRACT_SLOTS

        let bonusReady = false
        if (allDelivered) {
            const dayRow = tx.select({ bonusClaimed: polytownContractDays.bonusClaimed }).from(polytownContractDays)
                .where(and(eq(polytownContractDays.playerId, playerId), eq(polytownContractDays.day, day)))
                .get()
            bonusReady = dayRow ? !dayRow.bonusClaimed : false
        }

        return {
            id: contract.id,
            resource: contract.resource,
            quantity: contract.quantity,
            reward: contract.reward,
            bonusReady,
            allDelivered,
            balance: getTownCoins(playerId, tx)
        }
    })
}

/**
 * Pay today's booster bonus once all three contracts are in. Claim-then-reward:
 * the bonus_claimed flag flips false → true only while every one of today's
 * contracts is delivered, and the boosters land in the same transaction, so a
 * burst of claims pays once. Yesterday's unclaimed bonus expires with its day.
 */
export function claimTownContractBonus(playerId: string) {
    requireTown(playerId)

    return writeTx((tx) => {
        const day = townContractDayKey(Date.now())
        const claimed = tx.update(polytownContractDays)
            .set({ bonusClaimed: true })
            .where(and(
                eq(polytownContractDays.playerId, playerId),
                eq(polytownContractDays.day, day),
                eq(polytownContractDays.bonusClaimed, false),
                sql`(select count(*) from polytown_contracts c where c.player_id = ${playerId} and c.day = ${day} and c.delivered = 1) >= ${TOWN_CONTRACT_SLOTS}`
            ))
            .returning({ bonus: polytownContractDays.bonus })
            .get()
        if (!claimed) {
            const row = tx.select({ bonusClaimed: polytownContractDays.bonusClaimed }).from(polytownContractDays)
                .where(and(eq(polytownContractDays.playerId, playerId), eq(polytownContractDays.day, day)))
                .get()
            fail(row?.bonusClaimed ? 'Bonus already claimed' : 'Deliver all three contracts first')
        }

        addTownBoosters(tx, playerId, claimed.bonus)
        return {
            boosters: claimed.bonus,
            balance: getTownCoins(playerId, tx)
        }
    })
}
