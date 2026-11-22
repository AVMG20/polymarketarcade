import { requirePlayerId } from '#server/utils/session'
import { demolishBuilding } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return demolishBuilding(playerId, String(body?.buildingId ?? ''))
})
