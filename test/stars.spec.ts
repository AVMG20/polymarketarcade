import { describe, expect, it } from 'vitest'
import { ARCADE_GAMES } from '#shared/games'
import { deadFrontStars, pirateStars, polytownStars, shapezzStars, voidStars } from '#shared/stars'

describe('arcade stars', () => {
    it('declares 1 to 10 stars per game with valid, unique keys', () => {
        for (const game of ARCADE_GAMES) {
            expect(game.stars.length).toBeGreaterThanOrEqual(1)
            expect(game.stars.length).toBeLessThanOrEqual(10)
            for (const star of game.stars) expect(star.key).toMatch(/^[a-z0-9-]{1,40}$/)
            expect(new Set(game.stars.map(s => s.key)).size).toBe(game.stars.length)
        }
    })

    it('Polytown: a level per 8 monument stages, five in all', () => {
        expect(ARCADE_GAMES.find(g => g.slug === 'polytown')?.stars).toHaveLength(5)
        expect(polytownStars(0)).toBe(0)
        expect(polytownStars(7)).toBe(0)
        expect(polytownStars(8)).toBe(1)
        expect(polytownStars(16)).toBe(2)
        expect(polytownStars(31)).toBe(3)
        expect(polytownStars(32)).toBe(4)
        expect(polytownStars(40)).toBe(5)
        expect(polytownStars(99)).toBe(5)
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
