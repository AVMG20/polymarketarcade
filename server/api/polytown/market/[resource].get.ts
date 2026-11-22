import { requirePlayerId } from '#server/utils/session'
import { getTownMarket } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const resource = getRouterParam(event, 'resource') ?? ''
    return getTownMarket(resource, playerId)
})
