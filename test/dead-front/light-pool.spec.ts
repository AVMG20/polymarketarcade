import { describe, expect, it } from 'vitest'
import { dfFlashSlot, dfHoldSlot } from '../../app/utils/dead-front/engine/light-pool'

const idle = () => ({ age: 1, life: 0, held: false })
const flashing = (left: number) => ({ age: 0, life: left, held: false })
const held = () => ({ age: 1, life: 0, held: true })

describe('dead front fx light pool', () => {
    it('flashes on an idle light, else cuts the flash closest to done, never a held one', () => {
        const a = flashing(0.5)
        const b = idle()
        expect(dfFlashSlot([a, b, held()])).toBe(b)
        const c = flashing(0.1)
        expect(dfFlashSlot([a, c, held()])).toBe(c)
        expect(dfFlashSlot([held(), held()])).toBeNull()
    })

    it('lets a projectile hold only an idle light and always leaves one for flashes', () => {
        const a = idle()
        const pool = [held(), a, idle()]
        expect(dfHoldSlot(pool)).toBe(a)
        // three bolts in flight: the third gets no light
        expect(dfHoldSlot([held(), held(), idle()])).toBeNull()
        // a running flash plays out
        expect(dfHoldSlot([flashing(0.7), flashing(0.3), held()])).toBeNull()
        const b = idle()
        expect(dfHoldSlot([flashing(0.7), b, idle()])).toBe(b)
    })
})
