import { requirePlayerId } from '#server/utils/session'
import { voidEquipShip } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ shipId?: unknown }>(event)
    return voidEquipShip(playerId, String(body?.shipId))
})
