import { requirePlayerId } from '#server/utils/session'
import { cancelTownOrder, getTownCoins } from '#server/utils/polytown/town'
import { broadcastTownMarket } from '#server/utils/polytown/live'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const result = cancelTownOrder(playerId, String(body?.orderId ?? ''))
    broadcastTownMarket(result.resource)
    return { ...result, balance: getTownCoins(playerId) }
})
