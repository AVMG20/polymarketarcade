import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db, writeTx, type DbExecutor, type Tx } from '#server/database'
import { pirateCannons, pirateRuns, pirateState, players } from '#server/database/schema'
import type {
    PirateFinishRunResponse, PirateLegend, PirateLogEntry, PirateStartRunResponse, PirateStateResponse, PirateVoyageReason
} from '#shared/pirate-raid/api'
import {
    pirateAbilityCost, pirateAbilityUpgradeCost, pirateCannonCost, pirateCannonTradeIn,
    pirateCompletionBonus, pirateFirstClearBounty, pirateFullVoyagePay, pirateMarqueMultiplier, pirateMarqueUpgradeCost,
    pirateSkinCost, pirateSlotUnlockCost, pirateStatUpgradeCost, pirateVoyagePay, PIRATE_MARQUE_MAX_LEVEL
} from '#shared/pirate-raid/economy'
import {
    PIRATE_ABILITIES, PIRATE_ABILITY_MAX_LEVEL, PIRATE_CANNON_TIERS, PIRATE_DIFFICULTY_STEP, PIRATE_MAX_CANNON_SLOTS,
    PIRATE_MAX_DIFFICULTY, PIRATE_RUN_DURATION_MS, PIRATE_SHIP_SKINS, PIRATE_SHIP_STAT_IDS, PIRATE_STARTER_ABILITY_ID,
    PIRATE_STARTER_CANNON_TIER, pirateAbility, pirateAbilityCooldownMs, pirateAmmoCapacity, pirateCannonTier,
    pirateClampAbilityLevel, pirateDefenseRating, pirateDifficultyOptions, pirateMaxHp, pirateMaxSelectableDifficulty, piratePowerLevel,
    pirateRecommendedDifficulty, pirateRegenRate, pirateShipSkin, pirateShipSpeed, pirateStatMaxLevel,
    type PirateShipStatId
} from '#shared/pirate-raid/rules'

/**
 * Pirate Raid's server half. Doubloons only move here: a voyage's pay is
 * derived from the server clock and the difficulty snapshotted at start-run,
 * and every purchase is one synchronous `writeTx` whose conditional update is
 * the guard (`doubloons >= cost`, the level it read, no voyage at sea).
 */

type PirateStateRow = typeof pirateState.$inferSelect
type PirateCannonRow = typeof pirateCannons.$inferSelect

/** Wall-clock slack on top of the six minutes for network latency. */
const FINISH_GRACE_MS = 5_000
const MAX_REPORTED_KILLS = 2_000
const MAX_REPORTED_SHOTS = 50_000

const LEVEL_COLUMN = {
    hull: 'hullLevel',
    speed: 'speedLevel',
    defense: 'defenseLevel',
    ammoCapacity: 'ammoCapacityLevel',
    regen: 'regenLevel'
} as const satisfies Record<PirateShipStatId, keyof PirateStateRow>

function fail(statusMessage: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage })
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Inside a writeTx: the captain's row, created on first visit with the free starter swivel gun in port 1. */
export function ensurePirateState(playerId: string, tx: Tx): PirateStateRow {
    const created = tx.insert(pirateState).values({ playerId }).onConflictDoNothing().returning().get()
    if (created) {
        tx.insert(pirateCannons).values({ playerId, slotIndex: 0, tierId: PIRATE_STARTER_CANNON_TIER, purchasePrice: 0 }).run()
        return created
    }
    return tx.select().from(pirateState).where(eq(pirateState.playerId, playerId)).get()!
}

function cannonsOf(playerId: string, tx: DbExecutor = db): PirateCannonRow[] {
    return tx.select().from(pirateCannons).where(eq(pirateCannons.playerId, playerId)).all()
        .sort((a, b) => a.slotIndex - b.slotIndex)
}

export function pirateLevels(state: PirateStateRow): Record<PirateShipStatId, number> {
    return {
        hull: state.hullLevel,
        speed: state.speedLevel,
        defense: state.defenseLevel,
        ammoCapacity: state.ammoCapacityLevel,
        regen: state.regenLevel
    }
}

function powerOf(state: PirateStateRow, cannons: PirateCannonRow[]) {
    return piratePowerLevel({ levels: pirateLevels(state), cannonTierIds: cannons.map(c => c.tierId), cannonSlots: state.cannonSlots })
}

function ownedAbilities(state: PirateStateRow) {
    return new Set([PIRATE_STARTER_ABILITY_ID, ...state.ownedAbilityIds])
}

function ownedSkins(state: PirateStateRow) {
    return new Set(['starter', ...state.ownedSkinIds])
}

export function pirateStateView(playerId: string): PirateStateResponse {
    const s = writeTx(tx => ensurePirateState(playerId, tx))
    const cannons = cannonsOf(playerId)
    const levels = pirateLevels(s)
    const power = powerOf(s, cannons)
    const abilities = ownedAbilities(s)
    const skins = ownedSkins(s)
    const equippedAbilityId = pirateAbility(s.equippedAbilityId).id
    const multiplier = pirateMarqueMultiplier(s.marqueLevel)
    const recommendedDifficulty = pirateRecommendedDifficulty(s.highestCompletedDifficulty)

    return {
        doubloons: s.doubloons,
        totalEarned: s.totalEarned,
        levels,
        maxLevels: Object.fromEntries(PIRATE_SHIP_STAT_IDS.map(id => [id, pirateStatMaxLevel(id)])) as Record<PirateShipStatId, number>,
        costs: Object.fromEntries(PIRATE_SHIP_STAT_IDS.map(id => [id, pirateStatUpgradeCost(id, levels[id])])) as Record<PirateShipStatId, number | null>,
        power,
        stats: {
            maxHp: pirateMaxHp(s.hullLevel),
            speed: pirateShipSpeed(s.speedLevel),
            defenseRating: pirateDefenseRating(s.defenseLevel),
            ammoCapacity: pirateAmmoCapacity(s.ammoCapacityLevel),
            regenRate: pirateRegenRate(s.regenLevel)
        },
        cannons: cannons.map((c) => {
            const tier = pirateCannonTier(c.tierId)
            return {
                slotIndex: c.slotIndex,
                tierId: tier.id,
                name: tier.name,
                attackRating: tier.attackRating,
                maxDamage: tier.maxDamage,
                reloadMs: tier.reloadMs,
                range: tier.range,
                shotColor: tier.shotColor,
                shotTrail: tier.shotTrail ?? false,
                purchasePrice: c.purchasePrice,
                tradeIn: pirateCannonTradeIn(c.purchasePrice)
            }
        }),
        cannonSlots: s.cannonSlots,
        maxCannonSlots: PIRATE_MAX_CANNON_SLOTS,
        nextSlotCost: pirateSlotUnlockCost(s.cannonSlots),
        ammo: { capacity: pirateAmmoCapacity(s.ammoCapacityLevel) },
        runsPlayed: s.runsPlayed,
        bestSurvivalMs: s.bestSurvivalMs,
        highestCompletedDifficulty: s.highestCompletedDifficulty,
        recommendedDifficulty,
        difficultyOptions: pirateDifficultyOptions(Math.max(power, recommendedDifficulty)).map(difficulty => ({
            difficulty,
            voyagePay: Math.floor(pirateFullVoyagePay(difficulty) * multiplier) + pirateCompletionBonus(difficulty, multiplier),
            completionBonus: pirateCompletionBonus(difficulty, multiplier),
            firstClearBounty: difficulty > s.highestCompletedDifficulty ? pirateFirstClearBounty(difficulty) : 0,
            completed: difficulty <= s.highestCompletedDifficulty
        })),
        skins: PIRATE_SHIP_SKINS.map(skin => ({
            id: skin.id,
            name: skin.name,
            description: skin.description,
            cost: pirateSkinCost(skin.id),
            owned: skins.has(skin.id),
            equipped: skin.id === s.equippedSkinId
        })),
        equippedSkinId: s.equippedSkinId,
        abilities: PIRATE_ABILITIES.map((ability) => {
            const level = pirateClampAbilityLevel(s.abilityLevels[ability.id] ?? 1)
            return {
                id: ability.id,
                name: ability.name,
                description: ability.description,
                cost: pirateAbilityCost(ability.id),
                owned: abilities.has(ability.id),
                equipped: ability.id === equippedAbilityId,
                level,
                maxLevel: PIRATE_ABILITY_MAX_LEVEL,
                upgradeCost: pirateAbilityUpgradeCost(level),
                currentCooldownMs: pirateAbilityCooldownMs(ability.id, level),
                bestCooldownMs: pirateAbilityCooldownMs(ability.id, PIRATE_ABILITY_MAX_LEVEL)
            }
        }),
        equippedAbilityId,
        equippedAbilityLevel: pirateClampAbilityLevel(s.abilityLevels[equippedAbilityId] ?? 1),
        marque: {
            level: s.marqueLevel,
            maxLevel: PIRATE_MARQUE_MAX_LEVEL,
            multiplier,
            nextMultiplier: s.marqueLevel < PIRATE_MARQUE_MAX_LEVEL ? pirateMarqueMultiplier(s.marqueLevel + 1) : null,
            cost: pirateMarqueUpgradeCost(s.marqueLevel)
        },
        runDurationMs: PIRATE_RUN_DURATION_MS,
        activeRun: s.runStartedAt ? { startedAt: s.runStartedAt.getTime() } : null
    }
}

// ─── Voyages ────────────────────────────────────────────────────────────────

export function startPirateRun(playerId: string, difficulty: unknown, now = Date.now()): PirateStartRunResponse {
    if (typeof difficulty !== 'number' || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > PIRATE_MAX_DIFFICULTY || difficulty % PIRATE_DIFFICULTY_STEP !== 0) {
        fail(`difficulty must be a multiple of ${PIRATE_DIFFICULTY_STEP} from 0 to ${PIRATE_MAX_DIFFICULTY}`)
    }
    return writeTx((tx) => {
        const s = ensurePirateState(playerId, tx)
        const cannons = cannonsOf(playerId, tx)
        if (!cannons.length) fail('Fit a cannon before setting sail')
        const power = powerOf(s, cannons)
        if (difficulty > pirateMaxSelectableDifficulty(power, s.highestCompletedDifficulty)) fail('That sea is beyond your ship for now')
        const runId = crypto.randomUUID()
        // Setting the voyage is the guard: a second start finds run_id already set.
        const started = tx.update(pirateState)
            .set({ runId, runStartedAt: new Date(now), runPower: power, runDifficulty: difficulty })
            .where(and(eq(pirateState.playerId, playerId), isNull(pirateState.runId)))
            .returning({ playerId: pirateState.playerId })
            .get()
        if (!started) fail('A voyage is already at sea')
        const abilityId = pirateAbility(s.equippedAbilityId).id
        return {
            runId,
            power,
            difficulty,
            skinId: s.equippedSkinId,
            abilityId,
            abilityLevel: pirateClampAbilityLevel(s.abilityLevels[abilityId] ?? 1),
            payMultiplier: pirateMarqueMultiplier(s.marqueLevel),
            runDurationMs: PIRATE_RUN_DURATION_MS,
            stats: {
                maxHp: pirateMaxHp(s.hullLevel),
                speed: pirateShipSpeed(s.speedLevel),
                defenseRating: pirateDefenseRating(s.defenseLevel),
                regenRate: pirateRegenRate(s.regenLevel)
            },
            ammo: pirateAmmoCapacity(s.ammoCapacityLevel),
            cannons: cannons.map((c) => {
                const tier = pirateCannonTier(c.tierId)
                return {
                    slotIndex: c.slotIndex,
                    tierId: tier.id,
                    attackRating: tier.attackRating,
                    maxDamage: tier.maxDamage,
                    reloadMs: tier.reloadMs,
                    range: tier.range,
                    shotColor: tier.shotColor,
                    shotTrail: tier.shotTrail ?? false
                }
            })
        }
    })
}

export interface PirateRunReport {
    /** Clearing a voyage a closed tab left at sea: pays nothing and counts nothing. */
    abandoned: boolean
    survived: boolean
    reason: PirateVoyageReason
    /** The client's pause-immune playtime. Clamped to the server clock. */
    elapsedMs: number
    kills: number
    shotsFired: number
}

/** Read a finish-run body strictly: numbers must be numbers, the reason one of three. */
export function parsePirateRunReport(body: unknown): PirateRunReport {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const count = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : 0
    const reason = b.reason === 'timeout' || b.reason === 'cancelled' ? b.reason : 'defeat'
    return {
        abandoned: b.abandoned === true,
        survived: b.survived === true,
        reason,
        elapsedMs: count(b.elapsedMs, PIRATE_RUN_DURATION_MS + FINISH_GRACE_MS),
        kills: count(b.kills, MAX_REPORTED_KILLS),
        shotsFired: count(b.shotsFired, MAX_REPORTED_SHOTS)
    }
}

/**
 * The settlement, as a pure function of the row, the report and the server
 * clock. Nothing the client says about pay is trusted: elapsed time is capped
 * by the time since start-run, the difficulty and marque come from the row.
 */
export function settlePirateVoyage(s: PirateStateRow, report: PirateRunReport, now: number) {
    const startedAt = s.runStartedAt?.getTime() ?? now
    const wallMs = Math.max(0, Math.min(now - startedAt, PIRATE_RUN_DURATION_MS + FINISH_GRACE_MS))
    const elapsedMs = report.abandoned ? 0 : Math.min(report.elapsedMs, wallMs)
    const difficulty = s.runDifficulty ?? 0
    const power = s.runPower ?? 0
    const completed = !report.abandoned && report.survived && report.reason === 'timeout' && elapsedMs >= PIRATE_RUN_DURATION_MS - 1_000
    const pay = report.abandoned
        ? { survival: 0, completion: 0, firstClear: 0, total: 0 }
        : pirateVoyagePay(elapsedMs, difficulty, completed, s.marqueLevel, s.highestCompletedDifficulty)
    const bestCompleted = completed && (difficulty > s.highestCompletedDifficulty || (difficulty === s.highestCompletedDifficulty && pay.total > s.bestCompletedLoot))
    return { elapsedMs, difficulty, power, completed, pay, bestCompleted }
}

export function finishPirateRun(playerId: string, report: PirateRunReport, now = Date.now()): PirateFinishRunResponse {
    return writeTx((tx) => {
        const s = ensurePirateState(playerId, tx)
        if (!s.runId) fail('No voyage at sea')
        const result = settlePirateVoyage(s, report, now)
        const counted = !report.abandoned
        // Clearing the voyage is the guard: a replayed finish finds no run_id.
        const settled = tx.update(pirateState).set({
            runId: null,
            runStartedAt: null,
            runPower: null,
            runDifficulty: null,
            doubloons: sql`${pirateState.doubloons} + ${result.pay.total}`,
            totalEarned: sql`${pirateState.totalEarned} + ${result.pay.total}`,
            runsPlayed: counted ? s.runsPlayed + 1 : s.runsPlayed,
            bestSurvivalMs: counted ? Math.max(s.bestSurvivalMs, result.elapsedMs) : s.bestSurvivalMs,
            highestCompletedDifficulty: result.completed ? Math.max(s.highestCompletedDifficulty, result.difficulty) : s.highestCompletedDifficulty,
            ...(result.bestCompleted
                ? { bestCompletedLoot: result.pay.total, bestCompletedPower: result.power, bestCompletedSkinId: s.equippedSkinId }
                : {})
        })
            .where(and(eq(pirateState.playerId, playerId), eq(pirateState.runId, s.runId)))
            .returning({ doubloons: pirateState.doubloons })
            .get()
        if (!settled) fail('No voyage at sea')
        if (counted) {
            tx.insert(pirateRuns).values({
                id: s.runId,
                playerId,
                loot: result.pay.total,
                durationMs: result.elapsedMs,
                power: result.power,
                difficulty: result.difficulty,
                survived: report.survived,
                completed: result.completed,
                reason: report.reason,
                kills: report.kills,
                shotsFired: report.shotsFired,
                skinId: s.equippedSkinId
            }).run()
        }
        return {
            awarded: result.pay.total,
            survivalPay: result.pay.survival,
            completionBonus: result.pay.completion,
            firstClearBounty: result.pay.firstClear,
            elapsedMs: result.elapsedMs,
            survived: report.survived,
            completed: result.completed,
            difficulty: result.difficulty,
            doubloons: settled.doubloons
        }
    })
}

// ─── Spending ───────────────────────────────────────────────────────────────

/** Inside a writeTx: the captain's row, refusing while a voyage is at sea. */
function lockedHarbour(tx: Tx, playerId: string) {
    const s = ensurePirateState(playerId, tx)
    if (s.runId) fail('Finish the voyage first')
    return s
}

/**
 * Take `cost` doubloons and apply `set` in one guarded update: it only lands
 * while the captain can afford it and is in harbour. Returns the balance after.
 */
function spend(tx: Tx, playerId: string, cost: number, set: Partial<typeof pirateState.$inferInsert> = {}) {
    const row = tx.update(pirateState)
        .set({ ...set, doubloons: sql`${pirateState.doubloons} - ${cost}` })
        .where(and(eq(pirateState.playerId, playerId), gte(pirateState.doubloons, cost), isNull(pirateState.runId)))
        .returning({ doubloons: pirateState.doubloons })
        .get()
    if (!row) fail('Not enough doubloons')
    return row.doubloons
}

export function upgradePirateStat(playerId: string, stat: unknown) {
    if (typeof stat !== 'string' || !(PIRATE_SHIP_STAT_IDS as readonly string[]).includes(stat)) fail('Unknown stat')
    const statId = stat as PirateShipStatId
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const column = LEVEL_COLUMN[statId]
        const level = s[column]
        const cost = pirateStatUpgradeCost(statId, level)
        if (cost === null) fail('Already at max level')
        const doubloons = spend(tx, playerId, cost, { [column]: level + 1 })
        return { stat: statId, level: level + 1, doubloons }
    })
}

export function upgradePirateMarque(playerId: string) {
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const cost = pirateMarqueUpgradeCost(s.marqueLevel)
        if (cost === null) fail('Already at max level')
        const doubloons = spend(tx, playerId, cost, { marqueLevel: s.marqueLevel + 1 })
        return { level: s.marqueLevel + 1, doubloons }
    })
}

export function unlockPirateSlot(playerId: string) {
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const cost = pirateSlotUnlockCost(s.cannonSlots)
        if (cost === null) fail('Every gun port is open')
        const doubloons = spend(tx, playerId, cost, { cannonSlots: s.cannonSlots + 1 })
        return { cannonSlots: s.cannonSlots + 1, doubloons }
    })
}

function slotOf(value: unknown, slots: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= slots) fail('Gun port not open')
    return value
}

/**
 * Fit a cannon in a port, trading in the one already there for half what it
 * cost. One unit: the old gun is never lost to a failed purchase.
 */
export function fitPirateCannon(playerId: string, slot: unknown, tierId: unknown) {
    const tier = PIRATE_CANNON_TIERS.find(t => t.id === tierId)
    if (!tier) fail('Unknown cannon')
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const slotIndex = slotOf(slot, s.cannonSlots)
        const where = and(eq(pirateCannons.playerId, playerId), eq(pirateCannons.slotIndex, slotIndex))
        const current = tx.select().from(pirateCannons).where(where).get()
        if (current?.tierId === tier.id) fail('That cannon is already fitted')
        const price = pirateCannonCost(tier.id)
        const tradeIn = current ? pirateCannonTradeIn(current.purchasePrice) : 0
        const doubloons = spend(tx, playerId, price - tradeIn)
        if (current) tx.delete(pirateCannons).where(where).run()
        tx.insert(pirateCannons).values({ playerId, slotIndex, tierId: tier.id, purchasePrice: price }).run()
        return { slotIndex, tierId: tier.id, doubloons }
    })
}

export function sellPirateCannon(playerId: string, slot: unknown) {
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const slotIndex = slotOf(slot, s.cannonSlots)
        // The delete is the guard: a second sell of the same port finds nothing.
        const sold = tx.delete(pirateCannons)
            .where(and(eq(pirateCannons.playerId, playerId), eq(pirateCannons.slotIndex, slotIndex)))
            .returning({ purchasePrice: pirateCannons.purchasePrice })
            .get()
        if (!sold) fail('No cannon in that port', 404)
        const refund = pirateCannonTradeIn(sold.purchasePrice)
        const row = tx.update(pirateState)
            .set({ doubloons: sql`${pirateState.doubloons} + ${refund}` })
            .where(eq(pirateState.playerId, playerId))
            .returning({ doubloons: pirateState.doubloons })
            .get()!
        return { slotIndex, refund, doubloons: row.doubloons }
    })
}

/** Swap the cannons of two ports (either may be empty: then it is a move). Free. */
export function swapPirateCannons(playerId: string, slotA: unknown, slotB: unknown) {
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const a = slotOf(slotA, s.cannonSlots)
        const b = slotOf(slotB, s.cannonSlots)
        if (a === b) fail('Pick two different ports')
        const at = (slotIndex: number) => and(eq(pirateCannons.playerId, playerId), eq(pirateCannons.slotIndex, slotIndex))
        const hasA = tx.select({ slotIndex: pirateCannons.slotIndex }).from(pirateCannons).where(at(a)).get()
        const hasB = tx.select({ slotIndex: pirateCannons.slotIndex }).from(pirateCannons).where(at(b)).get()
        if (!hasA && !hasB) fail('Both ports are empty')
        // Through a parking index so the primary key never sees two guns in one port.
        tx.update(pirateCannons).set({ slotIndex: -1 }).where(at(a)).run()
        tx.update(pirateCannons).set({ slotIndex: a }).where(at(b)).run()
        tx.update(pirateCannons).set({ slotIndex: b }).where(at(-1)).run()
        return { slotA: a, slotB: b }
    })
}

export function buyPirateAbility(playerId: string, abilityId: unknown) {
    const ability = PIRATE_ABILITIES.find(entry => entry.id === abilityId)
    if (!ability || pirateAbilityCost(ability.id) <= 0) fail('Unknown ability')
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const owned = ownedAbilities(s)
        if (owned.has(ability.id)) fail('Already owned')
        const doubloons = spend(tx, playerId, pirateAbilityCost(ability.id), {
            ownedAbilityIds: [...owned, ability.id],
            equippedAbilityId: ability.id
        })
        return { abilityId: ability.id, doubloons }
    })
}

export function equipPirateAbility(playerId: string, abilityId: unknown) {
    const ability = PIRATE_ABILITIES.find(entry => entry.id === abilityId)
    if (!ability) fail('Unknown ability')
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        if (!ownedAbilities(s).has(ability.id)) fail('Unlock this ability first')
        tx.update(pirateState).set({ equippedAbilityId: ability.id }).where(eq(pirateState.playerId, playerId)).run()
        return { abilityId: ability.id }
    })
}

export function upgradePirateAbility(playerId: string, abilityId: unknown) {
    const ability = PIRATE_ABILITIES.find(entry => entry.id === abilityId)
    if (!ability) fail('Unknown ability')
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        if (!ownedAbilities(s).has(ability.id)) fail('Unlock this ability first')
        const level = pirateClampAbilityLevel(s.abilityLevels[ability.id] ?? 1)
        const cost = pirateAbilityUpgradeCost(level)
        if (cost === null) fail('Already at max level')
        const doubloons = spend(tx, playerId, cost, { abilityLevels: { ...s.abilityLevels, [ability.id]: level + 1 } })
        return { abilityId: ability.id, level: level + 1, doubloons }
    })
}

export function buyPirateSkin(playerId: string, skinId: unknown) {
    const skin = PIRATE_SHIP_SKINS.find(entry => entry.id === skinId)
    if (!skin || pirateSkinCost(skin.id) <= 0) fail('Unknown skin')
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        const owned = ownedSkins(s)
        if (owned.has(skin.id)) fail('Already owned')
        const doubloons = spend(tx, playerId, pirateSkinCost(skin.id), { ownedSkinIds: [...owned, skin.id], equippedSkinId: skin.id })
        return { skinId: skin.id, doubloons }
    })
}

export function equipPirateSkin(playerId: string, skinId: unknown) {
    const skin = PIRATE_SHIP_SKINS.find(entry => entry.id === skinId)
    if (!skin) fail('Unknown skin')
    return writeTx((tx) => {
        const s = lockedHarbour(tx, playerId)
        if (!ownedSkins(s).has(skin.id)) fail('Buy this skin first')
        tx.update(pirateState).set({ equippedSkinId: skin.id }).where(eq(pirateState.playerId, playerId)).run()
        return { skinId: skin.id }
    })
}

// ─── Log and legends ────────────────────────────────────────────────────────

export function pirateLog(playerId: string): PirateLogEntry[] {
    return db.select().from(pirateRuns)
        .where(eq(pirateRuns.playerId, playerId))
        .orderBy(desc(pirateRuns.createdAt))
        .limit(50)
        .all()
        .map(row => ({
            id: row.id,
            loot: row.loot,
            durationMs: row.durationMs,
            power: row.power,
            difficulty: row.difficulty,
            survived: row.survived,
            completed: row.completed,
            reason: row.reason,
            kills: row.kills,
            shotsFired: row.shotsFired,
            skin: { id: pirateShipSkin(row.skinId).id, name: pirateShipSkin(row.skinId).name },
            createdAt: row.createdAt.getTime()
        }))
}

/** Ranked by the highest difficulty survived for all six minutes, then by that voyage's haul. */
export function pirateLegends(playerId: string): PirateLegend[] {
    return db.select({
        playerId: pirateState.playerId,
        name: players.name,
        image: players.image,
        difficulty: pirateState.highestCompletedDifficulty,
        power: pirateState.bestCompletedPower,
        loot: pirateState.bestCompletedLoot,
        skinId: pirateState.bestCompletedSkinId
    })
        .from(pirateState)
        .innerJoin(players, eq(players.id, pirateState.playerId))
        .where(gte(pirateState.highestCompletedDifficulty, 0))
        .orderBy(desc(pirateState.highestCompletedDifficulty), desc(pirateState.bestCompletedLoot))
        .limit(50)
        .all()
        .map((row, index) => ({
            rank: index + 1,
            isCurrentPlayer: row.playerId === playerId,
            name: row.name,
            image: row.image,
            difficulty: row.difficulty,
            power: row.power,
            loot: row.loot,
            skin: { id: pirateShipSkin(row.skinId).id, name: pirateShipSkin(row.skinId).name }
        }))
}
