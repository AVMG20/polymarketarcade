import { requirePlayerId } from '#server/utils/session'
import { voidRefitShip } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ shipId?: unknown }>(event)
    return voidRefitShip(playerId, String(body?.shipId))
})
