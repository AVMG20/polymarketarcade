import { requirePlayerId } from '#server/utils/session'
import { voidSetSkillNodes } from '#server/utils/void-runner'

/** Replaces a skill's allocated nodes. Respecs are free. */
export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ skillId?: unknown, nodes?: unknown }>(event)
    return voidSetSkillNodes(playerId, String(body?.skillId), body?.nodes)
})
