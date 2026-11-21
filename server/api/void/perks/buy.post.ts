import { requirePlayerId } from '#server/utils/session'
import { voidBuyPerk } from '#server/utils/void-runner'
import type { VoidPerkId } from '#shared/void-runner/void-pilot'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ perkId?: unknown }>(event)
    return voidBuyPerk(playerId, String(body?.perkId) as VoidPerkId)
})
