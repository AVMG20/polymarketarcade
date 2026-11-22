import { requirePlayerId } from '#server/utils/session'
import { claimTownContractBonus } from '#server/utils/polytown/contracts'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return claimTownContractBonus(playerId)
})
