import { requirePlayerId } from '#server/utils/session'
import { getTownStreak } from '#server/utils/polytown/streak'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return getTownStreak(playerId)
})
