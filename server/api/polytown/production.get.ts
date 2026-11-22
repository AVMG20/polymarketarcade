import { requirePlayerId } from '#server/utils/session'
import { getProductionHistory } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const hours = Number(getQuery(event).hours ?? 24)
    return getProductionHistory(playerId, Number.isFinite(hours) ? hours : 24)
})
