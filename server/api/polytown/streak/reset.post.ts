import { requirePlayerId } from '#server/utils/session'
import { resetTownStreak } from '#server/utils/polytown/streak'
import { syncStar } from '#server/utils/stars'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const result = resetTownStreak(playerId)
    return { ...result, star: await syncStar(playerId, 'polytown') }
})
