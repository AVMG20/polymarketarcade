// Slot choice for the fx light pool (fx.ts), shared by short flashes and the
// projectiles that carry a light. Pure, so the rules are tested.

export interface DfPoolLight {
    age: number
    life: number
    /** A projectile carries it until it lands. */
    held: boolean
}

/** A flash's slot: an idle light, else the flash closest to done; never a held one. */
export function dfFlashSlot<T extends DfPoolLight>(lights: readonly T[]): T | null {
    let best: T | null = null
    let bestLeft = Infinity
    for (const l of lights) {
        if (l.held) continue
        const left = l.life - l.age
        if (left <= 0) return l
        if (left < bestLeft) {
            bestLeft = left
            best = l
        }
    }
    return best
}

/**
 * A projectile's slot: an idle light only (a running flash plays out), and never
 * the last one not held, so flashes always have a light.
 */
export function dfHoldSlot<T extends DfPoolLight>(lights: readonly T[]): T | null {
    let free = 0
    let idle: T | null = null
    for (const l of lights) {
        if (l.held) continue
        free++
        if (!idle && l.age >= l.life) idle = l
    }
    return free > 1 ? idle : null
}
