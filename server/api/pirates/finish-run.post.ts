import { finishPirateRun, parsePirateRunReport } from '#server/utils/pirate-raid'
import { requirePlayerId } from '#server/utils/session'
import { syncStar } from '#server/utils/stars'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const result = finishPirateRun(playerId, parsePirateRunReport(await readBody(event)))
    return { ...result, star: await syncStar(playerId, 'pirate-raid') }
})
