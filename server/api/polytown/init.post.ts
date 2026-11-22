import { requirePlayerId } from '#server/utils/session'
import { foundTown, getTownCoins } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return { ...foundTown(playerId), balance: getTownCoins(playerId) }
})
