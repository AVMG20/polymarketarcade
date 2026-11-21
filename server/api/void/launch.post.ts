import { requirePlayerId } from '#server/utils/session'
import { voidLaunch } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<{ sector?: unknown, force?: unknown }>(event)
    return voidLaunch(playerId, Number(body?.sector), body?.force === true)
})
