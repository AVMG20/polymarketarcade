import { requirePlayerId } from '#server/utils/session'
import { getTownCoins, placeTownOrder } from '#server/utils/polytown/town'
import { broadcastTownMarket } from '#server/utils/polytown/live'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const side = body?.side === 'buy' ? 'buy' as const : body?.side === 'sell' ? 'sell' as const : null
    if (!side) throw createError({ statusCode: 400, statusMessage: 'Choose buy or sell' })
    const result = placeTownOrder(playerId, String(body?.resource ?? ''), side, Number(body?.price), Number(body?.quantity))
    broadcastTownMarket(result.resource)
    return { ...result, balance: getTownCoins(playerId) }
})
