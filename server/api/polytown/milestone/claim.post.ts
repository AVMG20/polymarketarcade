import { requirePlayerId } from '#server/utils/session'
import { claimMilestone, getTownCoins } from '#server/utils/polytown/town'
import { syncStar } from '#server/utils/stars'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const result = claimMilestone(playerId, String(body?.id ?? ''))
    return { ...result, balance: getTownCoins(playerId), star: await syncStar(playerId, 'polytown') }
})
