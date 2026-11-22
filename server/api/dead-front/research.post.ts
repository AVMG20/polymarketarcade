import { researchDfPerk } from '#server/utils/dead-front/profile'
import { isDfPerkId } from '#server/utils/dead-front/profile-rules'
import { requirePlayerId } from '#server/utils/session'
import { syncStar } from '#server/utils/stars'

/** Spend medals on the next research level of a perk. */
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ perk?: unknown }>(event)
    if (!isDfPerkId(body?.perk)) throw createError({ statusCode: 400, statusMessage: 'Unknown perk' })
    const profile = researchDfPerk(playerId, body.perk)
    return { ...profile, star: await syncStar(playerId, 'dead-front') }
})
