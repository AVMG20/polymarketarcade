import { requirePlayerId } from '#server/utils/session'
import { syncStar } from '#server/utils/stars'
import { voidFinishRun, type VoidFinishReport } from '#server/utils/void-runner'

const REASONS = ['extracted', 'destroyed', 'abandoned'] as const

export default defineEventHandler(async (event) => {
    const playerId = await requirePlayerId(event)
    const body = await readBody<Record<string, unknown>>(event)
    const reason = REASONS.find(r => r === body?.reason) ?? 'destroyed'
    const report: VoidFinishReport = { ...(body ?? {}), reason }
    const result = voidFinishRun(playerId, report)
    return { ...result, star: await syncStar(playerId, 'void-runner') }
})
