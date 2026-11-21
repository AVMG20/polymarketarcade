import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { db, writeTx, type DbExecutor, type Tx } from '#server/database'
import { voidItems, voidRunHistory, voidState } from '#server/database/schema'
import { randomFloat } from '#shared/utils/random'
import {
    VOID_MAX_HAUL_UNITS, VOID_MAX_SECTOR, VOID_MAX_SHIP_TIER, VOID_SHIP_IDS, VOID_SHIPS, VOID_STALE_RUN_MS, voidAddBundles, voidApplyBeaconReport, voidAutoFit,
    voidBeaconStates, voidCanAfford, voidCleanBeacons, voidCleanBundle, voidDerivedStats, voidDescribeState, voidGearTier, voidLoadoutFor, voidNormalizeFit,
    voidNormalizeLevels, voidNormalizeShipTiers, voidOwnedShips, voidPowerRating, voidRefitCost, voidRollBeaconAttack, voidSector, voidSectorUnlocked,
    voidSettleRun, voidShipTier, voidShipUnlocked, voidSubtractBundle, voidUpgradeCost, type VoidPrice, type VoidResourceBundle, type VoidShipFit, type VoidUpgradeId
} from '#shared/void-runner/void'
import {
    VOID_ITEM_MILESTONES, VOID_ITEM_TYPES, VOID_MOD_IDS, voidCanCraftTier, voidCraftCost, voidItemName, voidItemUpgradeCost, voidMod, voidRollBonusAffix,
    voidRollItem, voidRollMod, voidRollSalvagedGear, voidSalvageValue, type VoidItem, type VoidItemKind
} from '#shared/void-runner/void-items'
import { VOID_SKILLS, voidPilotLevel, voidRunXp, voidSkillCost, voidUnlockedSkills, voidValidateSkillNodes } from '#shared/void-runner/void-skills'
import {
    VOID_BLUEPRINT_KINDS, VOID_DAILY_BLUEPRINTS, VOID_DAILY_RELICS, VOID_MAX_RUN_CACHES, VOID_PERK_IDS, voidAllowedDepth, voidBountyXp, voidCapitalKills, voidGearCap,
    voidLoreForSector, voidNormalizePerks, voidPerkCost, voidRunMarks, type VoidPerkId
} from '#shared/void-runner/void-pilot'
import {
    VOID_CONTRACTS_PER_DAY, VOID_SUPPLY_CARRY, VOID_SUPPLY_IDS, VOID_SUPPLY_STOCK_MAX, voidContractDay, voidContractsFor, voidNormalizeSupplies, voidSupplyCost,
    type VoidSupplyId
} from '#shared/void-runner/void-station'
import { VOID_BALANCE_VERSION, voidCleanTelemetry } from '#shared/void-runner/void-telemetry'

/**
 * Void Runner on the server. Every value-changing call is one synchronous
 * `writeTx` (BEGIN IMMEDIATE): the pilot row is read and written under the
 * write lock, so a burst of parallel purchases pays for each step once, and
 * a finish clears `runStartedAt` with a conditional update (the claim).
 */

export type VoidStateRow = typeof voidState.$inferSelect

function fail(statusMessage: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage })
}

/** Creates the pilot row on first visit and hands out the starter kit once. */
export function ensureVoidPilot(playerId: string) {
    writeTx((tx) => {
        tx.insert(voidState).values({ playerId }).onConflictDoNothing().run()
        // Flipping `starterGranted` is the claim, so a burst of first visits grants the kit once.
        const claimed = tx.update(voidState).set({ starterGranted: true })
            .where(and(eq(voidState.playerId, playerId), eq(voidState.starterGranted, false)))
            .returning({ loadouts: voidState.loadouts }).get()
        if (!claimed) return
        const kit = tx.insert(voidItems).values([
            { playerId, kind: 'gun', type: 'blaster', tier: 1 },
            { playerId, kind: 'turret', type: 'pulse', tier: 1 },
            { playerId, kind: 'armor', type: 'plating', tier: 1 },
            { playerId, kind: 'shield', type: 'deflector', tier: 1 },
            { playerId, kind: 'secondary', type: 'seekers', tier: 1 },
            { playerId, kind: 'device', type: 'booster', tier: 1 }
        ]).returning({ id: voidItems.id, kind: voidItems.kind }).all()
        const id = (kind: string) => kit.find(k => k.kind === kind)!.id
        const fit: VoidShipFit = { gun: id('gun'), turrets: [id('turret')], armor: [id('armor')], shields: [id('shield')], secondary: id('secondary'), device: id('device') }
        tx.update(voidState).set({ loadouts: { ...(claimed.loadouts ?? {}), sparrow: fit } }).where(eq(voidState.playerId, playerId)).run()
    })
}

function pilotRow(tx: DbExecutor, playerId: string): VoidStateRow {
    const row = tx.select().from(voidState).where(eq(voidState.playerId, playerId)).get()
    if (!row) fail('No pilot yet', 404)
    return row
}

export function listVoidItems(executor: DbExecutor, playerId: string): VoidItem[] {
    return executor.select().from(voidItems).where(eq(voidItems.playerId, playerId)).all()
        .map(r => ({ id: r.id, kind: r.kind as VoidItemKind, type: r.type, tier: r.tier, rarity: r.rarity, level: r.level, affixes: r.affixes ?? {}, mod: r.mod }))
}

function docked(s: VoidStateRow, what: string) {
    if (s.runStartedAt) fail(what)
}

/** Charges a price against the banked materials; 400 when short. */
function charge(stores: Record<string, number>, price: VoidPrice): VoidResourceBundle {
    const held = voidCleanBundle(stores)
    if (!voidCanAfford(held, price.resources)) fail('Not enough materials')
    return voidSubtractBundle(held, price.resources)
}

function setState(tx: Tx, playerId: string, values: Partial<typeof voidState.$inferInsert>) {
    tx.update(voidState).set(values).where(eq(voidState.playerId, playerId)).run()
}

export function describeVoidPilot(playerId: string) {
    ensureVoidPilot(playerId)
    const state = pilotRow(db, playerId)
    return voidDescribeState({ ...state, userId: playerId }, listVoidItems(db, playerId))
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export function voidLaunch(playerId: string, tier: number, force = false) {
    if (!Number.isInteger(tier) || !voidSectorUnlocked(tier, Number.POSITIVE_INFINITY)) fail('Invalid sector')
    ensureVoidPilot(playerId)
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        if (s.runStartedAt) {
            // A run nobody finished is a closed tab. It banks nothing, but it
            // still counts as a run so the history stays honest.
            const stale = Date.now() - s.runStartedAt.getTime() > VOID_STALE_RUN_MS
            if (!stale && !force) fail('A run is already in progress', 409)
            // Supplies loaded into that run were spent with it.
            setState(tx, playerId, { runStartedAt: null, runSector: null, runShipId: null, runCargo: null, runsPlayed: s.runsPlayed + 1, runSupplies: null })
        }
        if (!voidSectorUnlocked(tier, s.highestSectorCleared)) fail('Kill the previous warden first')
        const items = listVoidItems(tx, playerId)
        // A hull that has never been fitted flies with your best gear instead of bare hardpoints.
        if (!s.loadouts?.[s.equippedShipId] && items.length) {
            s.loadouts = { ...(s.loadouts ?? {}), [s.equippedShipId]: voidAutoFit(s.equippedShipId, items) }
            setState(tx, playerId, { loadouts: s.loadouts })
        }
        const loadout = voidLoadoutFor(s, items)
        const stats = voidDerivedStats(loadout.shipId, loadout.levels, loadout.fit, items, loadout.perks, loadout.shipTier)
        const startedAt = new Date()
        // The ship takes up to a full rack of each supply out of stock.
        const stock = voidNormalizeSupplies(s.supplies)
        const taken = {} as Record<string, number>
        const left = { ...stock }
        for (const id of VOID_SUPPLY_IDS) {
            taken[id] = Math.min(VOID_SUPPLY_CARRY, stock[id])
            left[id] = stock[id] - taken[id]
        }
        // Raiders may have moved on a beacon held past its 32 hours.
        const beacons = voidRollBeaconAttack(voidCleanBeacons(s.beacons), tier, startedAt.getTime(), randomFloat)
        const claimed = tx.update(voidState)
            .set({ beacons, runStartedAt: startedAt, runSector: tier, runShipId: loadout.shipId, runCargo: stats.cargo, supplies: left, runSupplies: taken })
            .where(and(eq(voidState.playerId, playerId), isNull(voidState.runStartedAt)))
            .returning({ playerId: voidState.playerId }).get()
        if (!claimed) fail('A run is already in progress', 409)
        return { startedAt, sector: voidSector(tier), loadout, stats, supplies: taken, beacons: voidBeaconStates(beacons, tier) }
    })
}

export interface VoidFinishReport {
    reason: 'extracted' | 'destroyed' | 'abandoned'
    haul?: unknown
    elapsedMs?: unknown
    kills?: unknown
    wardenKilled?: unknown
    skillUses?: unknown
    suppliesUsed?: unknown
    relics?: unknown
    depth?: unknown
    carrierKilled?: unknown
    tyrantKilled?: unknown
    harbingerKilled?: unknown
    /** The run's own record of itself, kept for balance audits. It pays nothing. */
    telemetry?: unknown
    lore?: unknown
    gearCaches?: unknown
    bonusXp?: unknown
    beaconsCaptured?: unknown
    beaconsDefended?: unknown
}

/**
 * Settles the active run. Clearing `runStartedAt` with a conditional update
 * is the claim, so a double-submitted finish banks exactly once. The haul is
 * capped by what the hull could hold and the time flown; boss kills, caches
 * and depth are checked against the run's length.
 */
export function voidFinishRun(playerId: string, body: VoidFinishReport) {
    const reason = body.reason
    const extracted = reason === 'extracted'
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        if (!s.runStartedAt) fail('No active run')
        const wallMs = Date.now() - s.runStartedAt.getTime()
        const tier = s.runSector ?? 1
        const report = {
            extracted,
            haul: voidCleanBundle(body.haul as Record<string, unknown>),
            elapsedMs: Number(body.elapsedMs) || 0,
            kills: Number(body.kills) || 0,
            wardenKilled: body.wardenKilled === true,
            carrierKilled: body.carrierKilled === true,
            tyrantKilled: body.tyrantKilled === true,
            harbingerKilled: body.harbingerKilled === true,
            depth: Number(body.depth) || 1
        }
        const reportedUnits = Object.values(report.haul).reduce((sum, n) => sum + (n ?? 0), 0)
        if (reportedUnits > VOID_MAX_HAUL_UNITS) fail('The station refused this haul: no hold carries that much')
        const settled = voidSettleRun(report, tier, wallMs, s.runCargo ?? Infinity)

        const clearedNow = extracted && settled.wardenKilled && tier > s.highestSectorCleared
        const highestSectorCleared = clearedNow ? Math.min(VOID_MAX_SECTOR, tier) : s.highestSectorCleared
        const today = voidContractDay()
        const sameDay = s.rewardsDay === today
        // Relic caches only come home with the hold. The client reports how
        // many it picked up; the server rolls what they hold, within the
        // per-run sanity limit and the daily limit.
        const relicsToday = sameDay ? s.relicsToday : 0
        const relicCount = extracted ? Math.max(0, Math.min(Math.floor(Number(body.relics) || 0), VOID_MAX_RUN_CACHES, VOID_DAILY_RELICS - relicsToday)) : 0
        const relics: string[] = []
        const mods = { ...(s.mods ?? {}) }
        for (let i = 0; i < relicCount; i++) {
            const mod = voidRollMod(randomFloat)
            relics.push(mod)
            mods[mod] = (mods[mod] ?? 0) + 1
        }
        const depth = voidAllowedDepth(report.depth, settled.elapsedMs)
        const capitals = voidCapitalKills(report, settled.elapsedMs)
        // Marks come from the trophy flags, never a reported number.
        const marksToday = sameDay ? s.marksToday : 0
        const blueprintsToday = sameDay ? s.blueprintsToday : 0
        const marks = voidRunMarks({ ...report, wardenKilled: settled.wardenKilled, depth, elapsedMs: settled.elapsedMs, sector: tier })
        const blueprints = [...(s.blueprints ?? [])]
        let blueprint: string | null = null
        const blueprintChance = !extracted || blueprintsToday >= VOID_DAILY_BLUEPRINTS ? 0 : (settled.wardenKilled ? 0.25 : 0) + (capitals.carrier ? 0.25 : 0) + (capitals.tyrant ? 0.25 : 0) + (capitals.harbinger ? 0.35 : 0)
        if (blueprintChance > 0 && randomFloat() < blueprintChance) {
            const pool = VOID_ITEM_TYPES.filter(t => VOID_BLUEPRINT_KINDS.includes(t.kind) && t.minTier <= Math.min(5, s.highestSectorCleared + 2) && !blueprints.includes(t.id))
            if (pool.length) {
                blueprint = pool[Math.floor(randomFloat() * pool.length)]!.id
                blueprints.push(blueprint)
            }
        }
        const sectorLore = voidLoreForSector(tier)
        const reportedLore = Array.isArray(body.lore) ? body.lore.map(String).filter(id => sectorLore.includes(id)) : []
        const newLore = extracted ? [...new Set(reportedLore)].filter(id => !(s.lore ?? []).includes(id)).slice(0, 3) : []
        // Salvaged gear: the client reports caches picked up; the server rolls real items, within the daily limit.
        const gearToday = sameDay ? s.gearToday : 0
        const gearCount = extracted ? Math.max(0, Math.min(Math.floor(Number(body.gearCaches) || 0), voidGearCap(gearToday))) : 0
        const gearRolled = Array.from({ length: gearCount }, () => voidRollSalvagedGear(Math.min(tier, Math.min(5, s.highestSectorCleared + 1)), randomFloat))
        // XP is earned whether or not the hold made it home.
        const xp = voidRunXp({ extracted, kills: settled.kills, elapsedMs: settled.elapsedMs, wardenKilled: settled.wardenKilled, tier, skillUses: Number(body.skillUses) || 0 }) + voidBountyXp(body.bonusXp)
        // Beacons change hands whether or not the hold made it home: the fight was won out there.
        const beacons = voidApplyBeaconReport(voidCleanBeacons(s.beacons), tier, { captured: body.beaconsCaptured, defended: body.beaconsDefended }, Date.now(), settled.elapsedMs)

        const claimed = tx.update(voidState).set({
            runStartedAt: null,
            runSector: null,
            runShipId: null,
            runCargo: null,
            runSupplies: null,
            resources: voidAddBundles(voidCleanBundle(s.resources), settled.haul),
            runsPlayed: s.runsPlayed + 1,
            extractions: s.extractions + (extracted ? 1 : 0),
            kills: s.kills + settled.kills,
            wardensKilled: s.wardensKilled + (extracted && settled.wardenKilled ? 1 : 0),
            highestSectorCleared,
            bestHaulValue: Math.max(s.bestHaulValue, settled.value),
            pilotXp: s.pilotXp + xp,
            mods,
            marks: s.marks + marks,
            rewardsDay: today,
            marksToday: marksToday + marks,
            blueprintsToday: blueprintsToday + (blueprint ? 1 : 0),
            gearToday: gearToday + gearCount,
            relicsToday: relicsToday + relicCount,
            blueprints,
            lore: [...(s.lore ?? []), ...newLore],
            beacons: beacons.records
        }).where(and(eq(voidState.playerId, playerId), isNotNull(voidState.runStartedAt)))
            .returning({ playerId: voidState.playerId }).get()
        if (!claimed) fail('No active run')

        const gear = gearRolled.length
            ? tx.insert(voidItems).values(gearRolled.map(item => ({ playerId, ...item }))).returning({ id: voidItems.id, type: voidItems.type, tier: voidItems.tier, rarity: voidItems.rarity, affixes: voidItems.affixes }).all()
            : []

        // The audit blob: the ship as the server knows it, what this finish granted and the run's telemetry.
        const items = listVoidItems(tx, playerId)
        const loadout = voidLoadoutFor(s, items, s.runShipId ?? s.equippedShipId)
        const stats = voidDerivedStats(loadout.shipId, loadout.levels, loadout.fit, items, loadout.perks, loadout.shipTier)
        const fitted = (id: string | null) => {
            const item = id ? items.find(i => i.id === id) : undefined
            return item ? { type: item.type, tier: item.tier, rarity: item.rarity, level: item.level, mod: item.mod ?? null } : null
        }
        const meta = {
            v: VOID_BALANCE_VERSION,
            ship: {
                id: loadout.shipId, tier: loadout.shipTier, power: voidPowerRating(loadout, stats), gearTier: voidGearTier(loadout.shipId, loadout.fit, items),
                hull: stats.hull, shield: stats.shield, cargo: s.runCargo ?? 0, levels: loadout.levels, skill: loadout.skill.id, pilotLevel: voidPilotLevel(s.pilotXp ?? 0),
                gun: fitted(loadout.fit.gun), turrets: loadout.fit.turrets.map(fitted), armor: loadout.fit.armor.map(fitted), shields: loadout.fit.shields.map(fitted),
                secondary: fitted(loadout.fit.secondary), device: fitted(loadout.fit.device)
            },
            run: {
                depth, wallMs, reportedKills: report.kills, reportedUnits, trimmed: extracted && reportedUnits > settled.units,
                claimed: { warden: report.wardenKilled, carrier: report.carrierKilled, tyrant: report.tyrantKilled, harbinger: report.harbingerKilled },
                accepted: { warden: settled.wardenKilled, ...capitals },
                skillUses: Number(body.skillUses) || 0, suppliesUsed: voidNormalizeSupplies(body.suppliesUsed as Record<string, unknown> | null),
                granted: { xp, marks, relics: relics.length, gear: gear.length, blueprint, sectorCleared: clearedNow }
            },
            client: voidCleanTelemetry(body.telemetry)
        }
        tx.insert(voidRunHistory).values({
            playerId,
            meta,
            sector: tier,
            shipId: s.runShipId ?? s.equippedShipId,
            durationMs: settled.elapsedMs,
            haul: settled.haul,
            haulValue: settled.value,
            extracted,
            reason,
            kills: settled.kills,
            wardenKilled: extracted && settled.wardenKilled
        }).run()

        return {
            reason,
            extracted,
            haul: settled.haul,
            value: settled.value,
            units: settled.units,
            kills: settled.kills,
            sectorCleared: clearedNow ? voidSector(tier).name : null,
            /** The sector this clear opened, when there is a deeper one. */
            sectorOpened: clearedNow && tier < VOID_MAX_SECTOR ? voidSector(tier + 1).name : null,
            /** A reported warden kill the run was too short to hold. Never silent: the pilot is told. */
            wardenRejected: extracted && report.wardenKilled && !settled.wardenKilled,
            xp,
            levelBefore: voidPilotLevel(s.pilotXp),
            levelAfter: voidPilotLevel(s.pilotXp + xp),
            relics,
            marks,
            blueprint,
            lore: newLore,
            depth,
            beaconsCaptured: beacons.captured,
            beaconsDefended: beacons.defended,
            gear: gear.map(g => ({ name: voidItemName(g), tier: g.tier, rarity: g.rarity })),
            /** Caches picked up that came back empty: over the run or daily limit. */
            gearEmpty: extracted ? Math.min(10, Math.max(0, Math.floor(Number(body.gearCaches) || 0) - gearCount)) : 0
        }
    })
}

// ─── Station ────────────────────────────────────────────────────────────────

/** Buys supplies into station stock. */
export function voidBuySupplies(playerId: string, id: VoidSupplyId, count: number) {
    if (!VOID_SUPPLY_IDS.includes(id)) fail('Invalid supply')
    if (!Number.isInteger(count) || count < 1 || count > 10) fail('Invalid amount')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before restocking')
        const stock = voidNormalizeSupplies(s.supplies)
        const n = Math.min(count, VOID_SUPPLY_STOCK_MAX - stock[id])
        if (n <= 0) fail('Stock is full')
        const unit = voidSupplyCost(id, s.highestSectorCleared, voidNormalizePerks(s.perks).quartermaster > 0)
        const price = { resources: Object.fromEntries(Object.entries(unit.resources).map(([k, v]) => [k, v! * n])) }
        const resources = charge(s.resources, price)
        setState(tx, playerId, { supplies: { ...stock, [id]: stock[id] + n }, resources })
        return { supply: id, stock: stock[id] + n }
    })
}

/** Delivers one of today's contracts: materials in, alloy and XP out, once per contract per day. */
export function voidClaimContract(playerId: string, index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= VOID_CONTRACTS_PER_DAY) fail('Invalid contract')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        const day = voidContractDay()
        const done = s.contractsDay === day ? (s.contractsDone ?? []) : []
        if (done.includes(index)) fail('Contract already delivered')
        const contract = voidContractsFor(playerId, day, s.highestSectorCleared)[index]!
        const left = charge(s.resources, { resources: { [contract.resource]: contract.amount } })
        setState(tx, playerId, {
            resources: voidAddBundles(left, { alloy: contract.alloy }),
            contractsDay: day,
            contractsDone: [...done, index],
            pilotXp: s.pilotXp + contract.xp
        })
        return { contract }
    })
}

/** Buys one rank of a pilot perk with Command Marks. */
export function voidBuyPerk(playerId: string, id: VoidPerkId) {
    if (!VOID_PERK_IDS.includes(id)) fail('Invalid perk')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        const ranks = voidNormalizePerks(s.perks)
        const cost = voidPerkCost(id, ranks[id])
        if (cost === null) fail('Already at max rank')
        if (s.marks < cost) fail('Not enough Command Marks')
        setState(tx, playerId, { marks: s.marks - cost, perks: { ...ranks, [id]: ranks[id] + 1 } })
        return { perk: id, rank: ranks[id] + 1 }
    })
}

export function voidBuyUpgrade(playerId: string, id: VoidUpgradeId) {
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before refitting')
        const levels = voidNormalizeLevels(s.upgradeLevels)
        const price = voidUpgradeCost(id, levels[id])
        if (!price) fail('Already at max level')
        const resources = charge(s.resources, price)
        const next = { ...levels, [id]: levels[id] + 1 }
        setState(tx, playerId, { upgradeLevels: next, resources })
        return { upgrade: id, level: next[id] }
    })
}

// ─── Shipyard ───────────────────────────────────────────────────────────────

export function voidBuyShip(playerId: string, shipId: string) {
    const ship = VOID_SHIPS.find(s => s.id === shipId)
    if (!ship) fail('Invalid ship')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before visiting the shipyard')
        const owned = voidOwnedShips(s)
        if (owned.includes(ship.id)) fail('Already in your fleet')
        if (s.highestSectorCleared < ship.requiresSector) fail(`Clear sector ${ship.requiresSector} first`)
        if (!voidShipUnlocked(ship, s.highestSectorCleared, owned)) fail('Own every other ship first')
        const resources = charge(s.resources, { resources: ship.cost })
        // A new hull comes out of the yard fitted with your best gear.
        const fit = voidAutoFit(ship.id, listVoidItems(tx, playerId))
        setState(tx, playerId, { ownedShipIds: [...owned, ship.id], equippedShipId: ship.id, resources, loadouts: { ...(s.loadouts ?? {}), [ship.id]: fit } })
        return { shipId: ship.id }
    })
}

export function voidEquipShip(playerId: string, shipId: string) {
    if (!VOID_SHIP_IDS.includes(shipId)) fail('Invalid ship')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before changing ships')
        if (!voidOwnedShips(s).includes(shipId)) fail('Ship not owned')
        setState(tx, playerId, { equippedShipId: shipId })
        return { shipId }
    })
}

/** Lifts a hull one tier. Each tier is read and charged under the write lock, so a burst pays for every tier it takes. */
export function voidRefitShip(playerId: string, shipId: string) {
    if (!VOID_SHIP_IDS.includes(shipId)) fail('Invalid ship')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before visiting the shipyard')
        if (!voidOwnedShips(s).includes(shipId)) fail('Ship not owned')
        const tier = voidShipTier(shipId, s.shipTiers) + 1
        const cost = tier <= VOID_MAX_SHIP_TIER ? voidRefitCost(tier) : null
        if (!cost) fail('This hull is fully refitted')
        if (s.highestSectorCleared < tier - 1) fail(`Clear sector ${tier - 1} first`)
        const resources = charge(s.resources, cost)
        setState(tx, playerId, { resources, shipTiers: { ...voidNormalizeShipTiers(s.shipTiers), [shipId]: tier } })
        return { shipId, tier }
    })
}

/** Fits gear to a hull. Unknown or mismatched ids simply become empty slots. */
export function voidSetFit(playerId: string, shipId: string, raw: unknown) {
    if (!VOID_SHIP_IDS.includes(shipId)) fail('Invalid ship')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before refitting')
        if (!voidOwnedShips(s).includes(shipId)) fail('Ship not owned')
        const fit = voidNormalizeFit(shipId, raw, listVoidItems(tx, playerId))
        setState(tx, playerId, { loadouts: { ...(s.loadouts ?? {}), [shipId]: fit } })
        return { shipId, fit }
    })
}

// ─── Skills ─────────────────────────────────────────────────────────────────

export function voidUnlockSkill(playerId: string, skillId: string) {
    const skill = VOID_SKILLS.find(s => s.id === skillId)
    if (!skill) fail('Invalid skill')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before refitting')
        const unlocked = voidUnlockedSkills(s)
        if (unlocked.includes(skill.id)) fail('Already unlocked')
        if (s.highestSectorCleared < skill.requiresSector) fail(`Clear sector ${skill.requiresSector} first`)
        const resources = charge(s.resources, { resources: voidSkillCost(skill) })
        setState(tx, playerId, { unlockedSkills: [...unlocked, skill.id], equippedSkill: skill.id, resources })
        return { skillId: skill.id }
    })
}

export function voidEquipSkill(playerId: string, skillId: string) {
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before refitting')
        if (!voidUnlockedSkills(s).includes(skillId)) fail('Skill not unlocked')
        setState(tx, playerId, { equippedSkill: skillId })
        return { skillId }
    })
}

/** Replaces a skill's allocated nodes. Respecs are free. */
export function voidSetSkillNodes(playerId: string, skillId: string, raw: unknown) {
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before refitting')
        if (!voidUnlockedSkills(s).includes(skillId)) fail('Skill not unlocked')
        const nodes = voidValidateSkillNodes(skillId, raw, voidPilotLevel(s.pilotXp))
        if (!nodes) fail('Invalid skill tree')
        setState(tx, playerId, { skillNodes: { ...(s.skillNodes ?? {}), [skillId]: nodes } })
        return { skillId, nodes }
    })
}

// ─── Gear ───────────────────────────────────────────────────────────────────

/** Crafts one item; the roll uses the CSPRNG. */
export function voidCraftItem(playerId: string, kind: VoidItemKind, type: string, tier: number) {
    const def = VOID_ITEM_TYPES.find(t => t.id === type && t.kind === kind)
    if (!def || !Number.isInteger(tier) || tier < def.minTier) fail('Invalid blueprint')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        if (!voidCanCraftTier(tier, s.highestSectorCleared)) fail(`Clear sector ${tier - 1} to craft T${tier}`)
        const resources = charge(s.resources, voidCraftCost(kind, tier, type))
        const rolled = voidRollItem(kind, type, tier, randomFloat, (s.blueprints ?? []).includes(type))
        setState(tx, playerId, { resources })
        const row = tx.insert(voidItems).values({ playerId, ...rolled }).returning({ id: voidItems.id }).get()
        return { item: { ...rolled, id: row.id } }
    })
}

function ownedItem(tx: Tx, playerId: string, itemId: string) {
    const row = tx.select().from(voidItems).where(and(eq(voidItems.id, itemId), eq(voidItems.playerId, playerId))).get()
    if (!row) fail('Item not found', 404)
    return row
}

/** Levels an item one step. */
export function voidUpgradeItem(playerId: string, itemId: string) {
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before upgrading')
        const item = ownedItem(tx, playerId, itemId)
        const price = voidItemUpgradeCost({ kind: item.kind as VoidItemKind, type: item.type, tier: item.tier, level: item.level })
        if (!price) fail('Already at max level')
        const resources = charge(s.resources, price)
        setState(tx, playerId, { resources })
        const level = item.level + 1
        // Milestone levels roll a bonus affix.
        const milestone = VOID_ITEM_MILESTONES.includes(level)
        const affixes = milestone ? voidRollBonusAffix({ kind: item.kind as VoidItemKind, rarity: item.rarity, affixes: item.affixes ?? {} }, randomFloat) : item.affixes
        tx.update(voidItems).set({ level, affixes }).where(eq(voidItems.id, item.id)).run()
        return { itemId, level, milestone }
    })
}

/** Scraps an item for a quarter of its craft materials. The delete is the claim. */
export function voidSalvageItem(playerId: string, itemId: string) {
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before salvaging')
        const row = tx.delete(voidItems).where(and(eq(voidItems.id, itemId), eq(voidItems.playerId, playerId))).returning().get()
        if (!row) fail('Item not found', 404)
        const refund = voidSalvageValue({ kind: row.kind as VoidItemKind, type: row.type, tier: row.tier })
        // Pull it off every hull it was fitted to.
        const loadouts: Record<string, unknown> = {}
        for (const [shipId, raw] of Object.entries(s.loadouts ?? {})) {
            const fit = raw as Partial<VoidShipFit>
            const strip = (list: unknown) => (Array.isArray(list) ? list.map(x => (x === itemId ? null : x)) : [])
            const one = (id: string | null | undefined) => (id === itemId ? null : id ?? null)
            loadouts[shipId] = { ...fit, gun: one(fit.gun), turrets: strip(fit.turrets), armor: strip(fit.armor), shields: strip(fit.shields), secondary: one(fit.secondary), device: one(fit.device) }
        }
        setState(tx, playerId, { resources: voidAddBundles(voidCleanBundle(s.resources), refund), loadouts })
        return { itemId, refund }
    })
}

/** Sockets a relic mod, consuming it. Anything already socketed is destroyed. */
export function voidSocketMod(playerId: string, itemId: string, modId: string) {
    const mod = voidMod(modId)
    if (!mod || !VOID_MOD_IDS.includes(mod.id)) fail('Invalid mod')
    return writeTx((tx) => {
        const s = pilotRow(tx, playerId)
        docked(s, 'Dock before socketing')
        const item = ownedItem(tx, playerId, itemId)
        if (!mod.kinds.includes(item.kind as VoidItemKind)) fail('That mod does not fit this item')
        const held = Math.floor(Number(s.mods?.[mod.id]) || 0)
        if (held < 1) fail('No mod of that kind')
        setState(tx, playerId, { mods: { ...(s.mods ?? {}), [mod.id]: held - 1 } })
        tx.update(voidItems).set({ mod: mod.id }).where(eq(voidItems.id, item.id)).run()
        return { itemId, mod: mod.id }
    })
}
