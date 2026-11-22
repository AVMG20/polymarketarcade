import { requirePlayerId } from '#server/utils/session'
import { deliverTownContract } from '#server/utils/polytown/contracts'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const contractId = body?.contractId
    if (typeof contractId !== 'string') throw createError({ statusCode: 400, statusMessage: 'Unknown contract' })
    return deliverTownContract(playerId, contractId)
})
