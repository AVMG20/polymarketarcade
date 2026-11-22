import { requirePlayerId } from '#server/utils/session'
import { buyPlotFromPlayer, getTownCoins } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    // The price the buyer was looking at when they clicked.
    const expected = body?.expectedPrice
    const result = buyPlotFromPlayer(playerId, String(body?.plotId ?? ''), typeof expected === 'number' ? expected : undefined)
    return { ...result, balance: getTownCoins(playerId) }
})
