import { requirePlayerId } from '#server/utils/session'
import { hireTownBuilder, purchaseKey } from '#server/utils/polytown/gems'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ key?: unknown }>(event)
    return hireTownBuilder(playerId, purchaseKey(body?.key))
})
