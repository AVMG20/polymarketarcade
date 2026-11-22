import { requirePlayerId } from '#server/utils/session'
import { getTownCoins, sellPlotToSystem } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return { ...sellPlotToSystem(playerId, String(body?.plotId ?? '')), balance: getTownCoins(playerId) }
})
