import { requirePlayerId } from '#server/utils/session'
import { moveBuilding } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return moveBuilding(playerId, String(body?.buildingId ?? ''), String(body?.plotId ?? ''), Number(body?.tileX), Number(body?.tileY), Number(body?.rotation ?? 0))
})
