import { upgradePirateAbility } from '#server/utils/pirate-raid'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ abilityId?: unknown }>(event)
    return upgradePirateAbility(playerId, body?.abilityId)
})
