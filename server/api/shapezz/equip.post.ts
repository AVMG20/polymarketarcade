import { requirePlayerId } from '#server/utils/session'
import { equipShapezzWeapon } from '#server/utils/shapezz'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ weaponType?: unknown }>(event)
    return equipShapezzWeapon(playerId, body?.weaponType)
})
