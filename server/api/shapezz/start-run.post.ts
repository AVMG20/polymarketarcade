import { requirePlayerId } from '#server/utils/session'
import { startShapezzRun } from '#server/utils/shapezz'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ difficultyId?: unknown }>(event)
    return startShapezzRun(playerId, body?.difficultyId)
})
