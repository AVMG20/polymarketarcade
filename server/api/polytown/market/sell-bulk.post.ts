import { requirePlayerId } from '#server/utils/session'
import { getTownCoins, sellBulkToFloor } from '#server/utils/polytown/town'
import { broadcastTownMarket } from '#server/utils/polytown/live'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const items = Array.isArray(body?.items)
        ? (body.items as { resource?: unknown, quantity?: unknown }[]).map(i => ({ resource: String(i?.resource ?? ''), quantity: Number(i?.quantity) }))
        : []
    const result = sellBulkToFloor(playerId, items)
    for (const resource of result.resources) broadcastTownMarket(resource)
    return { ...result, balance: getTownCoins(playerId) }
})
