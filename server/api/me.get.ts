import { findPlayer } from '#server/utils/players'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return { player: findPlayer(playerId)! }
})
