import { requirePlayerId } from '#server/utils/session'
import { discardRedesignDraft } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return discardRedesignDraft(playerId)
})
