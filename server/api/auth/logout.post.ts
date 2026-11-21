import { clearArcadeSession } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    await clearArcadeSession(event)
    return { ok: true }
})
