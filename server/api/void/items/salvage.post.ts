import { requirePlayerId } from '#server/utils/session'
import { voidSalvageItem } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ itemId?: unknown }>(event)
    return voidSalvageItem(playerId, String(body?.itemId))
})
