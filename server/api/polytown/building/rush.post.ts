import { requirePlayerId } from '#server/utils/session'
import { syncStar } from '#server/utils/stars'
import { purchaseKey, rushBuildingWithGems } from '#server/utils/polytown/gems'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const result = await rushBuildingWithGems(playerId, String(body?.buildingId ?? ''), purchaseKey(body?.key))
    return { ...result, star: await syncStar(playerId, 'polytown') }
})
