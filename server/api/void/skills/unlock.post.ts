import { requirePlayerId } from '#server/utils/session'
import { voidUnlockSkill } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ skillId?: unknown }>(event)
    return voidUnlockSkill(playerId, String(body?.skillId))
})
