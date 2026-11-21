import { requirePlayerId } from '#server/utils/session'
import { voidSocketMod } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ itemId?: unknown, modId?: unknown }>(event)
    return voidSocketMod(playerId, String(body?.itemId), String(body?.modId))
})
