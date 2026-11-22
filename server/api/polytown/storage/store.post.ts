import { requirePlayerId } from '#server/utils/session'
import { storeBuildings } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const ids = Array.isArray(body?.buildingIds) ? body.buildingIds.map((id: unknown) => String(id)) : []
    return storeBuildings(playerId, ids)
})
