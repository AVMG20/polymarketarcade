import { requirePlayerId } from '#server/utils/session'
import { getTownCoins, upgradeBuilding } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    return { ...upgradeBuilding(playerId, String(body?.buildingId ?? '')), balance: getTownCoins(playerId) }
})
