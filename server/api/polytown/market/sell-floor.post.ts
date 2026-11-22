import { requirePlayerId } from '#server/utils/session'
import { getTownCoins, sellToFloor } from '#server/utils/polytown/town'
import { broadcastTownMarket } from '#server/utils/polytown/live'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const result = sellToFloor(playerId, String(body?.resource ?? ''), Number(body?.quantity))
    if (result.filledByPlayers > 0) broadcastTownMarket(result.resource)
    return { ...result, balance: getTownCoins(playerId) }
})
