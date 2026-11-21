import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../server/database'
import { deadFrontProfiles } from '../../server/database/schema'
import { applyDfMatchResult, getDfProfile, researchDfPerk, withLockedDfProfile } from '#server/utils/dead-front/profile'
import { DF_RESEARCH_COSTS, dfMedalsFromMatch } from '#shared/dead-front/progression'
import type { DfMatchResult } from '#shared/dead-front/types'
import { seedPlayer } from '../setup/players'

const result: DfMatchResult = {
    roundsSurvived: 8, kills: 60, headshots: 10, downs: 1,
    weaponKills: { m1911: 10 }, weaponsFound: ['mp18'], completedEasterEgg: false
}

function giveMedals(playerId: string, medals: number) {
    getDfProfile(playerId)
    db.update(deadFrontProfiles).set({ medals }).where(eq(deadFrontProfiles.playerId, playerId)).run()
}

describe('dead front profile (db)', () => {
    it('creates the row with defaults on first read and keeps it across reads', () => {
        const id = seedPlayer()
        const first = getDfProfile(id)
        expect(first).toMatchObject({ unlockedWeapons: ['m1911'], medals: 0, perkLevels: {}, gamesPlayed: 0 })
        withLockedDfProfile(id, view => ({ next: { ...view, loadout: { startWeapon: 'm1911', attachments: {} }, gamesPlayed: 3 }, out: null }))
        expect(getDfProfile(id).gamesPlayed).toBe(3)
    })

    it('applies a match result once per match and player, even in parallel', async () => {
        const id = seedPlayer()
        const reports = await Promise.all(Array.from({ length: 5 }, async () => applyDfMatchResult(id, 'match-a', result)))
        expect(reports.filter(Boolean)).toHaveLength(1)
        const after = getDfProfile(id)
        expect(after.gamesPlayed).toBe(1)
        expect(after.totalKills).toBe(60)
        expect(after.medals).toBe(dfMedalsFromMatch(result))
        expect(after.unlockedWeapons).toContain('mp18')
        expect(after.weaponXp.m1911).toBeGreaterThan(0)
        // another match counts again
        expect(applyDfMatchResult(id, 'match-b', result)).not.toBeNull()
        expect(getDfProfile(id).medals).toBe(dfMedalsFromMatch(result) * 2)
    })

    it('researches a level for its price and refuses what can\'t be afforded', () => {
        const id = seedPlayer()
        expect(() => researchDfPerk(id, 'ironhide')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        giveMedals(id, DF_RESEARCH_COSTS[0]! + DF_RESEARCH_COSTS[1]! + 3)
        expect(researchDfPerk(id, 'ironhide')).toMatchObject({ perkLevels: { ironhide: 1 }, medals: DF_RESEARCH_COSTS[1]! + 3 })
        expect(researchDfPerk(id, 'ironhide')).toMatchObject({ perkLevels: { ironhide: 2 }, medals: 3 })
        expect(() => researchDfPerk(id, 'ironhide')).toThrowError(expect.objectContaining({ statusCode: 400 }))
        expect(getDfProfile(id)).toMatchObject({ perkLevels: { ironhide: 2 }, medals: 3 })
    })

    it('lets only one of two parallel buys through when the medals cover one', async () => {
        const id = seedPlayer()
        giveMedals(id, DF_RESEARCH_COSTS[0]! + 5)
        const results = await Promise.allSettled([0, 1].map(async () => researchDfPerk(id, 'steadyeye')))
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
        expect(getDfProfile(id)).toMatchObject({ perkLevels: { steadyeye: 1 }, medals: 5 })
    })

    it('refuses research past the top level', () => {
        const id = seedPlayer()
        giveMedals(id, 1_000_000)
        for (let i = 0; i < DF_RESEARCH_COSTS.length; i++) researchDfPerk(id, 'fleetfoot')
        expect(() => researchDfPerk(id, 'fleetfoot')).toThrowError(expect.objectContaining({ statusMessage: 'Fully researched' }))
        expect(getDfProfile(id).perkLevels.fleetfoot).toBe(6)
    })
})
