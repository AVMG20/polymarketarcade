import { requirePlayerId } from '#server/utils/session'
import { getTownCoins, startTownBooster } from '#server/utils/polytown/town'
import { isTownBoosterKind } from '#shared/polytown/town-boosts'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ kind?: unknown }>(event)
    if (!isTownBoosterKind(body?.kind)) throw createError({ statusCode: 400, statusMessage: 'Unknown booster' })
    return { ...startTownBooster(playerId, body.kind), balance: getTownCoins(playerId) }
})
