import { fitPirateCannon } from '#server/utils/pirate-raid'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ slotIndex?: unknown, tierId?: unknown }>(event)
    return fitPirateCannon(playerId, body?.slotIndex, body?.tierId)
})
