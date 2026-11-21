import { describe, expect, it } from 'vitest'
import { DF_EGG_MEDALS, DF_MATCH_MEDAL_CAP, DF_PERK_MAX_LEVEL, DF_RESEARCH_COSTS, dfMedalsFromMatch, dfResearchCost } from '#shared/dead-front/progression'
import type { DfMatchResult } from '#shared/dead-front/types'

const match = (rounds: number, kills: number, egg = false): DfMatchResult => ({
    roundsSurvived: rounds, kills, headshots: 0, downs: 0, weaponKills: {}, weaponsFound: [], completedEasterEgg: egg
})

describe('dead front medals', () => {
    it('pays nothing for a match quit before the first round ends', () => {
        expect(dfMedalsFromMatch(match(0, 0))).toBe(0)
        expect(dfMedalsFromMatch(match(0, 30))).toBe(0)
    })

    it('pays more per round the deeper the squad gets', () => {
        const gain = (r: number) => dfMedalsFromMatch(match(r, 0)) - dfMedalsFromMatch(match(r - 1, 0))
        expect(gain(20)).toBeGreaterThan(gain(3))
        for (let r = 1; r < 40; r++) expect(dfMedalsFromMatch(match(r + 1, 0))).toBeGreaterThanOrEqual(dfMedalsFromMatch(match(r, 0)))
    })

    it('adds kills and the easter egg, ignores junk and caps a match', () => {
        expect(dfMedalsFromMatch(match(10, 100, true))).toBe(dfMedalsFromMatch(match(10, 100)) + DF_EGG_MEDALS)
        expect(dfMedalsFromMatch(match(-5, Number.NaN))).toBe(0)
        expect(dfMedalsFromMatch(match(1e9, 1e9, true))).toBe(DF_MATCH_MEDAL_CAP)
        expect(Number.isInteger(dfMedalsFromMatch(match(7.9, 33.3)))).toBe(true)
    })

    it('prices each research level higher than the last, and nothing past the top', () => {
        expect(DF_RESEARCH_COSTS).toHaveLength(DF_PERK_MAX_LEVEL)
        for (let l = 1; l < DF_PERK_MAX_LEVEL; l++) expect(dfResearchCost(l)!).toBeGreaterThan(dfResearchCost(l - 1)!)
        expect(dfResearchCost(DF_PERK_MAX_LEVEL)).toBeNull()
        expect(dfResearchCost(-1)).toBeNull()
    })
})
