import { swapPirateCannons } from '#server/utils/pirate-raid'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ slotA?: unknown, slotB?: unknown }>(event)
    return swapPirateCannons(playerId, body?.slotA, body?.slotB)
})
