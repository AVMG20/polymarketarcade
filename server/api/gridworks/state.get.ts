import { requirePlayerId } from '#server/utils/session'
import { viewPlot } from '#server/utils/gridworks/plot'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const state = viewPlot(playerId)
    return { state, playerId, now: Date.now() }
})
