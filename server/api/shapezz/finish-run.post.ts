import { requirePlayerId } from '#server/utils/session'
import { finishShapezzRun, parseShapezzReport } from '#server/utils/shapezz'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const report = parseShapezzReport(await readBody<Record<string, unknown>>(event))
    return finishShapezzRun(playerId, report)
})
