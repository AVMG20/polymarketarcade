import { requirePlayerId } from '#server/utils/session'
import { placeBuilding } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return placeBuilding(playerId, String(body?.plotId ?? ''), Number(body?.tileX), Number(body?.tileY), String(body?.type ?? ''), Number(body?.rotation ?? 0))
})
