import { requirePlayerId } from '#server/utils/session'
import { demolishBuildings } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const ids = Array.isArray(body?.buildingIds) ? body.buildingIds.map((id: unknown) => String(id)) : []
    return demolishBuildings(playerId, ids)
})
