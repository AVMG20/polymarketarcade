import { describe, expect, it } from 'vitest'
import { caught } from './db-helpers'
import { placeBuilding } from '#server/utils/polytown/town'

describe('building orientation validation', () => {
    it.each([-1, 4, 0.5, NaN, Infinity, '1', true])('rejects invalid rotation %s before touching town state', async (rotation) => {
        expect(caught(() => placeBuilding('unused', 'unused', 0, 0, 'house', rotation as number))).toMatchObject({ statusCode: 400 })
    })
})
