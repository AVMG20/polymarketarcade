import { finishPirateRun, parsePirateRunReport } from '#server/utils/pirate-raid'
import { requirePlayerId } from '#server/utils/session'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    return finishPirateRun(playerId, parsePirateRunReport(await readBody(event)))
})
