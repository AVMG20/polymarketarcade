import { sellPirateCannon } from '#server/utils/pirate-raid'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ slotIndex?: unknown }>(event)
    return sellPirateCannon(playerId, body?.slotIndex)
})
