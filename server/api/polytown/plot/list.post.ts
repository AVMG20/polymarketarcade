import { requirePlayerId } from '#server/utils/session'
import { listPlot } from '#server/utils/polytown/town'

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody(event)
    const price = body?.price === null || body?.price === undefined ? null : Number(body.price)
    return listPlot(playerId, String(body?.plotId ?? ''), price)
})
