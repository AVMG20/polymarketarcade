import { requirePlayerId } from '#server/utils/session'
import { finishShapezzRun, parseShapezzReport } from '#server/utils/shapezz'
import { syncStar } from '#server/utils/stars'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const report = parseShapezzReport(await readBody<Record<string, unknown>>(event))
    const result = finishShapezzRun(playerId, report)
    return { ...result, star: await syncStar(playerId, 'shapezz') }
})
