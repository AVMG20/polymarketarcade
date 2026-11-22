import { requirePlayerId } from '#server/utils/session'
import { worldPlots } from '#server/utils/gridworks/plot'

export default defineEventHandler(async (event) => {
    await requirePlayerId(event)
    return { plots: worldPlots() }
})
