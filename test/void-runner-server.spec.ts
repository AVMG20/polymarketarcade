import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../server/database'
import { voidItems, voidRunHistory, voidState } from '../server/database/schema'
import {
    describeVoidPilot, ensureVoidPilot, voidBuyPerk, voidBuyShip, voidBuySupplies, voidBuyUpgrade, voidClaimContract, voidCraftItem, voidFinishRun, voidLaunch,
    voidRefitShip, voidSalvageItem, voidUpgradeItem
} from '../server/utils/void-runner'
import { voidShip, voidUpgradeCost } from '../shared/void-runner/void'
import { voidCraftCost, voidItemUpgradeCost } from '../shared/void-runner/void-items'
import { voidPerkCost } from '../shared/void-runner/void-pilot'
import { voidContractDay, voidContractsFor, voidSupplyCost } from '../shared/void-runner/void-station'
import { seedPlayer } from './setup/players'

function pilot() {
    const id = seedPlayer('Pilot')
    ensureVoidPilot(id)
    return id
}

function row(id: string) {
    return db.select().from(voidState).where(eq(voidState.playerId, id)).get()!
}

function set(id: string, values: Partial<typeof voidState.$inferInsert>) {
    db.update(voidState).set(values).where(eq(voidState.playerId, id)).run()
}

/** Fire the same call ten times at once and count the ones that went through. */
async function burst<T>(call: () => T, n = 10) {
    const results = await Promise.allSettled(Array.from({ length: n }, async () => call()))
    return results.filter(r => r.status === 'fulfilled').length
}

/** An active run that started `minutes` ago, as a launch would leave it. */
function flying(id: string, minutes: number, cargo = 100) {
    set(id, { runStartedAt: new Date(Date.now() - minutes * 60_000), runSector: 1, runShipId: 'sparrow', runCargo: cargo })
}

describe('void runner pilot', () => {
    it('hands out the starter kit once, fitted to the Sparrow, however many first visits race', async () => {
        const id = seedPlayer()
        await burst(() => ensureVoidPilot(id))
        expect(db.select().from(voidItems).where(eq(voidItems.playerId, id)).all()).toHaveLength(6)
        const state = describeVoidPilot(id)
        expect(state.loadout.gun?.type).toBe('blaster')
        expect(state.ships.filter(s => s.owned).map(s => s.id)).toEqual(['sparrow'])
        expect(state.resources).toEqual({})
    })

    it('launches, extracts and keeps the haul across a reload', () => {
        const id = pilot()
        const launch = voidLaunch(id, 1)
        expect(launch.sector.tier).toBe(1)
        expect(row(id).runCargo).toBe(launch.stats.cargo)
        expect(() => voidLaunch(id, 1)).toThrowError(expect.objectContaining({ statusCode: 409 }))
        // Pretend the run took four minutes.
        set(id, { runStartedAt: new Date(Date.now() - 4 * 60_000) })
        const result = voidFinishRun(id, { reason: 'extracted', haul: { ferrite: 40, scrap: 12 }, elapsedMs: 4 * 60_000, kills: 6 })
        expect(result.haul).toEqual({ ferrite: 40, scrap: 12 })
        const again = describeVoidPilot(id)
        expect(again.resources).toEqual({ ferrite: 40, scrap: 12 })
        expect(again.runsPlayed).toBe(1)
        expect(again.activeRun).toBeNull()
        expect(db.select().from(voidRunHistory).where(eq(voidRunHistory.playerId, id)).all()).toHaveLength(1)
    })

    it('loses the hold on death and refuses a locked sector', () => {
        const id = pilot()
        expect(() => voidLaunch(id, 2)).toThrowError(expect.objectContaining({ statusCode: 400 }))
        voidLaunch(id, 1)
        set(id, { runStartedAt: new Date(Date.now() - 3 * 60_000) })
        voidFinishRun(id, { reason: 'destroyed', haul: { ferrite: 50 }, elapsedMs: 3 * 60_000 })
        expect(row(id).resources).toEqual({})
    })

    it('trims a forged haul to the hold snapshotted at launch', () => {
        const id = pilot()
        flying(id, 10, 100)
        const result = voidFinishRun(id, { reason: 'extracted', haul: { ferrite: 5000 }, elapsedMs: 10 * 60_000 })
        expect(result.units).toBe(110)
        expect(row(id).resources).toEqual({ ferrite: 110 })
    })
})

describe('void runner value calls under a burst', () => {
    it('banks a run exactly once when the finish is sent ten times at once', async () => {
        const id = pilot()
        flying(id, 4)
        const report = { reason: 'extracted' as const, haul: { ferrite: 50 }, elapsedMs: 4 * 60_000, kills: 3, skillUses: 5 }
        expect(await burst(() => voidFinishRun(id, report))).toBe(1)
        const s = row(id)
        expect(s.resources).toEqual({ ferrite: 50 })
        expect(s.extractions).toBe(1)
        expect(s.runStartedAt).toBeNull()
        expect(db.select().from(voidRunHistory).where(eq(voidRunHistory.playerId, id)).all()).toHaveLength(1)
    })

    it('installs one system level per payment', async () => {
        const id = pilot()
        const price = voidUpgradeCost('cargo', 0)!.resources
        set(id, { resources: price })
        expect(await burst(() => voidBuyUpgrade(id, 'cargo'))).toBe(1)
        expect(row(id).upgradeLevels).toEqual(expect.objectContaining({ cargo: 1 }))
        expect(row(id).resources).toEqual({})
    })

    it('crafts once per payment', async () => {
        const id = pilot()
        set(id, { resources: voidCraftCost('turret', 1, 'pulse').resources })
        expect(await burst(() => voidCraftItem(id, 'turret', 'pulse', 1))).toBe(1)
        expect(db.select().from(voidItems).where(eq(voidItems.playerId, id)).all()).toHaveLength(7)
    })

    it('levels an item once per payment', async () => {
        const id = pilot()
        const item = db.select().from(voidItems).where(eq(voidItems.playerId, id)).all().find(i => i.kind === 'turret')!
        set(id, { resources: voidItemUpgradeCost({ kind: 'turret', type: 'pulse', tier: 1, level: 0 })!.resources })
        expect(await burst(() => voidUpgradeItem(id, item.id))).toBe(1)
        expect(db.select().from(voidItems).where(eq(voidItems.id, item.id)).get()!.level).toBe(1)
    })

    it('refunds a salvaged item exactly once', async () => {
        const id = pilot()
        const item = db.select().from(voidItems).where(eq(voidItems.playerId, id)).all().find(i => i.kind === 'turret')!
        expect(await burst(() => voidSalvageItem(id, item.id))).toBe(1)
        expect(row(id).resources.ferrite).toBeGreaterThan(0)
        expect((row(id).loadouts.sparrow as { turrets: unknown[] }).turrets).toEqual([null])
    })

    it('builds a hull once and refits it one tier per payment', async () => {
        const id = pilot()
        const wasp = voidShip('wasp')
        set(id, { resources: wasp.cost })
        expect(await burst(() => voidBuyShip(id, 'wasp'))).toBe(1)
        expect(row(id).ownedShipIds).toEqual(['sparrow', 'wasp'])
        expect(row(id).resources).toEqual({})
        // A refit to T2 needs sector 1 cleared.
        expect(() => voidRefitShip(id, 'wasp')).toThrowError(expect.objectContaining({ statusCode: 400 }))
    })

    it('pays each daily contract once', async () => {
        const id = pilot()
        // An alloy contract pays no alloy on top, which would muddle the check below.
        const contract = voidContractsFor(id, voidContractDay(), 0).find(c => c.resource !== 'alloy')!
        set(id, { resources: { [contract.resource]: contract.amount * 10 } })
        expect(await burst(() => voidClaimContract(id, contract.index))).toBe(1)
        const s = row(id)
        expect(s.resources[contract.resource]).toBe(contract.amount * 9)
        expect(s.resources.alloy).toBe(contract.alloy)
    })

    it('never overfills or overcharges supplies', async () => {
        const id = pilot()
        const unit = voidSupplyCost('nanites', 0).resources
        set(id, { resources: Object.fromEntries(Object.entries(unit).map(([k, v]) => [k, v! * 2])) })
        expect(await burst(() => voidBuySupplies(id, 'nanites', 1))).toBe(2)
        expect(row(id).supplies).toEqual(expect.objectContaining({ nanites: 2 }))
        expect(row(id).resources).toEqual({})
    })

    it('spends Command Marks once per rank', async () => {
        const id = pilot()
        set(id, { marks: voidPerkCost('harness', 0)! })
        expect(await burst(() => voidBuyPerk(id, 'harness'))).toBe(1)
        expect(row(id).marks).toBe(0)
        expect(row(id).perks).toEqual(expect.objectContaining({ harness: 1 }))
    })
})
