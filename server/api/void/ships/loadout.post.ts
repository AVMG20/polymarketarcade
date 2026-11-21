import { requirePlayerId } from '#server/utils/session'
import { voidSetFit } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ shipId?: unknown, fit?: unknown }>(event)
    return voidSetFit(playerId, String(body?.shipId), body?.fit)
})
