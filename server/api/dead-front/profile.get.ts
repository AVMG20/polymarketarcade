import { getDfProfile } from '#server/utils/dead-front/profile'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    return getDfProfile(await requirePlayerId(event))
})
