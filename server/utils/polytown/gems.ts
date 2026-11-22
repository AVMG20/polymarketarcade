import { and, eq, sql } from 'drizzle-orm'
import { db, writeTx, type Tx } from '#server/database'
import { players, polytownBuildings, polytownGemSpends, polytownState } from '#server/database/schema'
import { arcadeEnv } from '#server/utils/env'
import { hub, HubError, refundGems, spendGems } from '#server/utils/hub'
import { TOWN_MAX_BUILDERS, townBuilderGemCost, townRushGemCost } from '#shared/polytown/town'
import { TOWN_BOOSTER_GEM_PRICES, townBoosterLabel, type TownBoosterKind } from '#shared/polytown/town-boosts'
import { addTownBoosters, getTownState, rushTownJob, settleTownState } from './town'

/**
 * Polytown's gem perks: a rush, another build crew, a booster. They cost the
 * player's platform gems, spent at the hub (contract §2): spend first, then
 * apply the perk in one writeTx; if applying fails, the spend is refunded.
 *
 * Every purchase carries one idempotency key. The hub charges a key once, and
 * the `polytown_gem_spends` row inserted inside the applying transaction
 * (keyed by it) makes sure the perk lands once too, however often the same
 * purchase is retried.
 */

const GAME = 'polytown'
const KEY = /^[A-Za-z0-9_-]{8,64}$/

function fail(statusMessage: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage })
}

/** A purchase key from the client, or a fresh one. */
export function purchaseKey(raw: unknown): string {
    return typeof raw === 'string' && KEY.test(raw) ? raw : crypto.randomUUID()
}

/** Whether this player can spend gems at all: a hub player, with the app key configured. */
function gemsAvailable(playerId: string): boolean {
    if (!arcadeEnv().appKey) return false
    const row = db.select({ origin: players.origin }).from(players).where(eq(players.id, playerId)).get()
    return row?.origin === 'hub'
}

/** The player's platform gems, or null when the hub can't say (dev player, hub down, never connected). */
export async function getHubGems(playerId: string): Promise<number | null> {
    if (!gemsAvailable(playerId)) return null
    try {
        return (await hub.getPlayer(playerId)).gems
    } catch {
        return null
    }
}

export interface GemPurchase<T> {
    /** 'rush' | 'builder' | 'booster:<kind>', for the spend row. */
    perk: string
    gems: number
    reason: string
    apply: (tx: Tx) => T
}

/**
 * Spend at the hub, then apply. Returns what `apply` returned, plus the gems
 * charged and the player's balance after (for the hub's top bar).
 */
export async function spendThenApply<T>(playerId: string, key: string, purchase: GemPurchase<T>): Promise<T & { gemsSpent: number, gems: number }> {
    if (!gemsAvailable(playerId)) fail('Gems work when Polytown is opened from the hub')
    if (!Number.isInteger(purchase.gems) || purchase.gems < 1) fail('Nothing to pay for')
    if (db.select({ key: polytownGemSpends.idempotencyKey }).from(polytownGemSpends).where(eq(polytownGemSpends.idempotencyKey, key)).get()) {
        fail('That purchase already went through', 409)
    }

    let spend: { spendId: string, gems: number }
    try {
        spend = await spendGems({ idempotencyKey: `${GAME}-${key}`, playerId, amount: purchase.gems, game: GAME, reason: purchase.reason })
    } catch (error) {
        if (error instanceof HubError) {
            if (error.statusCode === 400) fail(error.message || 'Not enough gems')
            if (error.statusCode === 403) fail('Open Polytown from the hub to use gems', 403)
            if (error.statusCode === 409) fail('That purchase already went through', 409)
        }
        fail('The hub is not answering — no gems were spent', 503)
    }

    try {
        const result = writeTx((tx) => {
            // The spend row is the claim: a retried purchase finds it and applies nothing.
            const claimed = tx.insert(polytownGemSpends)
                .values({ idempotencyKey: key, playerId, spendId: spend.spendId, perk: purchase.perk, gems: purchase.gems, status: 'applied' })
                .onConflictDoNothing()
                .returning({ key: polytownGemSpends.idempotencyKey })
                .get()
            if (!claimed) fail('That purchase already went through', 409)
            return purchase.apply(tx)
        })
        return { ...result, gemsSpent: purchase.gems, gems: spend.gems }
    } catch (error) {
        // Applied by an earlier try of the same key: nothing to give back.
        const applied = db.select({ status: polytownGemSpends.status }).from(polytownGemSpends).where(eq(polytownGemSpends.idempotencyKey, key)).get()
        if (!applied) {
            try {
                await refundGems(spend.spendId)
                db.insert(polytownGemSpends)
                    .values({ idempotencyKey: key, playerId, spendId: spend.spendId, perk: purchase.perk, gems: purchase.gems, status: 'refunded' })
                    .onConflictDoNothing()
                    .run()
            } catch (refundError) {
                console.error(`[polytown] refund of spend ${spend.spendId} for ${playerId} failed: ${(refundError as Error).message}`)
            }
        }
        throw error
    }
}

/** Finish a build or upgrade at once: a gem per hour left, rounded up. */
export async function rushBuildingWithGems(playerId: string, buildingId: string, key: string) {
    if (!getTownState(playerId)) fail('Found a town first')
    const building = db.select().from(polytownBuildings)
        .where(and(eq(polytownBuildings.id, buildingId), eq(polytownBuildings.playerId, playerId))).get()
    if (!building) fail('Building not found', 404)
    const now = Date.now()
    const remainingMs = building.completesAt.getTime() - now
    if (remainingMs <= 0 || (building.level > 0 && building.upgradingTo === null)) fail('Nothing to rush')
    const gems = townRushGemCost(remainingMs)
    return spendThenApply(playerId, key, {
        perk: 'rush',
        gems,
        reason: `Rush a ${building.type} in Polytown`,
        apply: tx => rushTownJob(tx, playerId, buildingId, Date.now())
    })
}

/** Hire one more build crew, permanently. The conditional update on the count is the guard. */
export async function hireTownBuilder(playerId: string, key: string) {
    const state = getTownState(playerId)
    if (!state) fail('Found a town first')
    const gems = townBuilderGemCost(state.builders)
    if (gems === null) fail(`You already have ${TOWN_MAX_BUILDERS} builders`)
    const owned = state.builders
    return spendThenApply(playerId, key, {
        perk: 'builder',
        gems,
        reason: `Hire build crew ${owned + 1} in Polytown`,
        apply: (tx) => {
            settleTownState(tx, playerId)
            const updated = tx.update(polytownState)
                .set({ builders: sql`${polytownState.builders} + 1` })
                .where(and(eq(polytownState.playerId, playerId), eq(polytownState.builders, owned)))
                .returning({ builders: polytownState.builders })
                .get()
            if (!updated) fail('Try again', 409)
            return { builders: updated.builders }
        }
    })
}

/** Buy one booster into the town's store. */
export async function buyTownBooster(playerId: string, kind: TownBoosterKind, key: string) {
    if (!getTownState(playerId)) fail('Found a town first')
    return spendThenApply(playerId, key, {
        perk: `booster:${kind}`,
        gems: TOWN_BOOSTER_GEM_PRICES[kind],
        reason: `${townBoosterLabel(kind)} booster in Polytown`,
        apply: (tx) => {
            addTownBoosters(tx, playerId, { [kind]: 1 })
            const row = tx.select({ boosters: polytownState.boosters }).from(polytownState).where(eq(polytownState.playerId, playerId)).get()
            return { kind, boosters: row?.boosters ?? {} }
        }
    })
}

