import { requirePlayerId } from '#server/utils/session'
import { describeVoidPilot } from '#server/utils/void-runner'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return describeVoidPilot(playerId)
})
