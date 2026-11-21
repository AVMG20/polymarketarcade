import { researchDfPerk } from '#server/utils/dead-front/profile'
import { isDfPerkId } from '#server/utils/dead-front/profile-rules'
import { requirePlayerId } from '#server/utils/session'

/** Spend medals on the next research level of a perk. */
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ perk?: unknown }>(event)
    if (!isDfPerkId(body?.perk)) throw createError({ statusCode: 400, statusMessage: 'Unknown perk' })
    return researchDfPerk(playerId, body.perk)
})
