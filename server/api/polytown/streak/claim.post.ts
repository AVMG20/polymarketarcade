import { requirePlayerId } from '#server/utils/session'
import { claimTownStreakStep } from '#server/utils/polytown/streak'
import { syncStar } from '#server/utils/stars'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ step?: unknown }>(event)
    const result = claimTownStreakStep(playerId, body?.step)
    // An instant finish in a chest can complete a monument stage.
    return { ...result, star: await syncStar(playerId, 'polytown') }
})
