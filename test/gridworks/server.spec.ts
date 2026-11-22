import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '#server/database/index'
import { gridworksPlot, players } from '#server/database/schema'
import { upsertPlayer } from '#server/utils/players'
import { clearWorldCache, ensurePlot, readPlot, viewPlot, withPlot, worldPlots } from '#server/utils/gridworks/plot'
import { GRIDWORKS_MAX_PEERS_PER_PLAYER, registerGridworksPeer, unregisterGridworksPeer, type GridworksPeer } from '#server/utils/gridworks/live'
import { applyOp } from '#shared/gridworks/game'
import { GRIDWORKS_STAR_GOAL, gridworksStars } from '#shared/stars'

const created: string[] = []

function makePlayer(suffix: string) {
    const id = `gw-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    upsertPlayer({ sub: id, name: `Player ${suffix}`, image: null, title: null }, 'dev')
    created.push(id)
    return id
}

afterEach(() => {
    for (const id of created.splice(0)) {
        db.delete(players).where(eq(players.id, id)).run()
    }
    clearWorldCache()
})

describe('gridworks server plot persistence', () => {
    it('creates one plot per player safely under repeated ensurePlot calls', () => {
        const id = makePlayer('ensure')
        ensurePlot(id)
        const first = readPlot(id)
        expect(first).not.toBeNull()
        ensurePlot(id)
        const second = readPlot(id)
        expect(second?.seed).toBe(first?.seed)
    })

    it('applies ops atomically inside writeTx and prevents double-claiming a goal', () => {
        const id = makePlayer('goal')
        withPlot(id, (s) => {
            s.mined = 10
        })
        const first = withPlot(id, (s, now) => applyOp(s, { op: 'goal', id: 'hand-mine' }, now, null, id))
        const second = withPlot(id, (s, now) => applyOp(s, { op: 'goal', id: 'hand-mine' }, now, null, id))
        expect(first.result).toBeNull()
        expect(second.result).toBe('missing')
        const saved = viewPlot(id)
        expect(saved.goals).toEqual(['hand-mine'])
    })

    it('awards the star once the Motors goal is claimed', () => {
        const id = makePlayer('star')
        ensurePlot(id)
        const row0 = db.select({ goals: gridworksPlot.goals }).from(gridworksPlot).where(eq(gridworksPlot.playerId, id)).get()
        expect(gridworksStars(row0!.goals)).toBe(0)
        withPlot(id, (s) => {
            s.goals.push(GRIDWORKS_STAR_GOAL)
        })
        const row1 = db.select({ goals: gridworksPlot.goals }).from(gridworksPlot).where(eq(gridworksPlot.playerId, id)).get()
        expect(gridworksStars(row1!.goals)).toBe(1)
    })

    it('lists plots in worldPlots and invalidates cache on clearWorldCache', () => {
        const id = makePlayer('world')
        ensurePlot(id)
        clearWorldCache()
        const plots = worldPlots()
        expect(plots.some(p => p.playerId === id)).toBe(true)
    })

    it('caps live peers per player and cleans up on unregister', () => {
        const id = makePlayer('ws')
        const peers: GridworksPeer[] = []
        for (let i = 0; i < GRIDWORKS_MAX_PEERS_PER_PLAYER; i++) {
            const p: GridworksPeer = { send: () => {} }
            expect(registerGridworksPeer(p, id)).toBe(true)
            peers.push(p)
        }
        const extra: GridworksPeer = { send: () => {} }
        expect(registerGridworksPeer(extra, id)).toBe(false)
        for (const p of peers) unregisterGridworksPeer(p)
        expect(registerGridworksPeer(extra, id)).toBe(true)
        unregisterGridworksPeer(extra)
    })
})
