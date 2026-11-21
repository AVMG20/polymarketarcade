import { describe, expect, it } from 'vitest'
import { dfMergeMatchResult, dfNormalizeProfile, dfValidateLoadout, dfValidateMods } from '#server/utils/dead-front/profile-rules'
import { dfMedalsFromMatch } from '#shared/dead-front/progression'
import type { DfProfileView } from '#shared/dead-front/types'

const fresh = (): DfProfileView => dfNormalizeProfile({
    unlockedWeapons: ['m1911'], weaponXp: {}, loadout: { startWeapon: 'm1911', attachments: {} },
    perkLevels: {}, perkMods: {}, medals: 0, medalsEarned: 0, gamesPlayed: 0, bestRound: 0, totalKills: 0, eggsCompleted: 0
})

describe('dead front profile rules', () => {
    it('normalises junk rows', () => {
        const v = dfNormalizeProfile({
            unlockedWeapons: ['bogus', 'kar98k'], weaponXp: { kar98k: 50, nope: 5 }, loadout: { startWeapon: 'lewis' },
            perkLevels: { ironhide: -3, nope: 4, twinfire: 99 }, perkMods: { ironhide: ['ironhide-deathwish'] },
            medals: -5, medalsEarned: 2.7, gamesPlayed: 1, bestRound: 3, totalKills: 9, eggsCompleted: 0
        })
        expect(v.unlockedWeapons).toEqual(['m1911', 'kar98k'])
        expect(v.weaponXp).toEqual({ kar98k: 50 })
        expect(v.loadout.startWeapon).toBe('m1911')
        expect(v.perkLevels).toEqual({ twinfire: 6 })
        expect(v.perkMods).toEqual({})
        expect(v.medals).toBe(0)
        expect(v.medalsEarned).toBe(2)
    })

    it('always starts with the M1911 and keeps attachments only for unlocked weapons', () => {
        const v = fresh()
        v.unlockedWeapons.push('kar98k')
        v.weaponXp.kar98k = 1_000_000
        const out = dfValidateLoadout(v, { kar98k: { optic: 'kar98k-scope', muzzle: 'nope' }, thompson: { optic: 'x' } })
        expect(out.startWeapon).toBe('m1911')
        expect(out.attachments.kar98k).toEqual({ optic: 'kar98k-scope' })
        expect(out.attachments.thompson).toBeUndefined()
        // a start weapon stored back when it could be chosen is ignored
        const old = dfNormalizeProfile({
            unlockedWeapons: ['m1911', 'kar98k'], weaponXp: {}, loadout: { startWeapon: 'kar98k', attachments: {} },
            perkLevels: {}, perkMods: {}, medals: 0, medalsEarned: 0, gamesPlayed: 0, bestRound: 0, totalKills: 0, eggsCompleted: 0
        })
        expect(old.loadout.startWeapon).toBe('m1911')
    })

    it('validates modifiers against research level', () => {
        expect(dfValidateMods('ironhide', ['ironhide-sandbag'], 0)).toEqual([])
        expect(dfValidateMods('ironhide', ['ironhide-sandbag', 'ironhide-sandbag', 'ironhide-quickmend', 'ironhide-bloodletter'], 6)).toEqual(['ironhide-sandbag', 'ironhide-quickmend'])
    })

    it('merges a match result', () => {
        const v = { ...fresh(), medals: 7 }
        const { next, report } = dfMergeMatchResult(v, {
            roundsSurvived: 12, kills: 150, headshots: 30, downs: 1,
            weaponKills: { m1911: 20, kar98k: 40 }, weaponsFound: ['kar98k', 'kar98k', 'm1911'], completedEasterEgg: true
        })
        expect(report.newWeapons).toEqual(['kar98k'])
        expect(next.unlockedWeapons).toEqual(['m1911', 'kar98k'])
        expect(report.medals).toBe(dfMedalsFromMatch({ roundsSurvived: 12, kills: 150, completedEasterEgg: true }))
        expect(report.medalsAfter).toBe(7 + report.medals)
        expect(next.medals).toBe(report.medalsAfter)
        expect(next.medalsEarned).toBe(report.medals)
        expect(next.weaponXp.kar98k).toBeGreaterThan(0)
        expect(next.gamesPlayed).toBe(1)
        expect(next.bestRound).toBe(12)
        expect(next.totalKills).toBe(150)
        expect(next.eggsCompleted).toBe(1)
    })
})
