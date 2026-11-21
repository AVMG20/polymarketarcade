import { requirePlayerId } from '#server/utils/session'
import { voidClaimContract } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ index?: unknown }>(event)
    return voidClaimContract(playerId, Number(body?.index))
})
