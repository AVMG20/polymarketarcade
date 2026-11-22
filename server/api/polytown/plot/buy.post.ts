import { requirePlayerId } from '#server/utils/session'
import { buyPlot, getTownCoins } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return { ...buyPlot(playerId, Number(body?.x), Number(body?.y)), balance: getTownCoins(playerId) }
})
