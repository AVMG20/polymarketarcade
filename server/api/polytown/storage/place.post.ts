import { requirePlayerId } from '#server/utils/session'
import { placeStoredBuilding } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return placeStoredBuilding(playerId, {
        buildingId: String(body?.buildingId ?? ''),
        plotId: String(body?.plotId ?? ''),
        tileX: Number(body?.tileX),
        tileY: Number(body?.tileY),
        rotation: Number(body?.rotation ?? 0)
    })
})
