import { describe, expect, it } from 'vitest'
import { ARCADE_GAMES } from '#shared/games'
import { deadFrontStars, pirateStars, shapezzStars, voidStars } from '#shared/stars'

describe('arcade stars', () => {
    it('declares one star per game with a valid key', () => {
        for (const game of ARCADE_GAMES) expect(game.star.key).toMatch(/^[a-z0-9-]{1,40}$/)
    })

    it('Dead Front: three fully researched perks', () => {
        expect(deadFrontStars({ ironhide: 6, twinfire: 6, fleetfoot: 5, quickhand: 6 })).toBe(1)
        expect(deadFrontStars({ ironhide: 6, twinfire: 6, fleetfoot: 5 })).toBe(0)
        expect(deadFrontStars({})).toBe(0)
    })

    it('SHAPEZZ: checkpoint 10', () => {
        expect(shapezzStars(9)).toBe(0)
        expect(shapezzStars(10)).toBe(1)
    })

    it('Pirate Raid: a full raid at difficulty 500', () => {
        expect(pirateStars(-1)).toBe(0)
        expect(pirateStars(450)).toBe(0)
        expect(pirateStars(500)).toBe(1)
    })

    it('Void Runner: sector 2 cleared', () => {
        expect(voidStars(1)).toBe(0)
        expect(voidStars(2)).toBe(1)
    })
})
