import { requirePlayerId } from '#server/utils/session'
import { buyTownBooster, purchaseKey } from '#server/utils/polytown/gems'
import { isTownBoosterKind } from '#shared/polytown/town-boosts'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ kind?: unknown, key?: unknown }>(event)
    if (!isTownBoosterKind(body?.kind)) throw createError({ statusCode: 400, statusMessage: 'Unknown booster' })
    return buyTownBooster(playerId, body.kind, purchaseKey(body?.key))
})
