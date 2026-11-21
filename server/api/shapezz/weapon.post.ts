import { requirePlayerId } from '#server/utils/session'
import { buyShapezzWeapon } from '#server/utils/shapezz'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ weaponType?: unknown, weaponRarity?: unknown }>(event)
    return buyShapezzWeapon(playerId, body?.weaponType, body?.weaponRarity)
})
