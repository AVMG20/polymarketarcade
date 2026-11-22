import { requirePlayerId } from '#server/utils/session'
import { getTownContracts } from '#server/utils/polytown/contracts'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return getTownContracts(playerId)
})
