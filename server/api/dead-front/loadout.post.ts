import { withLockedDfProfile } from '#server/utils/dead-front/profile'
import { dfValidateLoadout } from '#server/utils/dead-front/profile-rules'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    // Attachments per weapon only: everyone starts with the M1911 (a sent `startWeapon` is ignored).
    const body = await readBody<{ attachments?: unknown }>(event)
    return withLockedDfProfile(playerId, (view) => {
        const next = { ...view, loadout: dfValidateLoadout(view, body?.attachments ?? {}) }
        return { next, out: next }
    })
})
