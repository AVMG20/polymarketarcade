import { requirePlayerId } from '#server/utils/session'
import { voidBuyUpgrade } from '#server/utils/void-runner'
import { VOID_UPGRADE_IDS, type VoidUpgradeId } from '#shared/void-runner/void'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ upgrade?: unknown }>(event)
    const id = String(body?.upgrade) as VoidUpgradeId
    if (!VOID_UPGRADE_IDS.includes(id)) throw createError({ statusCode: 400, statusMessage: 'Invalid upgrade' })
    return voidBuyUpgrade(playerId, id)
})
