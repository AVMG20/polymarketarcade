import { requirePlayerId } from '#server/utils/session'
import { moveBuildings, type TownRelocation } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const raw = Array.isArray(body?.moves) ? body.moves : []
    const moves: TownRelocation[] = raw.map((m: Record<string, unknown>) => ({
        buildingId: String(m?.buildingId ?? ''),
        plotId: String(m?.plotId ?? ''),
        tileX: Number(m?.tileX),
        tileY: Number(m?.tileY),
        rotation: Number(m?.rotation ?? 0)
    }))
    return moveBuildings(playerId, moves)
})
