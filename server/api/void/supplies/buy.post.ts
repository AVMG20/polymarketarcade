import { requirePlayerId } from '#server/utils/session'
import { voidBuySupplies } from '#server/utils/void-runner'
import type { VoidSupplyId } from '#shared/void-runner/void-station'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ supplyId?: unknown, count?: unknown }>(event)
    return voidBuySupplies(playerId, String(body?.supplyId) as VoidSupplyId, body?.count === undefined ? 1 : Number(body.count))
})
