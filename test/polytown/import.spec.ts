import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db, sqlite } from '../../server/database'
import {
    players, polytownBuildings, polytownContractDays, polytownContracts, polytownEvents, polytownInventory, polytownOrders, polytownPlots,
    polytownProduction, polytownRedesignDrafts, polytownState, polytownStorage, polytownStreak, polytownTrades
} from '../../server/database/schema'
import { POLYTOWN_IMPORT_BATCH_BYTES, buildPolytownImport, timestampMs, type PolytownDump } from '../../scripts/polytown-import'
import { seedUser } from './db-helpers'

const dump = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/import-dump.json'), 'utf8')) as PolytownDump

function run(batches: string[]) {
    for (const batch of batches) sqlite.run(batch)
}

function counts() {
    return Object.fromEntries(([
        ['players', players], ['state', polytownState], ['plots', polytownPlots], ['buildings', polytownBuildings], ['storage', polytownStorage],
        ['drafts', polytownRedesignDrafts], ['inventory', polytownInventory], ['orders', polytownOrders], ['trades', polytownTrades],
        ['production', polytownProduction], ['events', polytownEvents], ['contracts', polytownContracts], ['days', polytownContractDays], ['streak', polytownStreak]
    ] as const).map(([name, table]) => [name, db.select().from(table).all().length]))
}

describe('polytown save import', () => {
    it('reads Postgres timestamps without a zone as UTC, to the millisecond', () => {
        expect(timestampMs('2026-11-20T10:00:00.123456')).toBe(Date.UTC(2026, 10, 20, 10, 0, 0, 123))
        expect(timestampMs('2026-11-20 10:00:00')).toBe(Date.UTC(2026, 10, 20, 10))
        expect(timestampMs('2026-11-20T10:00:00+01:00')).toBe(Date.UTC(2026, 10, 20, 9))
        expect(timestampMs(null)).toBeNull()
    })

    it('is deterministic and batches at most 60 KB', () => {
        const a = buildPolytownImport(dump)
        expect(buildPolytownImport(structuredClone(dump))).toEqual(a)
        for (const batch of a) expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(POLYTOWN_IMPORT_BATCH_BYTES)
        // A big dump splits into several batches.
        const big = structuredClone(dump)
        big.town_events = Array.from({ length: 2_000 }, (_, i) => ({ id: `e${String(i).padStart(5, '0')}`, user_id: 'old-ann', kind: 'built', data: { kind: 'built', type: 'house', level: 1 }, created_at: '2026-11-19T00:00:00' }))
        const batches = buildPolytownImport(big)
        expect(batches.length).toBeGreaterThan(1)
        for (const batch of batches) expect(Buffer.byteLength(batch)).toBeLessThanOrEqual(POLYTOWN_IMPORT_BATCH_BYTES)
    })

    it('imports the chosen towns once, however often it runs', async () => {
        // An arcade town already sits on Bob's old square: his plot (and what stood on it) is skipped, nothing fails.
        await seedUser('arcade-neighbour')
        db.insert(polytownPlots).values({ playerId: 'arcade-neighbour', x: 950, y: 950 }).run()

        const batches = buildPolytownImport(dump)
        run(batches)
        const first = counts()
        run(batches)
        expect(counts()).toEqual(first)

        // Players: the two imported, named from the dump, as hub players; never the outsider.
        const ann = db.select().from(players).where(eq(players.id, 'old-ann')).get()!
        expect(ann).toMatchObject({ name: 'Ann O\'Reilly', origin: 'hub' })
        expect(db.select().from(players).where(eq(players.id, 'old-cat')).get()).toBeUndefined()

        // The town: no coins, everything else as it was.
        const state = db.select().from(polytownState).where(eq(polytownState.playerId, 'old-ann')).get()!
        expect(state).toMatchObject({
            coinsCents: 0,
            happiness: 81,
            tickProgressMs: 12_000,
            plotsBought: 2,
            milestonesClaimed: ['first-home', 'first-farm'],
            coinsEarned: 150_000.5,
            produced: { wheat: 9000 },
            builders: 4,
            carry: { 'b-farm': { wheat: 0.25 } },
            monumentCredit: { pyramid: 2 },
            boosters: {}
        })
        expect(state.lastSettledAt.getTime()).toBe(Date.UTC(2026, 10, 20, 10, 0, 0, 123))
        expect(state.productionBoostUntil!.getTime()).toBe(Date.UTC(2026, 10, 19, 10))
        expect(state.buildBoostUntil).toBeNull()

        const plots = db.select().from(polytownPlots).all()
        expect(plots.filter(p => p.playerId === 'old-ann').map(p => [p.id, p.listPrice, p.paidPrice])).toEqual([
            ['plot-ann-1', null, 0],
            ['plot-ann-2', 75_000.5, 225_000]
        ])
        expect(plots.some(p => p.playerId === 'old-bob')).toBe(false)
        expect(db.select().from(polytownBuildings).all().map(b => b.id).sort()).toEqual(['b-farm', 'b-house', 'b-road'])
        const house = db.select().from(polytownBuildings).where(eq(polytownBuildings.id, 'b-house')).get()!
        expect(house).toMatchObject({ level: 2, upgradingTo: 3, rotation: 2 })

        expect(db.select().from(polytownStorage).all()).toEqual([expect.objectContaining({ id: 's-mill', playerId: 'old-ann', level: 2, upgradingTo: 3, remainingMs: 600_000 })])
        expect(db.select().from(polytownRedesignDrafts).get()!.draft).toEqual({ spots: [], roads: [], store: ['b-road'] })

        // Open orders are cancelled: sells come back to the shelf, buys' site coins are gone; no order rows.
        expect(db.select().from(polytownOrders).all()).toEqual([])
        const inv = db.select().from(polytownInventory).all().map(i => [i.playerId, i.resource, i.amount]).sort()
        expect(inv).toEqual([['old-ann', 'wheat', 570], ['old-ann', 'wood', 20], ['old-bob', 'planks', 12]])

        // Trades keep the history, without the outsider's id.
        const trades = db.select().from(polytownTrades).all()
        expect(trades.find(t => t.id === 't-cat')).toMatchObject({ buyerId: null, sellerId: 'old-ann', takerId: null, price: 40, quantity: 30 })
        expect(trades.find(t => t.id === 't-ab')).toMatchObject({ buyerId: 'old-bob', sellerId: 'old-ann', takerId: 'old-ann' })

        expect(db.select().from(polytownProduction).all()).toEqual([expect.objectContaining({ id: 'p1', resource: 'wheat', amount: 120 })])
        expect(db.select().from(polytownEvents).get()!.data).toMatchObject({ kind: 'trade', coins: 1200 })
        expect(db.select().from(polytownContracts).get()).toMatchObject({ id: 'c1', reward: 24_000, delivered: true, quantity: 400 })

        // Gems still owed become boosters worth as much: a 4-gem bonus is a rush (3) and a market day (1).
        expect(db.select().from(polytownContractDays).get()).toMatchObject({ bonus: { build: 1, market: 1 }, bonusClaimed: false })

        const streak = db.select().from(polytownStreak).get()!
        expect(streak).toMatchObject({ playerId: 'old-ann', step: 5, claimed: 7, cycle: 1, lucky: 1, lastDay: '2026-11-20' })
        expect(streak.locked['4']!.reward).toEqual({ coins: 0, resources: {}, boosters: { builder: 1 } })
        expect(streak.locked['5']!.reward).toEqual({ coins: 0, resources: { wheat: 90 } })
        expect(streak.locked['9']!.reward).toEqual({ coins: 0, resources: {}, boosters: { build: 1 } })
    })

    it('never overwrites a town that has moved on since an earlier import', () => {
        db.update(polytownState).set({ coinsCents: 12_345, happiness: 99 }).where(eq(polytownState.playerId, 'old-ann')).run()
        run(buildPolytownImport(dump))
        expect(db.select().from(polytownState).where(eq(polytownState.playerId, 'old-ann')).get()).toMatchObject({ coinsCents: 12_345, happiness: 99 })
    })
})
