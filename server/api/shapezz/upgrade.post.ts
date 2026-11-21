import { requirePlayerId } from '#server/utils/session'
import { buyShapezzUpgrade } from '#server/utils/shapezz'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ upgradeId?: unknown }>(event)
    return buyShapezzUpgrade(playerId, body?.upgradeId)
})
