import { requirePlayerId } from '#server/utils/session'
import { saveRedesignDraft } from '#server/utils/polytown/town'
import { townSanitizeDraft } from '#shared/polytown/town-storage'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const draft = townSanitizeDraft(await readBody(event))
    if (!draft) throw createError({ statusCode: 400, statusMessage: 'That draft cannot be saved' })
    return saveRedesignDraft(playerId, draft)
})
