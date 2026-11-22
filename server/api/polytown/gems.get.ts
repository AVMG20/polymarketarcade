import { requirePlayerId } from '#server/utils/session'
import { getHubGems } from '#server/utils/polytown/gems'

/** The player's platform gems, as the hub has them, or null when it can't say. */
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return { gems: await getHubGems(playerId) }
})
